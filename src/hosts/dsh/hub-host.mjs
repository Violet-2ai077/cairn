import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildHubTaskCatalog, buildScopedAuthorityContract, buildAntiRecencyContract, readHubTasksIndex,
  readSessionBinding, writeSessionBinding, clearSessionBinding, isHubInitialized,
  readScopedHead, projectReadOnlyLedger, upsertHubTask, appendHubTaskTurnPair, initHubStore, parseTaskMarker, readHubTaskThread,
  transitionHubTaskStatus, revertScopedCommit, bindHubRoutedTask
} from '../../kernel/index.mjs';
import { readScopedStaged, commitScopedStaged, dropScopedStaged } from '../../kernel/index.mjs';
import { resolveStoreRoot } from '../../workers/store-root.mjs';
import { runHubColdRouter } from '../../workers/hub-cold-router.mjs';
import { compileHubTaskCheckout } from '../../workers/hub-task-checkout.mjs';
import { runHubDoctor } from '../../workers/hub-doctor.mjs';
import { runHubStagingExtractor } from '../../workers/hub-staging-extractor.mjs';
import { createHubTaskCompactionCoordinator } from '../../workers/hub-strict-compactor.mjs';
import { createHubWriteCoordinator } from '../../workers/hub-write-coordinator.mjs';
import { readProjectsIndex } from '../../kernel/hub-store.mjs';
import { listHubTaskPools, resolveTaskHeatPolicy, selectHubTaskPools } from '../../kernel/task-heat.mjs';
import { resolveGitProjectHint } from './git-project.mjs';

function createHubHostLlmClient(ctx, route) {
  return {
    async complete({ system = '', messages = [], temperature = 0, signal } = {}) {
      if (!route?.provider || !route?.model || !ctx.llm?.stream) return { ok: false, error_code: 'host_route_unavailable', error_message: 'No selected host model route' };
      const request = { provider: route.provider, model: route.model, sessionId: route.sessionId, temperature, purpose: 'cairn-worker', messages: [{ role: 'system', content: [{ type: 'text', text: system }] }, ...messages.map(m => ({ role: m.role, content: [{ type: 'text', text: String(m.content ?? '') }] }))], ...(signal ? { signal } : {}) };
      let output = '';
      try {
        for await (const chunk of ctx.llm.stream(request)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
          else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && !output) output = chunk.block.text ?? '';
          else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return { ok: false, error_code: chunk.reason.failure?.code ?? 'host_llm_error', error_message: chunk.reason.failure?.message ?? 'Host LLM error' };
        }
        return { ok: true, content: output };
      } catch (error) { return { ok: false, error_code: 'host_llm_error', error_message: error?.message ?? String(error) }; }
    }
  };
}

function stripTrailingSystemReminders(text) {
  let cleaned = String(text ?? '').trimEnd();
  const reminder = /(?:\r?\n){0,2}<system-reminder>\s*[\s\S]*?<\/system-reminder>\s*$/iu;
  while (reminder.test(cleaned)) cleaned = cleaned.replace(reminder, '').trimEnd();
  return cleaned.trim();
}

function routingUserPrompt(messages, turnNumber, currentTurn) {
  if (currentTurn?.turn === turnNumber && currentTurn?.authoredUser?.trim()) return currentTurn.authoredUser.trim();
  const message = (messages ?? []).findLast(item => item?.source?.kind === 'user');
  const messageTurn = message?.turn ?? message?.source?.turn;
  if (messageTurn != null && turnNumber != null && messageTurn !== turnNumber) return '';
  const content = message?.content;
  return stripTrailingSystemReminders(Array.isArray(content)
    ? content.filter(block => block?.type == null || block.type === 'text').map(block => block?.text ?? '').join('')
    : content);
}

