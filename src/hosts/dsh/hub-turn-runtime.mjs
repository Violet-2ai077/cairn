import { createHash, randomUUID } from 'node:crypto';
import { buildAntiRecencyContract, buildHubTaskCatalog, buildScopedAuthorityContract, parseTaskMarker, projectReadOnlyLedger } from '../../kernel/index.mjs';
import { finishHubScopedTurn, readHubTasksIndex, readProjectsIndex, readScopedHead, readSessionBinding } from '../../kernel/hub-store.mjs';
import { selectHubTaskPools } from '../../kernel/task-heat.mjs';
import { runHubColdRouter } from '../../workers/hub-cold-router.mjs';
import { compileHubTaskCheckout } from '../../workers/hub-task-checkout.mjs';
import { resolveGitProjectHint } from './git-project.mjs';

const SWITCH = /^(?:(?:please\s+)?(?:switch\s+(?:to|topics?)|change\s+(?:topics?|tasks?)|(?:start\s+(?:a\s+)?)?new\s+(?:topic|task))\b|(?:请\s*)?(?:切换|切到|换个话题|另开|新任务|新话题))/iu;
const EXACT = /(?:\btask\s*#?\s*|任务\s*#?\s*|<\|task:)([1-9]\d{0,2})(?!\d)/giu;
const EXACT_START = /^(?:(?:please\s+)?(?:continue|resume|revisit|switch to|open|work on)\s+|(?:请\s*)?(?:继续|恢复|切到|切换到|回到|打开)\s*)?(?:task\s*#?\s*|任务\s*#?\s*|<\|task:)[1-9]\d{0,2}(?!\d)/iu;
const clarification = 'Cairn 未确认本轮作用域，请澄清目标。旧作用域不适用于本轮；输出 <|task:UNRESOLVED|>，不要新建或续写任务。';

const textOf = msg => typeof msg?.content === 'string' ? msg.content
  : (Array.isArray(msg?.content) ? msg.content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '');
const scopeKey = (sessionId, turn) => createHash('sha256').update(JSON.stringify([sessionId, turn])).digest('hex');

export function resolveMidSessionPolicy(autopilot) {
  const options = autopilot?.midSessionSwitch;
  return {
    enabled: autopilot?.enabled === true && options?.enabled !== false,
    crossProject: options?.crossProject === true,
    routeTimeoutMs: Number.isSafeInteger(options?.routeTimeoutMs) && options.routeTimeoutMs > 0 ? options.routeTimeoutMs : 2500
  };
}

export function createHubTurnRuntime({ hubRoot, policy, taskHeat, clientFor, maxTailChars, stripReminders, onArchive }) {
  const sessions = new Map();
  const turns = new Map();
  function stateFor(id) {
    if (!sessions.has(id)) sessions.set(id, {
      selectedProjectId: null, selectedTaskId: null, bindingEpoch: null, bindingSource: null, explicitPin: false,
      pendingSwitch: null, lastProcessedTurnKey: null, snapshot: null, presentedSnapshot: null, route: null
    });
    return sessions.get(id);
  }
  function syncBinding(id, binding = readSessionBinding(hubRoot, id, { includeCleared: true })) {
    const state = stateFor(id);
    const epoch = binding?.binding_epoch ?? null;
    if (state.bindingEpoch !== epoch) {
      state.snapshot = null;
      state.presentedSnapshot = null;
    }
    Object.assign(state, {
      selectedProjectId: binding?.project_id ?? null, selectedTaskId: binding?.task_id ?? null, bindingEpoch: epoch,
      bindingSource: binding?.source ?? null, explicitPin: binding?.explicit_pin === true
    });
    return state;
  }
  function begin(id, turn) {
    const entry = { turn, turnKey: scopeKey(id, turn), scope: null, step: 0, signal: null, pending: null, input: '', authored: '', terminal: null, streamMarkers: new Map() };
    turns.set(id, entry);
    return entry;
  }
  function makeSnapshot(state, target, ticket, hot, projects) {
    const user = readScopedHead(hubRoot);
    const project = target.projectId ? readScopedHead(hubRoot, { scope: 'project', projectId: target.projectId }) : null;
    const cached = state.snapshot?.bindingEpoch === target.bindingEpoch ? state.snapshot : null;
    if (cached && cached.userRevision === user.revision && cached.projectRevision === (project?.revision ?? null)) return cached;
    const checkout = cached ? cached.checkout : (target.taskId
      ? compileHubTaskCheckout({ hubRoot, taskId: target.taskId, maxTailChars })
      : null);
    const chosen = target.taskId ?? ticket?.taskId;
    const catalog = cached?.catalog ?? buildHubTaskCatalog(hot.map(task => ({ ...task, project_name: projects.get(task.project_id) })));
    const text = [
      `### Cairn current scope\nEarlier Cairn Project Ledgers and Task Checkouts do not apply to this turn. Project: ${target.projectId ?? 'general'}.\nRequired tail marker for this request: <|task:${chosen}|>.`,
      buildScopedAuthorityContract({ userLedgerSnapshot: projectReadOnlyLedger(user), projectLedgerSnapshot: project ? projectReadOnlyLedger(project) : null, projectName: projects.get(target.projectId), includeProject: Boolean(project) }),
      checkout?.ok ? `<cairn_task_checkout task_id="${target.taskId}" project_id="${target.projectId ?? 'general'}">\n${checkout.text}\n</cairn_task_checkout>` : '',
      catalog
    ].filter(Boolean).join('\n\n');
    return Object.freeze({
      bindingEpoch: target.bindingEpoch, userRevision: user.revision, projectRevision: project?.revision ?? null,
      checkout: checkout ? Object.freeze(checkout) : null,
      catalog,
      text
    });
  }
  async function plan(sessionId, entry, payload, cwd) {
    const state = syncBinding(sessionId);
    const expectedEpoch = state.bindingEpoch;
    const modelSelection = payload.modelSelection?.provider && payload.modelSelection?.model
      ? Object.freeze({ provider: payload.modelSelection.provider, model: payload.modelSelection.model, sessionId }) : null;
    const scoped = (route, fields = {}) => Object.freeze({
      turnKey: entry.turnKey, projectId: null, taskId: null, bindingEpoch: expectedEpoch, expectedEpoch,
      modelSelection, snapshot: Object.freeze({ text: clarification }), newTaskTicket: null, route: Object.freeze(route), ...fields
    });
    const deny = reason => scoped({ result: 'clarify', reason });
    const started = Date.now();
    const index = readHubTasksIndex(hubRoot);
    const tasks = index.tasks;
    const { hot, dormant } = selectHubTaskPools(tasks, { policy: taskHeat });
    const projects = new Map(readProjectsIndex(hubRoot).projects.map(item => [item.project_id, item.name]));
    const bound = tasks.find(task => task.id === state.selectedTaskId && task.status === 'active' && task.project_id === state.selectedProjectId);
    const recovery = tasks.find(task => task.creation_turn_key === entry.turnKey && task.status === 'active');
    const ids = new Set([...entry.input.matchAll(EXACT)].map(m => Number(m[1])));
    const explicit = EXACT_START.test(entry.input) || SWITCH.test(entry.input);
    let result;
    const hint = bound ? null : resolveGitProjectHint(cwd);
    const projectMention = /\bproject:([a-z0-9_-]+)\b/iu.exec(entry.input)?.[1];
    if (recovery) {
      result = { decision: 'new', task_id: null };
    } else if (explicit && ids.size === 1) {
      const task = tasks.find(item => item.id === [...ids][0] && item.status === 'active');
      if (!task) return deny('explicit_task_unavailable');
      result = { decision: 'match', task_id: task.id, project_id: task.project_id, pool: dormant.some(item => item.id === task.id) ? 'dormant' : 'hot' };
    } else if (bound && !explicit) {
      result = { decision: 'keep', task_id: bound.id, project_id: bound.project_id };
    } else {
      if (state.explicitPin && !explicit) return deny('pinned_task_unavailable');
      result = await runHubColdRouter({
        hubRoot, userPrompt: entry.input, taskHeat, timeoutMs: policy.routeTimeoutMs, signal: payload.signal,
        cwdProjectHint: bound ? null : hint?.project_id ?? null, llmClient: clientFor(modelSelection)
      });
    }
    if (payload.signal?.aborted || turns.get(sessionId) !== entry) return deny('aborted');
    if (!['match', 'keep', 'new'].includes(result.decision)) return deny(result.decision === 'ambiguous' ? 'ambiguous' : 'route_error');
    if (syncBinding(sessionId).bindingEpoch !== expectedEpoch) return deny('epoch_conflict');
    if (projectMention && explicit && !projects.has(projectMention)) return deny('unknown_project');
    const projectId = recovery ? recovery.project_id : result.decision === 'new'
      ? (explicit ? projectMention : null) ?? (bound ? bound.project_id : hint?.project_id ?? null)
      : result.project_id ?? null;
    if (projectMention && explicit && projectMention !== projectId) return deny('project_mismatch');
    if (bound && bound.project_id !== projectId && !policy.crossProject) return deny('cross_project_disabled');
    const taskId = result.task_id ?? null;
    if (taskId && !readHubTasksIndex(hubRoot).tasks.some(task => task.id === taskId && task.project_id === projectId && task.status === 'active')) return deny('task_invalidated');
    const allocate = result.decision === 'new';
    const nextId = recovery?.id ?? readHubTasksIndex(hubRoot).next_task_id;
    if (allocate && (nextId < 1 || nextId > 999)) return deny('task_ids_exhausted');
    const ticket = allocate ? Object.freeze({ taskId: nextId, turnKey: entry.turnKey }) : null;
    const same = !allocate && taskId === bound?.id && projectId === bound.project_id;
    const target = { projectId, taskId, bindingEpoch: same ? expectedEpoch : randomUUID() };
    const snapshot = makeSnapshot(state, target, ticket, hot, projects);
    return scoped({ result: result.decision, pool: result.pool ?? null, elapsed_ms: Date.now() - started }, {
      ...target, snapshot, newTaskTicket: ticket, explicitPin: same && state.explicitPin,
      bindingSource: same ? state.bindingSource : allocate ? 'new_task_ticket' : result.pool === 'dormant' ? 'dormant_wake' : explicit ? 'explicit_switch' : 'cold_router_match',
      projectHint: hint && hint.project_id === projectId ? Object.freeze({ ...hint }) : null
    });
  }
  async function preStep(sessionId, payload, cwd) {
    const turn = payload.turn;
    if (!Number.isSafeInteger(turn)) return;
    const entry = turns.get(sessionId)?.turn === turn ? turns.get(sessionId) : begin(sessionId, turn);
    entry.step = payload.step ?? 1;
    entry.signal = payload.signal;
    if (!entry.pending && !entry.scope) {
      if (entry.step !== 1) return;
      const input = (payload.messages ?? []).filter(msg => msg.source?.kind === 'user').map(msg => stripReminders(textOf(msg))).filter(Boolean).join('\n\n');
      if (!input) return;
      entry.input = input;
      const state = stateFor(sessionId);
      if (state.lastProcessedTurnKey === entry.turnKey) return;
      state.pendingSwitch = null;
      entry.pending = plan(sessionId, entry, payload, cwd).catch(() => Object.freeze({
        turnKey: entry.turnKey, snapshot: Object.freeze({ text: clarification }), route: Object.freeze({ result: 'clarify', reason: 'scope_unavailable' })
      }));
    }
    if (entry.pending && !entry.scope) {
      const scope = await entry.pending;
      if (turns.get(sessionId) === entry && !payload.signal?.aborted) {
        entry.scope = scope;
        stateFor(sessionId).route = scope.route;
      }
    }
  }
  function event(sessionId, event) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      if (turns.get(sessionId)?.turn !== data.turn) begin(sessionId, data.turn);
      return;
    }
    const entry = turns.get(sessionId);
    if (!entry || (data.turn != null && data.turn !== entry.turn)) return;
    const msg = data.message ?? data;
    if (event.type === 'user/message' && msg.source?.kind === 'user' && event.surfaceOp === 'append') {
      const authored = stripReminders(textOf(msg));
      if (authored) entry.authored = [entry.authored, authored].filter(Boolean).join('\n\n');
    }
    if (event.type === 'assistant/message' && event.surfaceOp === 'append' && !data.interrupted && data.step === entry.step) {
      if (Array.isArray(msg.content) && msg.content.some(block => block?.type === 'tool-call')) {
        entry.terminal = null;
      } else {
        const text = textOf(msg).trim();
        const hidden = entry.streamMarkers.get(entry.step);
        entry.terminal = { step: entry.step, marker: hidden?.display_text === text ? hidden : parseTaskMarker(text) };
      }
    }
    if (event.type !== 'turn/end') return;
    turns.delete(sessionId);
    const state = stateFor(sessionId);
    const scope = entry.scope;
    const user = entry.authored || entry.input;
    if (!scope || !user || data.reason?.kind !== 'completed' || entry.signal?.aborted || scope.route.result === 'clarify' ||
        state.lastProcessedTurnKey === scope.turnKey || entry.terminal?.step !== entry.step) return;
    const marker = entry.terminal.marker;
    if (!marker.valid || marker.is_unresolved) return;
    if (marker.task_number !== (scope.taskId ?? scope.newTaskTicket?.taskId)) {
      state.pendingSwitch = Object.freeze({ taskId: marker.task_number, turn: entry.turn });
      return;
    }
    const result = finishHubScopedTurn(hubRoot, { sessionId, turn: entry.turn, scope, user, assistant: marker.answer });
    if (result.status !== 'archived') return;
    syncBinding(sessionId, result.binding);
    state.lastProcessedTurnKey = scope.turnKey;
    state.snapshot = scope.snapshot;
    state.presentedSnapshot = scope.snapshot;
    if (result.appended) onArchive({ sessionId, turn: entry.turn, scope, taskId: result.taskId, user, assistant: marker.answer });
  }
  function context(id) {
    const scope = turns.get(id)?.scope;
    if (scope?.taskId && !readHubTasksIndex(hubRoot).tasks.some(task =>
      task.id === scope.taskId && task.project_id === scope.projectId && task.status === 'active')) return clarification;
    return scope?.snapshot.text ?? sessions.get(id)?.presentedSnapshot?.text ?? '';
  }
  return { sessions, turns, syncBinding, preStep, event, context };
}

export const HUB_TURN_CONTRACT = buildAntiRecencyContract();

export async function* hideHubStreamMarker(stream, entry) {
  const step = entry.step;
  entry.streamMarkers.delete(step);
  const blocks = new Map();
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      const block = blocks.get(chunk.index) ?? { raw: '', sent: 0 };
      block.raw += chunk.text;
      blocks.set(chunk.index, block);
      const end = Math.max(block.sent, block.raw.length - 64);
      if (end > block.sent) yield { ...chunk, text: block.raw.slice(block.sent, end) };
      block.sent = end;
      continue;
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const block = blocks.get(chunk.index);
      const raw = chunk.block.text;
      const marker = parseTaskMarker(raw);
      const text = marker.valid ? marker.display_text : raw;
      if (marker.valid && marker.display_text.length >= (block?.sent ?? 0)) entry.streamMarkers.set(step, marker);
      else entry.streamMarkers.delete(step);
      const remainder = text.slice(block?.sent ?? 0);
      if (remainder) yield { type: 'text-delta', index: chunk.index, text: remainder };
      blocks.delete(chunk.index);
      yield { ...chunk, block: { ...chunk.block, text } };
      continue;
    }
    yield chunk;
  }
}
