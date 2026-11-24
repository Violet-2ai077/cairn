import { createHash, randomUUID } from 'node:crypto';
import { buildAntiRecencyContract, buildHubTaskCatalog, parseTaskMarker } from '../../kernel/index.mjs';
import { checkpointToolResult, finishHubScopedTurn, readHubTasksIndex, readProjectsIndex, readSessionBinding, readSessionChoice, recordTurnReceipt, replaceSessionChoice, turnSourceDigest } from '../../kernel/hub-store.mjs';
import { textOf, collectToolEvidence, resumeUserText } from './turn-journal.mjs';
import { selectHubTaskPools } from '../../kernel/task-heat.mjs';
import { mentionsCompetingTopic, runHubColdRouter } from '../../workers/hub-cold-router.mjs';
import { compileHubTaskCheckout } from '../../workers/hub-task-checkout.mjs';
import { readHandoffInputs, renderHandoffAuthority, renderHandoffObservations, renderFileWrites } from '../../workers/hub-handoff.mjs';
import { resolveGitProjectHint } from './git-project.mjs';
import { genericResume, pickTask, resumeIntent } from './task-picker.mjs';

const SWITCH = /^(?:(?:please\s+)?(?:switch\s+(?:to|topics?)|change\s+(?:topics?|tasks?)|(?:start\s+(?:a\s+)?)?new\s+(?:topic|task))\b|(?:请\s*)?(?:切换|切到|换个话题|另开|新任务|新话题))/iu;
const EXACT = /(?:\btask\s*#?\s*|任务\s*#?\s*|<\|task:)([1-9]\d{0,2})(?!\d)/giu;
const EXACT_START = /^(?:(?:please\s+)?(?:continue|resume|revisit|switch to|open|work on)\s+|(?:请\s*)?(?:继续|恢复|切到|切换到|回到|打开)\s*)?(?:task\s*#?\s*|任务\s*#?\s*|<\|task:)[1-9]\d{0,2}(?!\d)/iu;
const clarification = 'Cairn 未确认本轮作用域，请澄清目标。旧作用域不适用于本轮；输出 <|task:UNRESOLVED|>，不要新建或续写任务。';
const RETURN_TO = /^(?:(?:please\s+)?(?:(?:(?:let['’]s|can we)\s+)?(?:go\s+|come\s+|get\s+)?back to\b|(?:return to|revisit|resume|pick up)\s+\S)|(?:请|我们)?(?:再)?(?:回到|接着(?:昨天|之前|上次)|继续(?:昨天|之前|上次)))/iu;

const scopeKey = (sessionId, turn) => createHash('sha256').update(JSON.stringify([sessionId, turn])).digest('hex');

export function resolveMidSessionPolicy(autopilot) {
  const options = autopilot?.midSessionSwitch;
  return {
    enabled: autopilot?.enabled === true && options?.enabled !== false,
    crossProject: options?.crossProject === true,
    routeTimeoutMs: Number.isSafeInteger(options?.routeTimeoutMs) && options.routeTimeoutMs > 0 ? options.routeTimeoutMs : 2500
  };
}

export function createHubTurnRuntime({ hubRoot, policy, taskHeat, clientFor, maxTailChars, stripReminders, onArchive, ask, handleMemoryInput }) {
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
    const entry = { turn, turnKey: scopeKey(id, turn), scope: null, step: 0, signal: null, pending: null, input: '', authored: '', terminal: null, streamMarkers: new Map(), toolNames: new Map(), tools: [] };
    turns.set(id, entry);
    return entry;
  }
  function makeSnapshot(state, target, ticket, hot, projects, task) {
    const inputs = readHandoffInputs(hubRoot, task, target.projectId);
    const v = inputs.version;
    const cached = state.snapshot?.bindingEpoch === target.bindingEpoch ? state.snapshot : null;
    const sameHistory = cached && cached.seenSeq === v.thread_seq;
    if (sameHistory && cached.userRevision === v.user_revision && cached.projectRevision === v.project_revision &&
        cached.observations === v.observations_sha256 && cached.fileWrites === v.file_writes_sha256) return cached;
    const checkout = sameHistory ? cached.checkout : (target.taskId
      ? compileHubTaskCheckout({ hubRoot, taskId: target.taskId, maxTailChars })
      : null);
    const chosen = target.taskId ?? ticket?.taskId;
    const catalog = cached?.catalog ?? buildHubTaskCatalog(hot.map(task => ({ ...task, project_name: projects.get(task.project_id) })));
    const text = [
      `### Cairn current scope\nEarlier Cairn Project Ledgers and Task Checkouts do not apply to this turn. Project: ${target.projectId ?? 'general'}.\nRequired tail marker for this request: <|task:${chosen}|>.`,
      renderHandoffAuthority(inputs, projects.get(target.projectId)),
      checkout?.ok ? `<cairn_task_checkout task_id="${target.taskId}" project_id="${target.projectId ?? 'general'}">\n${checkout.text}\n</cairn_task_checkout>` : '',
      renderHandoffObservations(inputs), renderFileWrites(inputs), catalog
    ].filter(Boolean).join('\n\n');
    return Object.freeze({
      bindingEpoch: target.bindingEpoch, userRevision: v.user_revision, projectRevision: v.project_revision,
      seenSeq: sameHistory ? cached.seenSeq : (checkout?.total_record_count ?? 0),
      observations: v.observations_sha256, fileWrites: v.file_writes_sha256,
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
    const deny = (reason, display = '未能确认本轮任务。请指定任务名称或任务号；没有执行操作。') =>
      scoped({ result: 'clarify', reason }, { display });
    const memory = await handleMemoryInput?.(sessionId, entry.input, entry.turn, () => turns.get(sessionId) === entry && !payload.signal?.aborted);
    if (memory) return deny('memory_command', memory);
    const started = Date.now();
    const index = readHubTasksIndex(hubRoot);
    const tasks = index.tasks;
    const { hot, dormant } = selectHubTaskPools(tasks, { policy: taskHeat });
    const projects = new Map(readProjectsIndex(hubRoot).projects.map(item => [item.project_id, item.name]));
    const bound = tasks.find(task => task.id === state.selectedTaskId && task.status === 'active' && task.project_id === state.selectedProjectId);
    const recovery = tasks.find(task => task.creation_turn_key === entry.turnKey && task.status === 'active');
    const ids = new Set([...entry.input.matchAll(EXACT)].map(m => Number(m[1])));
    const requestToReturn = RETURN_TO.test(entry.input);
    const returning = requestToReturn || state.route?.reason === 'ambiguous' ||
      (bound && !state.explicitPin && !genericResume(entry.input) && mentionsCompetingTopic(entry.input, bound, tasks));
    const explicit = EXACT_START.test(entry.input) || SWITCH.test(entry.input) || requestToReturn;
    let result;
    const hint = bound ? null : resolveGitProjectHint(cwd);
    const projectMention = /\bproject:([a-z0-9_-]+)\b/iu.exec(entry.input)?.[1];
    const pending = readSessionChoice(hubRoot, sessionId);
    const undirected = !bound && genericResume(entry.input) && !ids.size;
    if (pending || undirected) {
      result = { decision: 'ambiguous' };
    } else if (recovery) {
      result = { decision: 'new', task_id: null };
    } else if (explicit && ids.size === 1) {
      const task = tasks.find(item => item.id === [...ids][0] && item.status === 'active');
      if (!task) return deny('explicit_task_unavailable');
      result = { decision: 'match', task_id: task.id, project_id: task.project_id, pool: dormant.some(item => item.id === task.id) ? 'dormant' : 'hot' };
    } else if (bound && !explicit && !returning) {
      result = { decision: 'keep', task_id: bound.id, project_id: bound.project_id };
    } else {
      if (state.explicitPin && !bound && !explicit) return deny('pinned_task_unavailable');
      result = await runHubColdRouter({
        hubRoot, userPrompt: entry.input, taskHeat, timeoutMs: policy.routeTimeoutMs, signal: payload.signal,
        cwdProjectHint: bound ? null : hint?.project_id ?? null, llmClient: clientFor(modelSelection)
      });
    }
    if (payload.signal?.aborted || turns.get(sessionId) !== entry) return deny('aborted');
    let picked = null;
    if (result.decision === 'ambiguous' || ((returning || resumeIntent(entry.input)) && result.decision === 'new' && !SWITCH.test(entry.input)) ||
        (!result.ok && !result.decision && resumeIntent(entry.input) && !ids.size) ||
        result.error_code === 'continuation_unresolved') {
      const eligible = tasks.filter(t => t.status === 'active' && (!bound || policy.crossProject || bound.project_id === t.project_id) &&
        (!projectMention || !explicit || projectMention === t.project_id));
      picked = await pickTask({ root: hubRoot, sessionId, entry, payload, expectedEpoch, eligible, projects,
        candidates: result.candidates, ask, pending, current: () => !payload.signal?.aborted && turns.get(sessionId) === entry &&
          syncBinding(sessionId).bindingEpoch === expectedEpoch });
      if (!picked.id) return deny(picked.reason, picked.text);
      const task = eligible.find(t => t.id === picked.id);
      if (!task) return deny('task_invalidated');
      result = { decision: 'match', task_id: task.id, project_id: task.project_id,
        pool: dormant.some(t => t.id === task.id) ? 'dormant' : 'hot' };
    }
    if (!['match', 'keep', 'new'].includes(result.decision)) return deny(result.decision === 'ambiguous' ? 'ambiguous' : 'route_error');
    if (syncBinding(sessionId).bindingEpoch !== expectedEpoch) return deny('epoch_conflict');
    if (projectMention && explicit && !projects.has(projectMention)) return deny('unknown_project');
    const projectId = recovery ? recovery.project_id : result.decision === 'new'
      ? (explicit ? projectMention : null) ?? (bound ? bound.project_id : hint?.project_id ?? null)
      : result.project_id ?? null;
    if (projectMention && explicit && projectMention !== projectId) return deny('project_mismatch');
    if (bound && bound.project_id !== projectId && !policy.crossProject) return deny('cross_project_disabled');
    const taskId = result.task_id ?? null;
    const currentIndex = readHubTasksIndex(hubRoot);
    const selected = taskId ? currentIndex.tasks.find(t => t.id === taskId && t.project_id === projectId && t.status === 'active') : null;
    if (taskId && !selected) return deny('task_invalidated');
    const allocate = result.decision === 'new';
    const nextId = recovery?.id ?? currentIndex.next_task_id;
    if (allocate && (nextId < 1 || nextId > 999)) return deny('task_ids_exhausted');
    const ticket = allocate ? Object.freeze({ taskId: nextId, turnKey: entry.turnKey }) : null;
    const same = !allocate && taskId === bound?.id && projectId === bound.project_id;
    const target = { projectId, taskId, bindingEpoch: same ? expectedEpoch : randomUUID() };
    const snapshot = makeSnapshot(state, target, ticket, hot, projects, selected);
    return scoped({ result: result.decision, pool: result.pool ?? null, elapsed_ms: Date.now() - started }, {
      ...target, snapshot, newTaskTicket: ticket, explicitPin: same && state.explicitPin,
      humanChoice: Boolean(picked),
      resumed: picked && picked.originalTurn !== entry.turn ? { turn: picked.originalTurn, input: picked.input } : null,
      bindingSource: picked ? 'human_choice' : same ? state.bindingSource : allocate ? 'new_task_ticket' : result.pool === 'dormant' ? 'dormant_wake' : explicit ? 'explicit_switch' : 'cold_router_match',
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
      const authored = (payload.messages ?? []).filter(msg => msg.source?.kind === 'user').map(msg => stripReminders(textOf(msg))).filter(Boolean);
      const input = authored.join('\n\n');
      if (!input) return;
      entry.input = input;
      entry.selectionMessages = authored.length;
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
        recordTurnReceipt(hubRoot, sessionId, turn, { status: 'in_progress', reason: 'awaiting_turn_end', first_seq: entry.firstSeq ?? null });
      }
    }
  }
  function blockedReply(id) {
    const entry = turns.get(id);
    const scope = entry?.scope;
    if (!scope && id && readSessionChoice(hubRoot, id)) return '仍在等待用户选择任务；没有执行操作。';
    if (scope?.route.result === 'clarify') return scope.display ?? '请指定要继续的任务；没有执行操作。';
    if (scope?.bindingSource !== 'human_choice') return null;
    const binding = readSessionBinding(hubRoot, id, { includeCleared: true });
    if ((binding?.binding_epoch ?? null) !== scope.expectedEpoch ||
        !readHubTasksIndex(hubRoot).tasks.some(t => t.id === scope.taskId && t.project_id === scope.projectId && t.status === 'active')) {
      entry.invalidatedChoice = true;
      return '刚选择的任务或会话绑定已改变；请重新选择。';
    }
    return null;
  }
  function event(sessionId, event) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      const initial = turns.get(sessionId)?.turn === data.turn ? turns.get(sessionId) : begin(sessionId, data.turn);
      if (Number.isSafeInteger(event.seq)) initial.firstSeq ??= event.seq;
      return;
    }
    const entry = turns.get(sessionId);
    if (!entry || (data.turn != null && data.turn !== entry.turn)) return;
    const msg = data.message ?? data;
    if (event.type === 'tool/call' && data.name === 'write' && data.turn === entry.turn && Number.isSafeInteger(event.seq)) {
      (entry.writeCalls ??= new Map()).set(data.callId, { step: data.step, seq: event.seq });
    }
    if (Number.isSafeInteger(event.seq)) entry.firstSeq ??= event.seq;
    const tool = collectToolEvidence(entry, event);
    const pinned = entry.scope;
    if (tool && event.surfaceOp === 'append' && pinned?.taskId && pinned.expectedEpoch === pinned.bindingEpoch && data.turn === entry.turn && Number.isSafeInteger(event.seq)) {
      checkpointToolResult(hubRoot, { taskId: pinned.taskId, projectId: pinned.projectId, bindingEpoch: pinned.bindingEpoch,
        source: { host: 'dsh', session_id: sessionId, turn: entry.turn, step: data.step ?? entry.step, journal_seq: event.seq },
        request: userText(entry), tool });
    }
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
        entry.terminal = { step: entry.step, seq: event.seq, marker: hidden?.display_text === text ? hidden : parseTaskMarker(text) };
      }
    }
    if (event.type !== 'turn/end') return;
    turns.delete(sessionId);
    const state = stateFor(sessionId);
    const scope = entry.scope;
    const user = userText(entry);
    if (!user || state.lastProcessedTurnKey === entry.turnKey) return;
    const receipt = (status, reason, extra) => recordTurnReceipt(hubRoot, sessionId, entry.turn, {
      status, reason, first_seq: entry.firstSeq ?? null, end_seq: event.seq ?? null,
      ...(scope?.resumed ? { original_turn: scope.resumed.turn } : {}), ...extra
    });
    if (data.reason?.kind !== 'completed' || entry.signal?.aborted) {
      if (scope?.route.reason === 'awaiting_choice') {
        const pending = readSessionChoice(hubRoot, sessionId);
        if (pending?.turn === entry.turn) replaceSessionChoice(hubRoot, sessionId, pending.key, null);
      }
      return receipt('interrupted', 'not_completed');
    }
    if (!scope || scope.route.result === 'clarify') return receipt('unassigned', scope?.route.reason ?? 'scope_unavailable');
    if (entry.invalidatedChoice) return receipt('unassigned', 'choice_stale');
    if (entry.terminal?.step !== entry.step) return receipt('unassigned', 'no_final_answer');
    const marker = entry.terminal.marker;
    if (!marker.valid || marker.is_unresolved) {
      if (marker.is_unresolved || marker.display_text?.includes('<|task:')) return receipt('unassigned', marker.is_unresolved ? 'unresolved' : 'marker_invalid');
      return receipt('unassigned', 'marker_missing', { project_id: scope.projectId, final_seq: entry.terminal.seq ?? null,
        ...(scope.resumed ? { selection_messages: entry.selectionMessages } : {}),
        source_digest: turnSourceDigest(user, marker.display_text) });
    }
    if (marker.task_number !== (scope.taskId ?? scope.newTaskTicket?.taskId)) {
      state.pendingSwitch = Object.freeze({ taskId: marker.task_number, turn: entry.turn });
      return receipt('unassigned', 'marker_mismatch');
    }
    const result = finishHubScopedTurn(hubRoot, { sessionId, turn: entry.turn, scope, user, assistant: marker.answer, tools: entry.tools });
    if (result.status !== 'archived') return receipt('unassigned', result.status);
    receipt('archived', 'confirmed_marker', { task_id: result.taskId, ...(result.appended ? { extraction: { [scope.projectId ? 'project' : 'user']: 'pending' } } : {}) });
    syncBinding(sessionId, result.binding);
    state.lastProcessedTurnKey = scope.turnKey;
    // Native history contains our own answer. Advancing past an intervening peer append would lose its evidence.
    state.snapshot = scope.snapshot.seenSeq === result.prior_seq
      ? Object.freeze({ ...scope.snapshot, seenSeq: result.end_seq }) : scope.snapshot;
    state.presentedSnapshot = scope.snapshot;
    if (result.appended) onArchive({ sessionId, turn: entry.turn, scope, taskId: result.taskId, user, assistant: marker.answer });
  }
  function context(id) {
    const scope = turns.get(id)?.scope;
    if (scope?.taskId && !readHubTasksIndex(hubRoot).tasks.some(task =>
      task.id === scope.taskId && task.project_id === scope.projectId && task.status === 'active')) return clarification;
    const text = scope?.snapshot.text ?? sessions.get(id)?.presentedSnapshot?.text ?? '';
    if (!scope?.humanChoice) return text;
    const guidance = '\n任务选择只确认归属，不扩大原请求的授权。请接着原请求做；若只有“继续”，先核实历史状态，仅推进此前已经明确的目标。';
    if (!scope.resumed) return text + guidance;
    return text + guidance + '\n\n<cairn_resume_request>\n以下是用户先前提出、现在已确认归属的原请求：\n' +
      JSON.stringify(scope.resumed.input).replaceAll('<', '\\u003c') + '\n</cairn_resume_request>';
  }
  function userText(entry) {
    return entry.scope?.resumed ? resumeUserText(entry.scope.resumed.input, entry.input, entry.authored) : entry.authored || entry.input;
  }
  return { sessions, turns, syncBinding, preStep, event, context, blockedReply, userText };
}

export const HUB_TURN_CONTRACT = buildAntiRecencyContract() +
  '\n用户的本轮表达偏好可用于当前回答，不因此改写长期默认。先完成业务请求；长期偏好的提案、范围确认与生效回执由宿主另行处理，勿声称已保存或代用户确认。';

export async function* hideHubStreamMarker(stream, entry, { strip = true, footer = '' } = {}) {
  const step = entry.step;
  entry.streamMarkers.delete(step);
  const blocks = new Map();
  const previousText = [];
  let toolCall = false;
  let held;
  function* finishBlock(note) {
    const { chunk, marker, fullMarker, sent, metadata } = held;
    const text = marker.answer + note + (strip ? '' : '\n<|task:' + marker.task_number + '|>');
    entry.streamMarkers.set(step, { ...fullMarker, display_text: [...previousText, text].join('\n').trim() });
    if (text.length > sent) yield { type: 'text-delta', index: chunk.index, text: text.slice(sent) };
    yield { ...chunk, block: { ...chunk.block, text } };
    yield* metadata;
    previousText.push(chunk.block.text);
    held = null;
  }
  for await (const chunk of stream) {
    if (held && chunk.type === 'usage') { held.metadata.push(chunk); continue; }
    if (held) yield* finishBlock(!toolCall && chunk.type === 'finish' && chunk.reason?.kind === 'stop' ? footer : '');
    if (chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') toolCall = true;
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
      const fullMarker = footer && marker.valid && previousText.length ? parseTaskMarker([...previousText, raw].join('\n')) : marker;
      if (footer && fullMarker.valid && marker.task_number === (entry.scope.taskId ?? entry.scope.newTaskTicket?.taskId) &&
          marker.answer.length >= (block?.sent ?? 0)) {
        held = { chunk, marker, fullMarker, sent: block?.sent ?? 0, metadata: [] };
        blocks.delete(chunk.index);
        continue;
      }
      const text = marker.valid && strip ? marker.display_text : raw;
      if (marker.valid && marker.display_text.length >= (block?.sent ?? 0)) entry.streamMarkers.set(step, marker);
      else entry.streamMarkers.delete(step);
      const remainder = text.slice(block?.sent ?? 0);
      if (remainder) yield { type: 'text-delta', index: chunk.index, text: remainder };
      blocks.delete(chunk.index);
      if (footer) previousText.push(raw);
      yield { ...chunk, block: { ...chunk.block, text } };
      continue;
    }
    yield chunk;
  }
  if (held) yield* finishBlock('');
}