export async function createHubDshHost(ctx, config = {}) {
  const hubRoot = resolveStoreRoot({ storeRoot: config.storeRoot });
  const disposers = [];
  const sessions = new Map();
  const turns = new Map();
  const modelRoutes = new Map();
  const workerLlmCallContext = new AsyncLocalStorage();
  const pending = new Set();
  const sessionJobs = new Map();
  const compactionCoordinator = createHubTaskCompactionCoordinator({ hubRoot, cooldownMs: config.autoCompactCooldownMs ?? 300000 });
  const writeCoordinator = createHubWriteCoordinator();
  const taskHeat = resolveTaskHeatPolicy(config.autopilot);
  const routingUnresolved = state => taskHeat.enabled && ['ambiguous', 'error'].includes(state?.route?.result);
  const taskList = filter => listHubTaskPools(readHubTasksIndex(hubRoot).tasks, { policy: taskHeat })
    .filter(task => !filter || task.status === filter);
  const clientFor = route => config.llmClient ?? createHubHostLlmClient(ctx, route);
  const routeForTurn = (sessionId, turn) => {
    const entry = modelRoutes.get(sessionId);
    return entry && (entry.turn == null || entry.turn === turn) ? entry.route : null;
  };
  const sessionIdFrom = payload => payload?.agent?.session?.id ?? payload?.session?.id ?? payload?.sessionId ?? null;
  const cwdFrom = payload => payload?.agent?.session?.header?.cwd ?? payload?.session?.header?.cwd ?? payload?.header?.cwd ?? null;
  const stateFor = sessionId => sessions.get(sessionId) ?? { selectedProjectId: null, taskId: null, route: null, cwdHint: null, bindingSource: null };
  function enqueueSessionJob(sessionId, job) {
    const previous = sessionJobs.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(job).catch(() => {});
    sessionJobs.set(sessionId, next); pending.add(next);
    next.finally(() => { pending.delete(next); if (sessionJobs.get(sessionId) === next) sessionJobs.delete(sessionId); });
    return next;
  }
  function clearTaskSessionState(taskId) {
    for (const [sessionId, state] of sessions) {
      if (state.taskId !== taskId) continue;
      sessions.set(sessionId, { ...state, taskId: null, bindingSource: null, route: { result: 'task_lifecycle_changed', elapsed_ms: 0 } });
    }
  }
  function readStatus() {
    const tasks = readHubTasksIndex(hubRoot).tasks;
    return {
      initialized: isHubInitialized(hubRoot),
      projects: readProjectsIndex(hubRoot).projects.length,
      tasks: tasks.length,
      active_tasks: tasks.filter(task => task.status === 'active').length
    };
  }

  if (ctx.systemPrompt?.context) {
    const stop = ctx.systemPrompt.context({ name: 'cairn:user-and-global-catalog', order: 300, interpolate: false, text: context => {
      const projects = new Map(readProjectsIndex(hubRoot).projects.map(project => [project.project_id, project.name]));
      const taskIndex = readHubTasksIndex(hubRoot);
      const { hot } = selectHubTaskPools(taskIndex.tasks, { policy: taskHeat });
      const tasks = hot.map(task => ({ ...task, project_name: projects.get(task.project_id) }));
      const userHead = readScopedHead(hubRoot, { scope: 'user' });
      const taskMarkerContract = `${buildAntiRecencyContract()}\n\nHub 建档规则：任务 marker 是宿主归档与建档的唯一触发器。继续已有任务时沿用其编号；用户明确开启不同新任务时输出 <|task:${taskIndex.next_task_id}|>（下一个从未使用的 ID）。空 Hub 的首个任务因此输出 <|task:1|>。若无法区分已有任务则输出 <|task:UNRESOLVED|> 并澄清，不得猜测。`;
      return [taskMarkerContract, buildScopedAuthorityContract({ userLedgerSnapshot: projectReadOnlyLedger(userHead, { includeTombstones: true }), includeProject: false }), buildHubTaskCatalog(tasks)].filter(Boolean).join('\n\n');
    } });
    if (typeof stop === 'function') disposers.push(stop);
    const stopProject = ctx.systemPrompt.context({ name: 'cairn:locked-project-context', order: 310, interpolate: false, text: context => {
      const sessionId = sessionIdFrom(context);
      const state = sessionId ? stateFor(sessionId) : null;
      if (routingUnresolved(state)) {
        return 'Cairn 路由尚未确认。若用户想继续旧任务，请澄清目标；已关闭或归档的任务需显式重开。在目标未确认前输出 <|task:UNRESOLVED|>，不要新建任务。';
      }
      if (state?.taskId && !readHubTasksIndex(hubRoot).tasks.some(task =>
        task.id === state.taskId && task.project_id === state.selectedProjectId && task.status === 'active')) return '';
      const parts = [];
      if (state?.selectedProjectId) {
        const project = readProjectsIndex(hubRoot).projects.find(item => item.project_id === state.selectedProjectId);
        const projectHead = readScopedHead(hubRoot, { scope: 'project', projectId: state.selectedProjectId });
        parts.push(buildScopedAuthorityContract({ includeUser: false, projectLedgerSnapshot: projectReadOnlyLedger(projectHead, { includeTombstones: true }), projectName: project?.name }));
      }
      if (state?.taskId) {
        const checkout = compileHubTaskCheckout({ hubRoot, taskId: state.taskId, maxTailChars: config.maxTailChars ?? 6000 });
        if (checkout.ok && checkout.project_id === state.selectedProjectId) parts.push(`<cairn_task_checkout task_id="${state.taskId}" project_id="${state.selectedProjectId ?? 'general'}">\n${checkout.text}\n</cairn_task_checkout>`);
      }
      return parts.join('\n\n');
    } });
    if (typeof stopProject === 'function') disposers.push(stopProject);
  }

  if (typeof ctx.on === 'function') {
    const stopPreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      const sessionId = sessionIdFrom(payload);
      if (!sessionId || decision?.kind === 'reject' || payload?.signal?.aborted) return decision;
      const currentTurn = turns.get(sessionId);
      const turnNumber = payload?.turn ?? currentTurn?.turn;
      const selection = payload?.modelSelection;
      const route = selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model, sessionId } : null;
      if (route && (!modelRoutes.has(sessionId) || modelRoutes.get(sessionId).turn !== turnNumber)) {
        modelRoutes.set(sessionId, { turn: turnNumber, route });
      }
      if (currentTurn && currentTurn.turn === turnNumber && !currentTurn.modelRoute) currentTurn.modelRoute = routeForTurn(sessionId, turnNumber);
      let state = stateFor(sessionId);
      if (state.route && ((state.route.result !== 'ambiguous' && !routingUnresolved(state)) ||
          (taskHeat.enabled && state.route.turn === turnNumber))) return decision;
      const tasks = readHubTasksIndex(hubRoot).tasks;
      const userPrompt = routingUserPrompt(payload?.messages, turnNumber, currentTurn);
      const existing = readSessionBinding(hubRoot, sessionId);
      if (existing?.task_id !== null && existing?.task_id !== undefined) {
        const task = tasks.find(item => item.id === existing.task_id && item.status === 'active');
        if (task && task.project_id === existing.project_id) {
          try {
            if (taskHeat.enabled && selectHubTaskPools(tasks, { policy: taskHeat }).dormant.some(item => item.id === task.id)) {
              bindHubRoutedTask(hubRoot, { sessionId, taskId: task.id, projectId: task.project_id, source: existing.source, wake: true });
            }
            state = { ...state, selectedProjectId: existing.project_id, taskId: task.id, bindingSource: existing.source, route: { result: 'explicit_binding', elapsed_ms: 0 } };
            sessions.set(sessionId, state); return decision;
          } catch {
            sessions.set(sessionId, { ...state, selectedProjectId: null, taskId: null, bindingSource: null, route: { result: 'error', turn: turnNumber, elapsed_ms: 0, error_code: 'route_binding_invalidated' } });
            return decision;
          }
        }
      }
      const cwdHint = resolveGitProjectHint(cwdFrom(payload));
      if ((!taskHeat.enabled && !tasks.some(task => task.status === 'active')) || (!tasks.length && !userPrompt)) {
        sessions.set(sessionId, { ...state, selectedProjectId: cwdHint?.project_id ?? null, cwdHint: cwdHint?.project_id ?? null, route: { result: 'new', elapsed_ms: 0 } });
        return decision;
      }
      if (!userPrompt) return decision;
      const start = Date.now();
      let result = await runHubColdRouter({
        hubRoot, userPrompt, cwdProjectHint: cwdHint?.project_id ?? null, llmClient: clientFor(route),
        signal: payload.signal, taskHeat, timeoutMs: config.autopilot?.taskHeat?.routeTimeoutMs
      });
      if (payload.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
      const elapsed = Date.now() - start;
      let bindingSource = null;
      if (result.ok && result.decision === 'match') {
        bindingSource = result.pool === 'dormant' ? 'dormant_wake' : 'cold_router_match';
        try {
          bindHubRoutedTask(hubRoot, { sessionId, taskId: result.task_id, projectId: result.project_id, source: bindingSource, wake: result.pool === 'dormant' });
        } catch {
          result = { ok: false, error_code: 'route_binding_invalidated' };
        }
      }
      if (result.ok && result.decision === 'match') {
        state = { ...state, selectedProjectId: result.project_id, taskId: result.task_id, cwdHint: cwdHint?.project_id ?? null, bindingSource, route: { result: 'match', elapsed_ms: elapsed } };
      } else {
        const selectedProjectId = result.ok && result.decision === 'new' ? cwdHint?.project_id ?? null : null;
        state = { ...state, selectedProjectId, taskId: null, cwdHint: cwdHint?.project_id ?? null, bindingSource: null, route: { result: result.ok ? result.decision : 'error', elapsed_ms: elapsed, turn: turnNumber } };
        if (selectedProjectId && tasks.length) { initHubStore(hubRoot); writeSessionBinding(hubRoot, sessionId, { project_id: selectedProjectId, task_id: null, source: 'cwd_new' }); }
      }
      sessions.set(sessionId, state);
      return decision;
    }, { global: true });
    if (typeof stopPreStep === 'function') disposers.push(stopPreStep);
    const stopFlush = ctx.on('session/flush', async session => {
      if (workerLlmCallContext.getStore()) return;
      const id = session?.id ?? session?.sessionId;
      if (id && sessionJobs.has(id)) await sessionJobs.get(id);
      await compactionCoordinator.flush();
    }, { global: true });
    if (typeof stopFlush === 'function') disposers.push(stopFlush);
    const stopDisposed = ctx.on('session/disposed', async session => { const id = session?.id ?? session?.sessionId; if (id && sessionJobs.has(id)) await sessionJobs.get(id); if (id) { sessions.delete(id); turns.delete(id); modelRoutes.delete(id); } }, { global: true });
    if (typeof stopDisposed === 'function') disposers.push(stopDisposed);
    const stopEvent = ctx.on('session/event', (session, event) => {
      const sessionId = session?.id ?? session?.sessionId;
      if (!sessionId || !event?.type) return;
      const turn = event.type === 'turn/start' || !turns.has(sessionId)
        ? { turn: event.data?.turn ?? 1, user: '', authoredUser: '', assistant: '', modelRoute: routeForTurn(sessionId, event.data?.turn ?? 1) }
        : turns.get(sessionId);
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const message = event.data?.message ?? event.data;
        const content = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map(block => block?.text ?? '').join('\n') : '';
        if (event.type === 'user/message') {
          const source = message?.source?.kind ?? event.data?.source?.kind;
          const clean = stripTrailingSystemReminders(content);
          if (!source || source === 'user') turn.user += `\n${clean}`;
          if (source === 'user' && (event.surfaceOp === undefined || event.surfaceOp === 'append')) turn.authoredUser += `\n${clean}`;
        }
        else turn.assistant += `\n${content}`;
      }
      turns.set(sessionId, turn);
      if (event.type !== 'turn/end') return;
      const state = stateFor(sessionId);
      const marker = parseTaskMarker(turn.assistant.trim());
      turns.delete(sessionId);
      if (routingUnresolved(state) || !marker.valid || marker.is_unresolved || (event.data?.reason?.kind && event.data.reason.kind !== 'completed')) return;
      const taskId = marker.task_number;
      try {
        initHubStore(hubRoot);
        const projectHint = resolveGitProjectHint(cwdFrom(session));
        const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === taskId);
        if (!task) upsertHubTask(hubRoot, { id: taskId, project_id: state.selectedProjectId, project: projectHint?.project_id === state.selectedProjectId ? projectHint : null, title: turn.user.trim().slice(0, 120) || `Task ${taskId}` });
        if (task && task.project_id !== (state.selectedProjectId ?? null)) return;
        const projectId = state.selectedProjectId ?? null;
        const { appended } = appendHubTaskTurnPair(hubRoot, {
          taskId, projectId, sessionId, turn: turn.turn, user: turn.user.trim(), assistant: marker.answer,
          activity: Boolean(turn.authoredUser.trim())
        });
        if (!appended) return;
        state.taskId = taskId; state.bindingSource = state.bindingSource ?? 'task_marker'; sessions.set(sessionId, state);
        writeSessionBinding(hubRoot, sessionId, { project_id: projectId, task_id: taskId, source: state.bindingSource });
        const stagedTurn = { turn: turn.turn, user: turn.user.trim(), assistant: marker.answer };
        const client = clientFor(turn.modelRoute ?? routeForTurn(sessionId, turn.turn));
        const project = projectId && projectHint?.project_id === projectId ? projectHint : null;
        enqueueSessionJob(sessionId, async () => {
          await workerLlmCallContext.run({ sessionId }, () => runHubStagingExtractor({
            hubRoot, scope: projectId ? 'project' : 'user', projectId, project, turnInput: stagedTurn,
            authoredUserText: turn.authoredUser, autopilot: config.autopilot, source_step: `turn_${turn.turn}`,
            actor_id: config.actorId ?? 'dsh-host', llmClient: client
          }));
          const current = readHubTasksIndex(hubRoot).tasks.find(item => item.id === taskId);
          if (!current || current.status !== 'active') return;
          const records = readHubTaskThread(hubRoot, taskId).slice(current.compacted_record_count);
          const chars = records.reduce((sum, record) => sum + String(record.content ?? '').length, 0);
          const minRecords = Number.isSafeInteger(config.autoCompactMinRecords) ? config.autoCompactMinRecords : 12;
          const minChars = Number.isSafeInteger(config.autoCompactMinChars) ? config.autoCompactMinChars : 4500;
          if ((minRecords > 0 && records.length >= minRecords) || (minChars > 0 && chars >= minChars)) await workerLlmCallContext.run({ sessionId }, () => compactionCoordinator.run({ taskId, source: 'auto', mode: 'incremental', llmClient: client }));
        });
      } catch { /* Invalid task markers cannot produce cross-project writes. */ }
    }, { global: true });
    if (typeof stopEvent === 'function') disposers.push(stopEvent);
  }

  const commands = ctx.get?.('commands') ?? ctx.commands;
  if (ctx.tools?.register) {
    const definitions = [
      { name: 'cairn_status', description: 'Read-only status of the centralized Cairn Hub.', parameters: { type: 'object', properties: {} }, async execute() { return JSON.stringify(readStatus()); } },
      { name: 'cairn_tasks', description: 'List active tasks and their derived routing pools in the centralized Cairn Hub.', parameters: { type: 'object', properties: {} }, async execute() { return JSON.stringify(taskList('active')); } },
      { name: 'cairn_checkout', description: 'Preview or bind a task to this session. HUMAN AUTHORITY RED LINE: only bind when explicitly instructed.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, preview: { type: 'boolean' }, clear: { type: 'boolean' } } }, async execute(args = {}, runCtx = {}) { const id = runCtx.agent?.session?.id; if (!id) return 'session_id_unavailable'; if (args.clear) { clearSessionBinding(hubRoot, id); sessions.delete(id); return 'Session checkout cleared.'; } const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === args.task_id); if (!task) return `task_not_found:${args.task_id}`; const checkout = compileHubTaskCheckout({ hubRoot, taskId: task.id }); if (args.preview) return checkout.text; if (task.status !== 'active') return `task_not_active:${task.id}; reopen first`; writeSessionBinding(hubRoot, id, { project_id: task.project_id, task_id: task.id, source: 'tool_checkout' }); sessions.set(id, { ...stateFor(id), selectedProjectId: task.project_id, taskId: task.id, bindingSource: 'tool_checkout' }); return `Checked out task ${task.id}.`; } },
      { name: 'cairn_compact', description: 'Compact a task-local Hub history. HUMAN AUTHORITY RED LINE: only compact when explicitly instructed by the user.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, full: { type: 'boolean' }, confirmed: { type: 'boolean' } }, required: ['confirmed'] }, async execute(args = {}, runCtx = {}) { if (args.confirmed !== true) return 'Explicit confirmation required.'; const sessionId = runCtx.agent?.session?.id; const id = args.task_id ?? stateFor(sessionId).taskId; if (!id) return 'no_active_task'; const llmClient = clientFor(modelRoutes.get(sessionId)?.route); return JSON.stringify(await workerLlmCallContext.run({ sessionId }, () => compactionCoordinator.run({ taskId: id, source: 'manual', mode: args.full ? 'full' : 'incremental', llmClient }))); } },
      ...['close', 'archive', 'reopen'].map(action => ({ name: `cairn_${action}_task`, description: `Change task lifecycle with ${action}. HUMAN AUTHORITY RED LINE: only perform when explicitly instructed by the user.`, parameters: { type: 'object', properties: { task_id: { type: 'integer' }, confirmed: { type: 'boolean' } }, required: ['task_id', 'confirmed'] }, async execute(args = {}) { if (args.confirmed !== true) return 'Explicit confirmation required.'; const result = transitionHubTaskStatus(hubRoot, { taskId: args.task_id, action }); if (action !== 'reopen') clearTaskSessionState(args.task_id); return JSON.stringify(result); } })),
      { name: 'cairn_commit', description: 'Commit staged Hub decisions. HUMAN AUTHORITY RED LINE: only call on explicit user confirmation.', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['user', 'project'] }, project_id: { type: 'string' }, proposal_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['scope', 'confirmed'] }, async execute(args = {}) { if (args.confirmed !== true) return 'Explicit confirmation required.'; return JSON.stringify(await writeCoordinator.run({ scope: args.scope, projectId: args.project_id ?? null }, () => commitScopedStaged(hubRoot, { scope: args.scope, projectId: args.project_id ?? null, proposal_id: args.proposal_id }))); } },
      { name: 'cairn_drop', description: 'Drop staged Hub decisions. HUMAN AUTHORITY RED LINE: only call on explicit user confirmation.', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['user', 'project'] }, project_id: { type: 'string' }, proposal_id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['scope', 'confirmed'] }, async execute(args = {}) { if (args.confirmed !== true) return 'Explicit confirmation required.'; return JSON.stringify(await writeCoordinator.run({ scope: args.scope, projectId: args.project_id ?? null }, () => dropScopedStaged(hubRoot, { scope: args.scope, projectId: args.project_id ?? null, proposal_id: args.proposal_id }))); } }
    ];
    for (const def of definitions) {
      def.output = {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: String(value ?? '') }]; }
      };
      const dispose = ctx.tools.register(def);
      if (typeof dispose === 'function') disposers.push(dispose);
    }
  }
  if (commands?.register) {
    const stop = commands.register({ name: 'cairn', description: 'Manage centralized Cairn Hub state', input: { hint: 'status | tasks [--all|--status <status>] | inspect | doctor | checkout <id|--clear> [--preview] | undo <user|project [id]> <seq> [--preview] <reason>' }, async handler({ rawInput, agent }) {
      const args = String(rawInput ?? 'status').trim().split(/\s+/u).filter(Boolean);
      const sessionId = agent?.session?.id;
      if (args[0] === 'undo' || args[0] === 'revert') {
        const scope = args[1];
        const offset = scope === 'project' ? 3 : 2;
        const preview = args.includes('--preview');
        try {
          if (!/^\d+$/u.test(args[offset] ?? '')) throw new Error('undo_commit_seq_required');
          const result = revertScopedCommit(hubRoot, {
            scope, projectId: scope === 'project' ? args[2] : null,
            commitSeq: Number(args[offset]), reason: args.slice(offset + 1).filter(arg => arg !== '--preview').join(' '), preview
          });
          return { kind: ['preview', 'reverted', 'already_reverted'].includes(result.status) ? 'success' : 'error', text: JSON.stringify(result) };
        } catch (error) { return { kind: 'error', text: error.message }; }
      }
      if (args[0] === 'checkout') {
        if (!sessionId) return { kind: 'error', text: 'session_id_unavailable' };
        if (args[1] === '--clear') { clearSessionBinding(hubRoot, sessionId); sessions.delete(sessionId); return { kind: 'success', text: 'Session checkout cleared.' }; }
        const id = Number(args[1]);
        const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === id);
        if (!task) return { kind: 'error', text: `task_not_found:${id}` };
        if (task.status !== 'active' && !args.includes('--preview')) return { kind: 'error', text: `task_not_active:${id}; reopen first` };
        const checkout = compileHubTaskCheckout({ hubRoot, taskId: id });
        if (args.includes('--preview')) return { kind: 'success', text: checkout.text };
        writeSessionBinding(hubRoot, sessionId, { project_id: task.project_id, task_id: id, source: 'slash_checkout' });
        sessions.set(sessionId, { ...stateFor(sessionId), selectedProjectId: task.project_id, taskId: id, bindingSource: 'slash_checkout', route: { result: 'explicit_binding', elapsed_ms: 0 } });
        return { kind: 'success', text: `Checked out task ${id}.` };
      }
      if (args[0] === 'compact') {
        const sessionId = agent?.session?.id;
        const requested = args[1] && !args[1].startsWith('--') ? Number(args[1]) : stateFor(sessionId).taskId;
        if (!requested) return { kind: 'error', text: 'no_active_task' };
        const llmClient = clientFor(modelRoutes.get(sessionId)?.route);
        const result = await workerLlmCallContext.run({ sessionId }, () => compactionCoordinator.run({ taskId: requested, source: 'manual', mode: args.includes('--full') ? 'full' : 'incremental', llmClient }));
        return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
      }
      if (args[0] === 'doctor') return { kind: 'success', text: JSON.stringify(runHubDoctor({ hubRoot }), null, 2) };
      if (args[0] === 'status') return { kind: 'success', text: JSON.stringify(readStatus(), null, 2) };
      if (args[0] === 'init') return { kind: 'success', text: JSON.stringify(initHubStore(hubRoot)) };
      if (args[0] === 'commit' || args[0] === 'drop') {
        const scope = args[1] === 'project' ? 'project' : 'user';
        const projectId = scope === 'project' ? args[2] : null;
        const proposalId = args.find(token => /^stg_\d+$/u.test(token));
        const result = await writeCoordinator.run({ scope, projectId }, () => args[0] === 'commit' ? commitScopedStaged(hubRoot, { scope, projectId, proposal_id: proposalId }) : dropScopedStaged(hubRoot, { scope, projectId, proposal_id: proposalId }));
        return { kind: 'success', text: JSON.stringify(result) };
      }
      if (['close', 'archive', 'reopen'].includes(args[0])) {
        const taskId = Number(args[1]);
        const result = transitionHubTaskStatus(hubRoot, { taskId, action: args[0] });
        if (args[0] !== 'reopen') clearTaskSessionState(taskId);
        return { kind: 'success', text: JSON.stringify(result) };
      }
      if (args[0] === 'inspect') {
        const state = stateFor(sessionId);
        const fingerprint = state.selectedProjectId ? `ws_${crypto.createHash('sha256').update(state.selectedProjectId).digest('hex').slice(0, 8)}` : null;
        return { kind: 'success', text: JSON.stringify({ hub_initialized: isHubInitialized(hubRoot), workspace_fingerprint: fingerprint, cwd_hint_mode: state.cwdHint ? 'git_project_hint' : 'general', selected_project_fingerprint: fingerprint, binding_source: state.bindingSource, last_route: state.route, auto_compaction: state.taskId ? compactionCoordinator.getTaskStatus(state.taskId) : { status: 'idle' }, session_id_present: Boolean(sessionId) }, null, 2) };
      }
      if (args[0] === 'tasks') {
        const showAll = args[1] === '--all' && args.length === 2;
        const filter = args[1] === '--status' && args.length === 3 ? args[2] : args.length === 1 ? 'active' : null;
        if (!showAll && !['active', 'done', 'archived'].includes(filter)) return { kind: 'error', text: 'Use tasks [--all|--status <active|done|archived>]' };
        return { kind: 'success', text: JSON.stringify(taskList(filter), null, 2) };
      }
      return { kind: 'success', text: JSON.stringify(readStatus(), null, 2) };
    } });
    if (typeof stop === 'function') disposers.push(stop);
  }
  return { hubRoot, sessions, dispose: async () => { while (pending.size) await Promise.allSettled([...pending]); await Promise.all([compactionCoordinator.flush(), writeCoordinator.flush()]); for (const stop of disposers) { try { stop(); } catch {} } sessions.clear(); turns.clear(); modelRoutes.clear(); } };
}
