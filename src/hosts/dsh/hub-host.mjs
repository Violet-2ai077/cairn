import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildStrictCompactorPrompt, readHubTasksIndex,
  readSessionBinding, writeSessionBinding, clearSessionBinding, isHubInitialized,
  readScopedHead, initHubStore, parseTaskMarker,
  transitionHubTaskStatus, revertScopedCommit, bindHubRoutedTask
} from '../../kernel/index.mjs';
import { readScopedStaged, commitScopedStaged, dropScopedStaged } from '../../kernel/index.mjs';
import { resolveStoreRoot } from '../../workers/store-root.mjs';
import { isHubContinuation, runHubColdRouter } from '../../workers/hub-cold-router.mjs';
import { captureCompatibilityContext } from './hub-context.mjs';
import { readConsistentHub } from '../../kernel/hub-write-lock.mjs';
import { compileHubHandoff } from '../../workers/hub-handoff.mjs';
import { installFileWriteHook } from './file-write-hook.mjs';
import { runHubDoctor } from '../../workers/hub-doctor.mjs';
import { createArchiveCoordinator } from './hub-archive-coordinator.mjs';
import { createHubTaskCompactionCoordinator, exclusionWatchlist } from '../../workers/hub-strict-compactor.mjs';
import { explicitUserDefaults } from '../../workers/hub-auto-commit.mjs';
import { splitMemoryIntent } from '../../workers/memory-intent.mjs';
import { readMemoryReview } from '../../kernel/memory-review.mjs';
import { memoryCommand, memoryReply, memoryNotice } from './memory-dialog.mjs';
import { appendCompactionDirective } from './compaction-directive.mjs';
import { createHubWriteCoordinator } from '../../workers/hub-write-coordinator.mjs';
import { archiveHubTurn, readProjectsIndex, readTurnReceipts, recordTurnReceipt, recoverMarkerlessTurn, turnSourceDigest } from '../../kernel/hub-store.mjs';
import { collectToolEvidence, persistToolFact, recoverJournalText, textOf } from './turn-journal.mjs';
import { menuStream } from './task-picker.mjs';
import { listHubTaskPools, resolveTaskHeatPolicy, selectHubTaskPools } from '../../kernel/task-heat.mjs';
import { resolveGitProjectHint } from './git-project.mjs';
import { createHubTurnRuntime, hideHubStreamMarker, HUB_TURN_CONTRACT, resolveMidSessionPolicy } from './hub-turn-runtime.mjs';

function createHubHostLlmClient(ctx, route) {
  return {
    async complete({ system = '', messages = [], temperature = 0, signal } = {}) {
      if (!route?.provider || !route?.model || !ctx.llm?.stream) return { ok: false, error_code: 'host_route_unavailable', error_message: 'No selected host model route' };
      const request = { provider: route.provider, model: route.model, sessionId: route.sessionId, temperature, purpose: 'cairn-worker', messages: [{ role: 'system', content: [{ type: 'text', text: system }] }, ...messages.map(m => ({ role: m.role, content: [{ type: 'text', text: String(m.content ?? '') }] }))], ...(signal ? { signal } : {}) };
      let output = '';
      try {
        for await (const chunk of ctx.llm.stream(request)) {
          if (signal?.aborted || (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted')) return { ok: false, error_code: 'aborted' };
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
          else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && !output) output = chunk.block.text ?? '';
          else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return { ok: false, error_code: chunk.reason.failure?.code ?? 'host_llm_error', error_message: chunk.reason.failure?.message ?? 'Host LLM error' };
        }
        return signal?.aborted ? { ok: false, error_code: 'aborted' } : { ok: true, content: output };
      } catch (error) { return { ok: false, error_code: signal?.aborted ? 'aborted' : 'host_llm_error', error_message: error?.message ?? String(error) }; }
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
  const compactionCoordinator = createHubTaskCompactionCoordinator({ hubRoot, cooldownMs: config.autoCompactCooldownMs ?? 300000 });
  const writeCoordinator = createHubWriteCoordinator();
  const taskHeat = resolveTaskHeatPolicy(config.autopilot);
  const routingUnresolved = state => state?.route?.error_code === 'continuation_unresolved' ||
    (taskHeat.enabled && ['ambiguous', 'error'].includes(state?.route?.result));
  const taskList = filter => listHubTaskPools(readHubTasksIndex(hubRoot).tasks, { policy: taskHeat })
    .filter(task => !filter || task.status === filter);
  const clientFor = route => config.llmClient ?? createHubHostLlmClient(ctx, route);
  const { pending, sessionJobs, queueArchived, archiveRecoveryIssues } = createArchiveCoordinator({
    hubRoot, config, clientFor, compactionCoordinator, workerLlmCallContext });
  const midSession = resolveMidSessionPolicy(config.autopilot);
  const turnRuntime = midSession.enabled ? createHubTurnRuntime({
    async handleMemoryInput(sessionId, text, turn, current) {
      const args = memoryReply(text);
      if (!args) return null;
      await sessionJobs.get(sessionId);
      if (!current()) return '已取消；未确认记忆。';
      if (args[0] === null) {
        const id = (turn - 1) + '.1';
        const last = turn > 0 && readMemoryReview(hubRoot, sessionId, id);
        if (!last || last.scopes.length !== 2 || readMemoryReview(hubRoot, sessionId, (turn - 1) + '.2')) return null;
        args[0] = id;
      }
      return memoryCommand(hubRoot, sessionId, args).text;
    },
    ask: request => ctx.get?.('userQuestions')?.ask(request),
    hubRoot, policy: midSession, taskHeat, clientFor, maxTailChars: config.maxTailChars ?? 6000,
    stripReminders: stripTrailingSystemReminders,
    onArchive: queueArchived
  }) : null;
  const routeForTurn = (sessionId, turn) => {
    const entry = modelRoutes.get(sessionId);
    return entry && (entry.turn == null || entry.turn === turn) ? entry.route : null;
  };
  const sessionIdFrom = payload => payload?.agent?.session?.id ?? payload?.session?.id ?? payload?.sessionId ?? null;
  const cwdFrom = payload => payload?.agent?.session?.header?.cwd ?? payload?.session?.header?.cwd ?? payload?.header?.cwd ?? null;
  const stateFor = sessionId => {
    const scoped = turnRuntime?.sessions.get(sessionId);
    return scoped ? { ...scoped, taskId: scoped.selectedTaskId }
      : sessions.get(sessionId) ?? { selectedProjectId: null, taskId: null, route: null, cwdHint: null, bindingSource: null };
  };
  function setExplicitCheckout(sessionId, task, source) {
    const binding = writeSessionBinding(hubRoot, sessionId, { project_id: task.project_id, task_id: task.id, source });
    if (turnRuntime) turnRuntime.syncBinding(sessionId, binding);
    else sessions.set(sessionId, { ...stateFor(sessionId), selectedProjectId: task.project_id, taskId: task.id, bindingSource: source,
      route: { result: 'explicit_binding', elapsed_ms: 0 } });
  }
  function clearCheckout(sessionId) {
    clearSessionBinding(hubRoot, sessionId);
    sessions.delete(sessionId);
    turnRuntime?.syncBinding(sessionId);
  }
  function clearTaskSessionState(taskId) {
    for (const [sessionId, state] of sessions) {
      if (state.taskId !== taskId) continue;
      sessions.set(sessionId, { ...state, taskId: null, bindingSource: null, route: { result: 'task_lifecycle_changed', elapsed_ms: 0 } });
    }
    for (const [sessionId, state] of turnRuntime?.sessions ?? []) {
      if (state.selectedTaskId === taskId) turnRuntime.syncBinding(sessionId);
    }
  }
  function readStatus() {
    const tasks = readHubTasksIndex(hubRoot).tasks;
    return {
      initialized: isHubInitialized(hubRoot),
      ...(archiveRecoveryIssues.length && { archive_recovery_issues: archiveRecoveryIssues }),
      projects: readProjectsIndex(hubRoot).projects.length,
      tasks: tasks.length,
      active_tasks: tasks.filter(task => task.status === 'active').length
    };
  }

  if (ctx.systemPrompt?.context) {
    const pairs = new WeakMap();
    const pairFor = (id, state) => captureCompatibilityContext(hubRoot, { state, sessionId: id,
      unresolved: routingUnresolved(state), taskHeat, maxTailChars: config.maxTailChars ?? 6000 });
    const stop = ctx.systemPrompt.context({ name: 'cairn:user-and-global-catalog', order: 300, interpolate: false, text: context => {
      if (turnRuntime) return HUB_TURN_CONTRACT;
      const id = sessionIdFrom(context), state = sessions.get(id);
      const pair = pairFor(id, state);
      if (state) pairs.set(state, pair);
      return pair.base;
    } });
    if (typeof stop === 'function') disposers.push(stop);
    const stopProject = ctx.systemPrompt.context({ name: 'cairn:locked-project-context', order: 310, interpolate: false, text: context => {
      const id = sessionIdFrom(context);
      if (turnRuntime) return id ? turnRuntime.context(id) : '';
      const state = sessions.get(id);
      if (!state) return '';
      const pair = pairs.get(state) ?? pairFor(id, state);
      pairs.delete(state);
      return pair.local;
    } });
    if (typeof stopProject === 'function') disposers.push(stopProject);
  }

  if (typeof ctx.on === 'function') {
    if (turnRuntime) {
      const stop = installFileWriteHook(ctx, hubRoot, turnRuntime);
      if (typeof stop === 'function') disposers.push(stop);
    }
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
      if (turnRuntime) {
        await turnRuntime.preStep(sessionId, payload, cwdFrom(payload));
        if (payload.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
        return decision;
      }
      if (currentTurn && currentTurn.turn === turnNumber && !currentTurn.modelRoute) currentTurn.modelRoute = routeForTurn(sessionId, turnNumber);
      if (readHubTasksIndex(hubRoot).task_id_capacity) return decision;
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
      if ((!taskHeat.enabled && !isHubContinuation(userPrompt) && !tasks.some(task => task.status === 'active')) || (!tasks.length && !userPrompt)) {
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
        state = { ...state, selectedProjectId, taskId: null, cwdHint: cwdHint?.project_id ?? null, bindingSource: null,
          route: { result: result.ok ? result.decision : 'error', error_code: result.error_code, elapsed_ms: elapsed, turn: turnNumber } };
        if (selectedProjectId && tasks.length) { initHubStore(hubRoot); writeSessionBinding(hubRoot, sessionId, { project_id: selectedProjectId, task_id: null, source: 'cwd_new' }); }
      }
      sessions.set(sessionId, state);
      return decision;
    }, { global: true });
    if (typeof stopPreStep === 'function') disposers.push(stopPreStep);
    {
      const stopStream = ctx.on('llm/stream', (request, next) => {
        const entry = turnRuntime?.turns.get(request?.sessionId);
        if (request?.purpose === 'compaction') {
          const excluded = readConsistentHub(hubRoot, () => {
            const projectId = entry ? entry.scope?.projectId : request.sessionId && readSessionBinding(hubRoot, request.sessionId)?.project_id;
            return exclusionWatchlist(readScopedHead(hubRoot), projectId && readScopedHead(hubRoot, { scope: 'project', projectId }));
          });
          const directive = [buildStrictCompactorPrompt(), excluded,
            'Earlier task checkouts are historical. Do not merge task progress across scopes or carry old project rules into the next task.'].filter(Boolean).join('\n\n');
          const messages = appendCompactionDirective(request.messages, directive);
          // rc.5's terminal waterfall callback closes over this options object, not next(arg).
          // Its auxiliary request is mutable; only replace the array, never a journal message.
          if (Object.isFrozen(request)) return next({ ...request, messages });
          request.messages = messages;
          return next(request);
        }
        const blocked = !request?.purpose && turnRuntime?.blockedReply(request?.sessionId);
        if (blocked) return menuStream(blocked, config.stripMarkerInStream === false);
        if (!request?.purpose && (!entry?.scope || entry.signal !== request.signal) && readHubTasksIndex(hubRoot).task_id_capacity)
          return menuStream('扩展任务号需要有效 Autopilot TurnScope，本轮不执行或归档。', config.stripMarkerInStream === false);
        if (!request?.purpose && midSession.historyMode === 'separate-session' &&
            (!entry?.scope || entry.signal !== request.signal))
          return menuStream('无法验证本轮历史。请在新的 dsh 会话中重述请求。', config.stripMarkerInStream === false);
        const stream = next(request);
        const compat = !turnRuntime && turns.get(request?.sessionId);
        if (!request?.purpose && compat && config.stripMarkerInStream !== false && stream?.[Symbol.asyncIterator]) {
          return hideHubStreamMarker(stream, compat);
        }
        if (request?.purpose || !entry?.scope || entry.signal !== request.signal) return stream;
        const input = turnRuntime.userText(entry);
        const footer = memoryNotice(splitMemoryIntent(input, entry.scope.projectId).cards, entry.turn);
        const strip = config.stripMarkerInStream !== false;
        return strip || footer ? hideHubStreamMarker(stream, entry, { strip, footer }) : stream;
      }, { prepend: true, global: true });
      if (typeof stopStream === 'function') disposers.push(stopStream);
    }
    const stopFlush = ctx.on('session/flush', async session => {
      const id = session?.id ?? session?.sessionId;
      if (id && workerLlmCallContext.getStore()?.sessionId === id) return;
      if (id && sessionJobs.has(id)) await sessionJobs.get(id);
      await compactionCoordinator.flush();
    }, { global: true });
    if (typeof stopFlush === 'function') disposers.push(stopFlush);
    const stopDisposed = ctx.on('session/disposed', async session => { const id = session?.id ?? session?.sessionId; if (id && sessionJobs.has(id)) await sessionJobs.get(id); if (id) { sessions.delete(id); turns.delete(id); modelRoutes.delete(id); turnRuntime?.turns.delete(id); turnRuntime?.sessions.delete(id); } }, { global: true });
    if (typeof stopDisposed === 'function') disposers.push(stopDisposed);
    const stopEvent = ctx.on('session/event', (session, event) => {
      const sessionId = session?.id ?? session?.sessionId;
      if (!sessionId || !event?.type) return;
      if (turnRuntime) {
        try { turnRuntime.event(sessionId, event); } catch {
          if (event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn)) {
            recordTurnReceipt(hubRoot, sessionId, event.data.turn, { status: 'unassigned', reason: 'archive_failed', end_seq: event.seq ?? null });
          }
        }
        return;
      }
      const turn = event.type === 'turn/start' || !turns.has(sessionId)
        ? { turn: event.data?.turn ?? 1, firstSeq: event.seq, user: '', authoredUser: '', assistant: '', tools: [],
          step: 1, streamMarkers: new Map(), toolNames: new Map(), modelRoute: routeForTurn(sessionId, event.data?.turn ?? 1) }
        : turns.get(sessionId);
      collectToolEvidence(turn, event);
      if (event.type === 'turn/start') {
        const pin = readSessionBinding(hubRoot, sessionId);
        if (pin?.task_id) turn.toolScope = { taskId: pin.task_id, projectId: pin.project_id, bindingEpoch: pin.binding_epoch };
      }
      if (turn.toolScope && stateFor(sessionId).taskId === turn.toolScope.taskId) {
        persistToolFact(hubRoot, sessionId, turn, turn.toolScope, event);
      }
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const message = event.data?.message ?? event.data;
        const content = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map(block => block?.text ?? '').join('\n') : '';
        if (event.type === 'user/message') {
          const source = message?.source?.kind ?? event.data?.source?.kind;
          const clean = stripTrailingSystemReminders(content);
          if (!source || source === 'user') turn.user += `\n${clean}`;
          if (source === 'user' && (event.surfaceOp === undefined || event.surfaceOp === 'append')) turn.authoredUser += `\n${clean}`;
        }
        else {
          const saved = turn.streamMarkers.get(turn.step);
          turn.streamMarkers.delete(turn.step);
          const text = textOf(message);
          turn.assistant += '\n' + (saved?.display_text === text.trim() && !event.data?.interrupted ? saved.rawText : text);
          turn.finalSeq = event.seq;
        }
      }
      turns.set(sessionId, turn);
      if (event.type !== 'turn/end') return;
      const state = stateFor(sessionId);
      const marker = parseTaskMarker(turn.assistant.trim());
      turns.delete(sessionId);
      const receipt = (status, reason, extra) => recordTurnReceipt(hubRoot, sessionId, turn.turn, {
        status, reason, first_seq: turn.firstSeq ?? null, end_seq: event.seq ?? null, ...extra
      });
      if (event.data?.reason?.kind && event.data.reason.kind !== 'completed') {
        if (turn.authoredUser.trim()) receipt('interrupted', 'not_completed');
        return;
      }
      if (readHubTasksIndex(hubRoot).task_id_capacity) return receipt('unassigned', 'marker_bank_requires_turn_scope');
      if (routingUnresolved(state) || !marker.valid || marker.is_unresolved) {
        if (!turn.authoredUser.trim()) return;
        if (routingUnresolved(state) || marker.is_unresolved) return receipt('unassigned', 'unresolved');
        if (marker.display_text.includes('<|task:')) return receipt('unassigned', 'marker_invalid');
        return receipt('unassigned', 'marker_missing', { project_id: state.selectedProjectId ?? null,
          final_seq: turn.finalSeq ?? null, source_digest: turnSourceDigest(turn.authoredUser.trim(), marker.display_text) });
      }
      const taskId = marker.task_number;
      try {
        initHubStore(hubRoot);
        const projectHint = resolveGitProjectHint(cwdFrom(session));
        const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === taskId);
        if (task && task.project_id !== (state.selectedProjectId ?? null)) return receipt('unassigned', 'project_mismatch');
        const projectId = state.selectedProjectId ?? null;
        const job = {
          taskId, projectId, sessionId, turn: turn.turn, user: turn.user.trim(), assistant: marker.answer,
          activity: Boolean(turn.authoredUser.trim()), tools: turn.tools, authoredUser: turn.authoredUser,
          ...(!task && { createTask: { id: taskId, project_id: projectId, project: projectHint?.project_id === projectId ? projectHint : null,
            title: turn.user.trim().slice(0, 120) || `Task ${taskId}`,
            creation_turn_key: crypto.createHash('sha256').update(JSON.stringify([sessionId, turn.turn])).digest('hex') } }),
          extractUserDefault: Boolean(projectId && explicitUserDefaults(turn.authoredUser)),
          route: turn.modelRoute ?? routeForTurn(sessionId, turn.turn), midSession: false,
          expectedEpoch: readSessionBinding(hubRoot, sessionId, { includeCleared: true })?.binding_epoch ?? null,
          bindingEpoch: crypto.randomUUID(), bindingSource: state.bindingSource ?? 'task_marker',
          receiptFields: { first_seq: turn.firstSeq ?? null, end_seq: event.seq ?? null },
          sourceStep: `turn_${turn.turn}`
        };
        const result = archiveHubTurn(hubRoot, job);
        if (!result.job) return;
        state.taskId = taskId; state.bindingSource = state.bindingSource ?? 'task_marker'; sessions.set(sessionId, state);
        queueArchived(result.job);
      } catch { receipt('unassigned', 'archive_failed'); }
    }, { global: true });
    if (typeof stopEvent === 'function') disposers.push(stopEvent);
  }

  const commands = ctx.get?.('commands') ?? ctx.commands;
  if (ctx.tools?.register) {
    const definitions = [
      { name: 'cairn_status', description: 'Read-only status of the centralized Cairn Hub.', parameters: { type: 'object', properties: {} }, async execute() { return JSON.stringify(readStatus()); } },
      { name: 'cairn_tasks', description: 'List active tasks and their derived routing pools in the centralized Cairn Hub.', parameters: { type: 'object', properties: {} }, async execute() { return JSON.stringify(taskList('active')); } },
      { name: 'cairn_checkout', description: 'Preview or bind a task to this session. HUMAN AUTHORITY RED LINE: only bind when explicitly instructed.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, preview: { type: 'boolean' }, clear: { type: 'boolean' } } }, async execute(args = {}, runCtx = {}) { const id = runCtx.agent?.session?.id; if (!id) return 'session_id_unavailable'; if (args.clear) { clearCheckout(id); return 'Session checkout cleared.'; } const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === args.task_id); if (!task) return `task_not_found:${args.task_id}`; if (args.preview) return compileHubHandoff({ hubRoot, taskId: task.id }).text; if (task.status !== 'active') return `task_not_active:${task.id}; reopen first`; setExplicitCheckout(id, task, 'tool_checkout'); return `Checked out task ${task.id}.`; } },
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
    const stop = commands.register({ name: 'cairn', description: 'Manage centralized Cairn Hub state', input: { hint: 'status | turns [turn] | recover <turn> <task-id> | tasks [--all|--status <status>] | inspect | doctor | checkout <id|--clear> [--preview] | undo <user|project [id]> <seq> [--preview] <reason>' }, async handler({ rawInput, agent }) {
      const args = String(rawInput ?? '').trim().split(/\s+/u).filter(Boolean);
      if (!args.length) args.push('status');
      const sessionId = agent?.session?.id;
      if (midSession.enabled && args[0] === 'memory') {
        await sessionJobs.get(sessionId);
        return memoryCommand(hubRoot, sessionId, args.slice(1));
      }
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
        if (args[1] === '--clear' && args.length !== 2) return { kind: 'error', text: 'Use checkout --clear without other arguments' };
        if (args[1] === '--clear') { clearCheckout(sessionId); return { kind: 'success', text: 'Session checkout cleared.' }; }
        const id = Number(args[1]);
        const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === id);
        if (!task) return { kind: 'error', text: `task_not_found:${id}` };
        if (task.status !== 'active' && !args.includes('--preview')) return { kind: 'error', text: `task_not_active:${id}; reopen first` };
        if (args.includes('--preview')) return { kind: 'success', text: compileHubHandoff({ hubRoot, taskId: id }).text };
        setExplicitCheckout(sessionId, task, 'slash_checkout');
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
      if (args[0] === 'recover') {
        if (!sessionId || args.length !== 3 || !args.slice(1).every(arg => /^\d+$/u.test(arg))) return { kind: 'error', text: 'Use recover <turn> <task-id> in the original session.' };
        const turn = Number(args[1]), taskId = Number(args[2]);
        try {
          const receipt = readTurnReceipts(hubRoot, sessionId, turn);
          const origin = receipt?.original_turn != null ? readTurnReceipts(hubRoot, sessionId, receipt.original_turn) : null;
          const source = receipt?.reason === 'marker_missing' ? recoverJournalText(agent.session, receipt, stripTrailingSystemReminders, origin) : null;
          recoverMarkerlessTurn(hubRoot, sessionId, turn, taskId, source);
          return { kind: 'success', text: 'Recovered task history only; binding and ledgers unchanged.' };
        } catch (error) { return { kind: 'error', text: error.message }; }
      }
      if (args[0] === 'turns') {
        if (!sessionId || args.length > 2 || (args[1] && !/^\d+$/u.test(args[1]))) return { kind: 'error', text: 'Use turns [turn] in a session.' };
        const receipts = readTurnReceipts(hubRoot, sessionId, args[1] ? Number(args[1]) : null);
        return { kind: receipts === null ? 'error' : 'success', text: JSON.stringify(receipts, null, 2) };
      }
      if (args[0] === 'doctor') {
        const report = runHubDoctor({ hubRoot });
        return { kind: report.ok ? 'success' : 'error', text: JSON.stringify(report, null, 2) };
      }
      if (args[0] === 'status') return { kind: 'success', text: JSON.stringify(readStatus(), null, 2) };
      if (args[0] === 'init') return { kind: 'success', text: JSON.stringify(initHubStore(hubRoot)) };
      if (args[0] === 'commit' || args[0] === 'drop') {
        const [command, scope] = args;
        const projectId = scope === 'project' ? args[2] : null;
        const offset = scope === 'project' ? 3 : 2;
        const proposalId = args[offset];
        if (!['user', 'project'].includes(scope) || (scope === 'project' && !projectId) ||
            args.length > offset + 1 || (proposalId && !/^stg_[1-9]\d*$/u.test(proposalId))) {
          return { kind: 'error', text: 'Use ' + command + ' <user|project <id>> [stg_<id>]' };
        }
        try {
          const result = await writeCoordinator.run({ scope, projectId }, () => command === 'commit'
            ? commitScopedStaged(hubRoot, { scope, projectId, proposal_id: proposalId })
            : dropScopedStaged(hubRoot, { scope, projectId, proposal_id: proposalId }));
          const ok = command === 'commit' ? ['committed', 'nothing_to_commit'].includes(result.reason) : !proposalId || result.dropped;
          return { kind: ok ? 'success' : 'error', text: JSON.stringify(result) };
        } catch (error) { return { kind: 'error', text: error.message }; }
      }
      if (['close', 'archive', 'reopen'].includes(args[0])) {
        if (args.length !== 2 || !/^[1-9]\d{0,5}$/u.test(args[1])) return { kind: 'error', text: 'Use ' + args[0] + ' <task-id>' };
        const taskId = Number(args[1]);
        try {
          const result = transitionHubTaskStatus(hubRoot, { taskId, action: args[0] });
          if (args[0] !== 'reopen') clearTaskSessionState(taskId);
          return { kind: 'success', text: JSON.stringify(result) };
        } catch (error) { return { kind: 'error', text: error.message }; }
      }
      if (args[0] === 'inspect') {
        const state = stateFor(sessionId);
        const fingerprint = state.selectedProjectId ? `ws_${crypto.createHash('sha256').update(state.selectedProjectId).digest('hex').slice(0, 8)}` : null;
        return { kind: 'success', text: JSON.stringify({ hub_initialized: isHubInitialized(hubRoot), workspace_fingerprint: fingerprint, cwd_hint_mode: state.cwdHint ? 'git_project_hint' : 'general', selected_project_fingerprint: fingerprint, binding_source: state.bindingSource, explicit_pin: state.explicitPin === true, pending_switch: state.pendingSwitch ?? null, last_route: state.route, auto_compaction: state.taskId ? compactionCoordinator.getTaskStatus(state.taskId) : { status: 'idle' }, session_id_present: Boolean(sessionId) }, null, 2) };
      }
      if (args[0] === 'tasks') {
        const showAll = args[1] === '--all' && args.length === 2;
        const filter = args[1] === '--status' && args.length === 3 ? args[2] : args.length === 1 ? 'active' : null;
        if (!showAll && !['active', 'done', 'archived'].includes(filter)) return { kind: 'error', text: 'Use tasks [--all|--status <active|done|archived>]' };
        return { kind: 'success', text: JSON.stringify(taskList(filter), null, 2) };
      }
      return { kind: 'error', text: 'Unknown Cairn subcommand: ' + args[0] };
    } });
    if (typeof stop === 'function') disposers.push(stop);
  }
  return { hubRoot, sessions: turnRuntime?.sessions ?? sessions, dispose: async () => { while (pending.size) await Promise.allSettled([...pending]); await Promise.all([compactionCoordinator.flush(), writeCoordinator.flush()]); for (const stop of disposers) { try { stop(); } catch {} } sessions.clear(); turns.clear(); modelRoutes.clear(); turnRuntime?.sessions.clear(); turnRuntime?.turns.clear(); } };
}
