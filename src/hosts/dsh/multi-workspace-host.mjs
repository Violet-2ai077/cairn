import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildAntiRecencyContract,
  buildAuthorityCheckoutContract,
  buildStrictCompactorPrompt,
  isCairnInitialized,
  parseTaskMarker,
  projectReadOnlyLedger,
  readHead,
  readStaged,
  readTasksIndex
} from '../../kernel/index.mjs';
import {
  buildGlobalExclusionWatchlistSection,
  compileTaskCheckout,
  createOpenAICompatibleClient,
  createTaskCompactionCoordinator,
  runColdRouter
} from '../../workers/index.mjs';
import { runCairnCli } from '../../../bin/cairn.mjs';
import { createTurnAccumulator } from './turn-accumulator.mjs';
import { resolveWorkspaceDirectory } from './workspace-runtime.mjs';

const TAIL_BUFFER_CHARS = 64;

function configOf(raw = {}) {
  const hasNewThreshold = raw.autoCompactMinRecords !== undefined || raw.autoCompactMinChars !== undefined;
  const hasLegacyThreshold = raw.autoCompactEveryTurns !== undefined;
  const legacyRecords = Number.isSafeInteger(raw.autoCompactEveryTurns) && raw.autoCompactEveryTurns > 0
    ? raw.autoCompactEveryTurns
    : 0;
  return {
    workspaceRoot: typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim() ? raw.workspaceRoot.trim() : null,
    actorId: typeof raw.actorId === 'string' && raw.actorId.trim() ? raw.actorId.trim() : 'dsh-host',
    stripMarkerInStream: typeof raw.stripMarkerInStream === 'boolean' ? raw.stripMarkerInStream : true,
    useHostLlm: typeof raw.useHostLlm === 'boolean' ? raw.useHostLlm : true,
    autoInitWorkspace: typeof raw.autoInitWorkspace === 'boolean' ? raw.autoInitWorkspace : true,
    workerProvider: typeof raw.workerProvider === 'string' && raw.workerProvider.trim() ? raw.workerProvider.trim() : '',
    workerModel: typeof raw.workerModel === 'string' && raw.workerModel.trim() ? raw.workerModel.trim() : '',
    workerApiBase: raw.workerApiBase ?? process.env.CAIRN_API_BASE ?? '',
    workerApiKey: raw.workerApiKey ?? process.env.CAIRN_API_KEY ?? '',
    autoCompactMinRecords: Number.isSafeInteger(raw.autoCompactMinRecords) && raw.autoCompactMinRecords >= 0
      ? raw.autoCompactMinRecords
      : hasNewThreshold ? 12 : hasLegacyThreshold ? legacyRecords : 12,
    autoCompactMinChars: Number.isSafeInteger(raw.autoCompactMinChars) && raw.autoCompactMinChars >= 0
      ? raw.autoCompactMinChars
      : hasNewThreshold ? 4500 : hasLegacyThreshold ? 0 : 4500,
    maxTailChars: Number.isSafeInteger(raw.maxTailChars) && raw.maxTailChars >= 0 ? raw.maxTailChars : 6000,
    autoCompactCooldownMs: Number.isSafeInteger(raw.autoCompactCooldownMs) && raw.autoCompactCooldownMs >= 0
      ? raw.autoCompactCooldownMs
      : 300000,
    coldRouterTimeoutMs: Number.isSafeInteger(raw.coldRouterTimeoutMs) && raw.coldRouterTimeoutMs > 0
      ? raw.coldRouterTimeoutMs
      : 5000,
    llmClient: raw.llmClient ?? null,
    onWorkerLog: typeof raw.onWorkerLog === 'function' ? raw.onWorkerLog : null
  };
}

function agentId(agent) {
  const id = agent?.id ?? agent?.session?.id;
  return typeof id === 'string' && id ? id : null;
}

function createDshLlmClient(ctx, config, getRoute, workerContext) {
  return Object.freeze({
    async complete({ system = '', messages = [], temperature = 0, maxTokens = 2048, reasoningEffort, signal } = {}) {
      const route = getRoute?.() ?? null;
      const provider = config.workerProvider || route?.provider || 'deepseek';
      const model = config.workerModel || route?.model || 'deepseek-chat';
      const requestMessages = [];
      if (system.trim()) requestMessages.push({ role: 'system', content: [{ type: 'text', text: system }] });
      for (const message of messages) {
        if (message && typeof message.role === 'string') {
          requestMessages.push({ role: message.role, content: [{ type: 'text', text: String(message.content ?? '') }] });
        }
      }
      const options = {
        provider,
        model,
        messages: requestMessages,
        temperature,
        maxTokens,
        purpose: 'cairn-worker',
        ...(route?.sessionId ? { sessionId: route.sessionId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(signal ? { signal } : {})
      };
      const startedAt = Date.now();
      try {
        const textParts = [];
        const reasoningParts = [];
        let blockEndText = null;
        for await (const chunk of ctx.llm.stream(options)) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') textParts.push(chunk.text);
          else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningParts.push(chunk.text);
          else if (chunk.type === 'block-end' && chunk.block?.type === 'text') blockEndText = chunk.block.text;
          else if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
            return {
              ok: false,
              error_code: chunk.reason.failure?.code ?? chunk.reason.kind,
              error_message: chunk.reason.failure?.message ?? `Host LLM stream ${chunk.reason.kind}`,
              status: chunk.reason.failure?.status ?? null,
              latency_ms: Date.now() - startedAt,
              transport_retries: 0
            };
          }
        }
        return {
          ok: true,
          content: textParts.length ? textParts.join('') : (blockEndText ?? ''),
          reasoning_content: reasoningParts.join(''),
          model,
          usage: null,
          latency_ms: Date.now() - startedAt,
          transport_retries: 0
        };
      } catch (error) {
        return {
          ok: false,
          error_code: 'host_llm_error',
          error_message: error?.message ?? String(error),
          status: null,
          latency_ms: Date.now() - startedAt,
          transport_retries: 0
        };
      }
    }
  });
}

function injectCompactionBoundary(messages, workspaceRoot) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const head = isCairnInitialized(workspaceRoot) ? readHead(workspaceRoot) : null;
  const watchlist = buildGlobalExclusionWatchlistSection(head);
  const addition = [buildStrictCompactorPrompt(), watchlist].filter(Boolean).join('\n\n');
  const nextMessages = [...messages];
  let target = -1;
  for (let i = nextMessages.length - 1; i >= 0; i--) {
    if (nextMessages[i]?.role === 'user') { target = i; break; }
  }
  if (target < 0) target = nextMessages.length - 1;
  const message = nextMessages[target];
  let content;
  if (typeof message.content === 'string') content = `${message.content}\n\n${addition}`;
  else if (Array.isArray(message.content)) {
    content = message.content.map((block, index) => index === message.content.length - 1 && block?.type === 'text'
      ? Object.freeze({ ...block, text: `${block.text}\n\n${addition}` })
      : block);
    if (!content.some(block => block?.type === 'text')) content.push(Object.freeze({ type: 'text', text: addition }));
    Object.freeze(content);
  } else content = Object.freeze([{ type: 'text', text: addition }]);
  nextMessages[target] = Object.freeze({ ...message, content });
  return Object.freeze(nextMessages);
}

function runCli(workspaceRoot, args) {
  const stdout = [];
  const stderr = [];
  const code = runCairnCli([...args, '--cwd', workspaceRoot], {
    cwd: workspaceRoot,
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line)
  });
  const text = [...stdout, ...stderr].filter(Boolean).join('\n').trim();
  return { code, text: text || (code === 0 ? 'OK' : 'Command failed') };
}

function toolDefinition(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render(_args, result) { return [{ type: 'text', text: String(result ?? '') }]; }
    },
    execute
  };
}

export async function createCairnDshHost(ctx, rawConfig = {}) {
  const config = configOf(rawConfig);
  const runtimes = new Map();
  const runtimeBySession = new Map();
  const workerLlmCallContext = new AsyncLocalStorage();
  const disposers = [];

  function sessionFor(sessionId, agent = null, directSession = null) {
    if (!sessionId) return null;
    const matches = session => session && String(session.id ?? '') === String(sessionId);
    if (matches(directSession)) return directSession;
    if (matches(agent?.session)) return agent.session;
    try {
      const found = ctx.sessions?.get?.(sessionId);
      if (matches(found)) return found;
    } catch { /* Optional/partial mock service. */ }
    try {
      const found = ctx.sessions?.list?.().find(matches);
      if (found) return found;
    } catch { /* Optional/partial mock service. */ }
    return null;
  }

  function runtimeForDirectory(directory, resolution, sessionId = null) {
    if (!directory?.ok) return null;
    let runtime = runtimes.get(directory.key);
    if (!runtime) {
      runtime = createRuntime(directory, resolution);
      runtimes.set(directory.key, runtime);
    }
    if (sessionId) {
      runtime.sessions.add(sessionId);
      runtimeBySession.set(sessionId, runtime);
    }
    return runtime;
  }

  function runtimeForSession(sessionId, { agent = null, session = null } = {}) {
    if (config.workspaceRoot) {
      const directory = resolveWorkspaceDirectory(config.workspaceRoot);
      return runtimeForDirectory(directory, 'explicit', sessionId);
    }
    if (!sessionId) return null;
    const existing = runtimeBySession.get(sessionId);
    if (existing) return existing;
    const liveSession = sessionFor(sessionId, agent, session);
    if (!liveSession || String(liveSession.id) !== String(sessionId)) return null;
    const directory = resolveWorkspaceDirectory(liveSession.header?.cwd);
    return runtimeForDirectory(directory, 'session_cwd', sessionId);
  }

  function unavailable(reason = 'workspace_unavailable') {
    return JSON.stringify({ ok: false, reason });
  }

  function createRuntime(directory, resolution) {
    const runtime = {
      ...directory,
      workspaceRoot: directory.root,
      workspaceResolution: resolution,
      sessions: new Set(),
      routesBySession: new Map(),
      routeStates: new Map(),
      checkoutSnapshots: new Map(),
      activeSnapshotTaskBySession: new Map(),
      sessionBindingSources: new Map(),
      lastObservedRoute: null,
      accumulator: null,
      compactionCoordinator: null
    };

    runtime.compactionCoordinator = createTaskCompactionCoordinator({
      workspaceRoot: runtime.workspaceRoot,
      cooldownMs: config.autoCompactCooldownMs
    });

    function isActiveTask(tasksIndex, taskId) {
      return Number.isSafeInteger(taskId) && taskId > 0 &&
        tasksIndex.tasks.some(task => task.id === taskId && task.status === 'active');
    }

    function activeAnchor(tasksIndex) {
      return isActiveTask(tasksIndex, tasksIndex.work_anchor_task_id) ? tasksIndex.work_anchor_task_id : null;
    }

    function resolveWorkerClient(sessionId = null) {
      if (config.llmClient) return config.llmClient;
      if (!config.useHostLlm || config.workerApiKey) {
        return createOpenAICompatibleClient({
          ...(config.workerApiBase ? { apiBase: config.workerApiBase } : {}),
          ...(config.workerApiKey ? { apiKey: config.workerApiKey } : {}),
          ...(config.workerModel ? { model: config.workerModel } : {})
        });
      }
      if (ctx.llm && typeof ctx.llm.stream === 'function') {
        const client = createDshLlmClient(ctx, config, () => runtime.routesBySession.get(sessionId) ??
          (runtime.lastObservedRoute?.sessionId === sessionId ? runtime.lastObservedRoute : null));
        return Object.freeze({
          complete(options) {
            return workerLlmCallContext.run(String(sessionId ?? ''), () => client.complete(options));
          }
        });
      }
      return createOpenAICompatibleClient();
    }

    function canAutoCompact(sessionId) {
      if (config.llmClient || config.workerApiKey) return true;
      const route = runtime.routesBySession.get(sessionId) ??
        (runtime.lastObservedRoute?.sessionId === sessionId ? runtime.lastObservedRoute : null);
      return Boolean(config.useHostLlm && ctx.llm?.stream && route?.provider && route?.model);
    }

    runtime.accumulator = createTurnAccumulator({
      workspaceRoot: runtime.workspaceRoot,
      actorId: config.actorId,
      autoInitWorkspace: config.autoInitWorkspace,
      getLlmClient: resolveWorkerClient,
      autoCompactMinRecords: config.autoCompactMinRecords,
      autoCompactMinChars: config.autoCompactMinChars,
      maxTailChars: config.maxTailChars,
      compactionCoordinator: runtime.compactionCoordinator,
      canAutoCompact,
      resolveBoundTaskId(sessionId) {
        if (!isCairnInitialized(runtime.workspaceRoot)) return null;
        const tasks = readTasksIndex(runtime.workspaceRoot);
        const anchor = activeAnchor(tasks);
        if (anchor !== null) return anchor;
        const route = runtime.routeStates.get(sessionId);
        if (route?.result === 'ambiguous') return false;
        if (route?.result === 'match' && isActiveTask(tasks, route.taskId)) return route.taskId;
        return null;
      },
      onWorkerLog: config.onWorkerLog
    });

    runtime.snapshotFor = (sessionId, taskId, refresh = false) => {
      const key = `${sessionId ?? 'default'}:${taskId}`;
      if (!refresh && runtime.checkoutSnapshots.has(key)) return runtime.checkoutSnapshots.get(key);
      const value = compileTaskCheckout({ workspaceRoot: runtime.workspaceRoot, taskId });
      runtime.checkoutSnapshots.set(key, value);
      return value;
    };

    runtime.checkoutFor = (sessionId, taskId) => {
      const switched = runtime.activeSnapshotTaskBySession.has(sessionId) &&
        runtime.activeSnapshotTaskBySession.get(sessionId) !== taskId;
      runtime.activeSnapshotTaskBySession.set(sessionId, taskId);
      return runtime.snapshotFor(sessionId, taskId, switched);
    };

    runtime.resolveActiveTaskId = (explicitTaskId, sessionId) => {
      const tasks = readTasksIndex(runtime.workspaceRoot);
      if (Number.isSafeInteger(explicitTaskId) && explicitTaskId > 0) {
        return isActiveTask(tasks, explicitTaskId) ? explicitTaskId : null;
      }
      const current = sessionId ? runtime.accumulator.getLastTaskId(sessionId, { allowFallback: false }) : null;
      if (isActiveTask(tasks, current)) return current;
      const anchor = activeAnchor(tasks);
      const route = runtime.routeStates.get(sessionId);
      return anchor ?? (route?.result === 'match' && isActiveTask(tasks, route.taskId) ? route.taskId : null);
    };

    runtime.clearTaskRuntime = taskId => {
      runtime.accumulator.clearTaskBindings(taskId);
      for (const [sessionId, route] of runtime.routeStates) {
        if (route.taskId === taskId) {
          runtime.routeStates.delete(sessionId);
          runtime.sessionBindingSources.delete(sessionId);
        }
      }
      for (const [sessionId, binding] of runtime.sessionBindingSources) {
        if (binding.taskId === taskId) {
          runtime.sessionBindingSources.delete(sessionId);
          runtime.routeStates.delete(sessionId);
        }
      }
      for (const [sessionId, boundTaskId] of runtime.activeSnapshotTaskBySession) {
        if (boundTaskId === taskId) runtime.activeSnapshotTaskBySession.delete(sessionId);
      }
      for (const key of runtime.checkoutSnapshots.keys()) {
        if (key.endsWith(`:${taskId}`)) runtime.checkoutSnapshots.delete(key);
      }
      runtime.compactionCoordinator.clearTask(taskId);
    };

    runtime.clearSessionState = sessionId => {
      runtime.routeStates.delete(sessionId);
      runtime.sessionBindingSources.delete(sessionId);
      runtime.activeSnapshotTaskBySession.delete(sessionId);
      runtime.routesBySession.delete(sessionId);
      for (const key of runtime.checkoutSnapshots.keys()) {
        if (key.startsWith(`${sessionId}:`)) runtime.checkoutSnapshots.delete(key);
      }
    };

    runtime.inspect = sessionId => {
      if (!isCairnInitialized(runtime.workspaceRoot)) {
        return {
          workspace_fingerprint: `ws_${runtime.fingerprint}`,
          workspace_resolution: runtime.workspaceResolution,
          initialized: false,
          session_binding: { task_id: null, source: 'none' },
          last_cold_route: null,
          auto_compaction: { status: 'idle', task_id: null }
        };
      }
      const tasks = readTasksIndex(runtime.workspaceRoot);
      const anchor = activeAnchor(tasks);
      const sessionTask = runtime.accumulator.getLastTaskId(sessionId, { allowFallback: false });
      const route = runtime.routeStates.get(sessionId) ?? null;
      const routeTask = route?.taskId ?? null;
      const taskId = anchor ?? (isActiveTask(tasks, sessionTask) ? sessionTask : null) ??
        (isActiveTask(tasks, routeTask) ? routeTask : null);
      const binding = runtime.sessionBindingSources.get(sessionId);
      const source = taskId === null ? 'none' : binding?.taskId === taskId ? binding.source
        : anchor === taskId ? 'workspace_anchor'
          : route?.result === 'match' && routeTask === taskId ? 'cold_router_match'
            : runtime.accumulator.getBindingSource(sessionId) ?? 'task_marker';
      return {
        workspace_fingerprint: `ws_${runtime.fingerprint}`,
        workspace_resolution: runtime.workspaceResolution,
        initialized: true,
        session_binding: { task_id: taskId, source },
        last_cold_route: route ? {
          decision: route.result,
          ...(route.taskId ? { task_id: route.taskId } : {}),
          elapsed_ms: route.elapsed_ms ?? 0,
          ...(route.error_code ? { error_code: route.error_code } : {})
        } : null,
        auto_compaction: taskId !== null
          ? runtime.compactionCoordinator.getTaskStatus(taskId)
          : { status: 'idle', task_id: null }
      };
    };

    runtime.compact = async (taskId, sessionId, mode) => {
      const tasks = readTasksIndex(runtime.workspaceRoot);
      const task = tasks.tasks.find(entry => entry.id === taskId);
      if (!task) return { ok: false, skipped: true, reason: 'task_not_found', task_id: taskId };
      if (task.status !== 'active') {
        return { ok: false, skipped: true, reason: 'task_not_active', task_id: taskId, task_status: task.status };
      }
      const result = await runtime.compactionCoordinator.run({
        taskId,
        mode,
        source: 'manual',
        llmClient: resolveWorkerClient(sessionId)
      });
      if (result.ok && sessionId && isActiveTask(readTasksIndex(runtime.workspaceRoot), taskId)) {
        runtime.snapshotFor(sessionId, taskId, true);
        runtime.activeSnapshotTaskBySession.set(sessionId, taskId);
      }
      return result;
    };
    return runtime;
  }

  function clearRuntimeSession(runtime, sessionId) {
    runtime.accumulator.disposeSession(sessionId);
    runtime.clearSessionState(sessionId);
    runtime.sessions.delete(sessionId);
    runtimeBySession.delete(sessionId);
  }

  function readOnlyTaskContext(contextArg = {}) {
    const id = agentId(contextArg.agent);
    const runtime = runtimeForSession(id, { agent: contextArg.agent });
    if (!runtime || !isCairnInitialized(runtime.workspaceRoot)) return '';
    const tasksIndex = readTasksIndex(runtime.workspaceRoot);
    const sessionId = id;
    const anchor = tasksIndex.tasks.some(task => task.id === tasksIndex.work_anchor_task_id && task.status === 'active')
      ? tasksIndex.work_anchor_task_id
      : null;
    const sessionTaskId = runtime.accumulator.getLastTaskId(sessionId, { allowFallback: false });
    const routedTaskId = runtime.routeStates.get(sessionId)?.taskId ?? null;
    const isActive = taskId => Number.isSafeInteger(taskId) && tasksIndex.tasks.some(task => task.id === taskId && task.status === 'active');
    const activeTaskId = anchor ?? (isActive(sessionTaskId) ? sessionTaskId : null) ?? (isActive(routedTaskId) ? routedTaskId : null);
    const base = buildAntiRecencyContract({ tasks: tasksIndex.tasks, workAnchorTaskId: anchor });
    const notice = runtime.routeStates.get(sessionId)?.clarification ?? '';
    if (activeTaskId === null) return [base, notice].filter(Boolean).join('\n\n');
    const compiled = runtime.checkoutFor(sessionId, activeTaskId);
    return [base, compiled.ok && compiled.status !== 'empty'
      ? `<cairn_task_checkout task_id="${activeTaskId}">\n${compiled.text}\n</cairn_task_checkout>`
      : '', notice].filter(Boolean).join('\n\n');
  }

  function readOnlyLedgerContext(contextArg = {}) {
    const id = agentId(contextArg.agent);
    const runtime = runtimeForSession(id, { agent: contextArg.agent });
    if (!runtime || !isCairnInitialized(runtime.workspaceRoot)) return '';
    const head = readHead(runtime.workspaceRoot);
    const staged = readStaged(runtime.workspaceRoot);
    const parts = [buildAuthorityCheckoutContract(projectReadOnlyLedger(head, { includeTombstones: true }))];
    if (staged.proposals.length > 0) {
      const ids = staged.proposals.map(proposal => proposal.proposal_id).join(', ');
      parts.push(`[Cairn Notice: .cairn/staged.json currently holds ${staged.proposals.length} pending state proposal(s) (${ids}). They are awaiting human review and are NOT active until the user confirms via "/cairn commit" or CLI "cairn commit". Do NOT autonomously commit or drop staged proposals unless explicitly instructed by the user.]`);
    }
    return parts.join('\n\n');
  }

  if (config.workspaceRoot) runtimeForDirectory(resolveWorkspaceDirectory(config.workspaceRoot), 'explicit');

  if (ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
    const disposeTaskContext = ctx.systemPrompt.context({
      name: 'cairn:task-continuity', order: 300, interpolate: false, text: readOnlyTaskContext
    });
    if (typeof disposeTaskContext === 'function') disposers.push(disposeTaskContext);
    const disposeLedgerContext = ctx.systemPrompt.context({
      name: 'cairn:workspace-ledger', order: 310, interpolate: false, text: readOnlyLedgerContext
    });
    if (typeof disposeLedgerContext === 'function') disposers.push(disposeLedgerContext);
  }

  if (typeof ctx.on === 'function') {
    const disposeCreated = ctx.on('session/created', session => {
      runtimeForSession(String(session?.id ?? ''), { session });
    }, { global: true });
    if (typeof disposeCreated === 'function') disposers.push(disposeCreated);

    for (const session of ctx.sessions?.list?.() ?? []) {
      runtimeForSession(String(session?.id ?? ''), { session });
    }

    const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const sessionId = agentId(payload?.agent) ?? (typeof payload?.sessionId === 'string' ? payload.sessionId : null);
      if (!sessionId || payload?.signal?.aborted) {
        if (payload?.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
        return next();
      }
      const runtime = runtimeForSession(sessionId, { agent: payload.agent });
      if (!runtime) return next();
      const decision = await next();
      if (payload?.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
      if (decision?.kind !== 'enter') return decision;
      const selected = payload?.modelSelection;
      if (selected?.provider && selected?.model) {
        runtime.routesBySession.set(sessionId, { provider: selected.provider, model: selected.model, sessionId });
      }
      if (!isCairnInitialized(runtime.workspaceRoot)) {
        runtime.routeStates.set(sessionId, { terminal: true, result: 'new', reason: 'workspace_uninitialized', elapsed_ms: 0 });
        return decision;
      }
      const tasks = readTasksIndex(runtime.workspaceRoot);
      let state = runtime.routeStates.get(sessionId);
      const active = id => Number.isSafeInteger(id) && tasks.tasks.some(task => task.id === id && task.status === 'active');
      const anchor = active(tasks.work_anchor_task_id) ? tasks.work_anchor_task_id : null;
      if (anchor !== null) {
        runtime.snapshotFor(sessionId, anchor);
        runtime.activeSnapshotTaskBySession.set(sessionId, anchor);
        runtime.sessionBindingSources.set(sessionId, { taskId: anchor, source: 'workspace_anchor' });
        runtime.routeStates.set(sessionId, { terminal: true, result: 'anchor_bypass', taskId: anchor, elapsed_ms: 0 });
        return decision;
      }
      if (state?.result === 'anchor_bypass' || (state?.result === 'match' && !active(state.taskId))) {
        runtime.routeStates.delete(sessionId);
        runtime.sessionBindingSources.delete(sessionId);
        state = null;
      }
      if (state?.terminal) return decision;
      if (tasks.tasks.filter(task => task.status === 'active').length === 0) {
        runtime.routeStates.set(sessionId, { terminal: true, result: 'new', reason: 'empty_active_task_catalog', elapsed_ms: 0 });
        return decision;
      }
      if (!selected?.provider || !selected?.model) {
        runtime.routeStates.set(sessionId, { terminal: true, result: 'error' });
        return decision;
      }
      const userText = (payload.messages ?? []).filter(message => message?.source?.kind === 'user')
        .map(message => Array.isArray(message.content)
          ? message.content.map(block => block.text ?? '').join('')
          : String(message.content ?? '')).join('\n');
      const opening = state?.result === 'ambiguous' ? `${state.opening}\n${userText}` : userText;
      if (state?.result === 'ambiguous' && (state.retried || state.lastTurn === payload.turn)) return decision;
      const client = config.llmClient ?? createDshLlmClient(ctx, config, () => ({ ...selected, sessionId }));
      const startedAt = Date.now();
      const controller = new AbortController();
      let timer;
      let removeAbort = () => {};
      let result;
      try {
        const timeout = new Promise(resolve => {
          timer = setTimeout(() => {
            controller.abort(new Error('cold_router_timeout'));
            resolve({ ok: false, decision: null, error_code: 'timeout', error: 'Cold router timed out' });
          }, config.coldRouterTimeoutMs);
        });
        const externalAbort = new Promise((_, reject) => {
          if (!payload.signal) return;
          const onAbort = () => reject(payload.signal.reason ?? new Error('Aborted'));
          payload.signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => payload.signal.removeEventListener('abort', onAbort);
        });
        result = await Promise.race([
          runColdRouter({
            workspaceRoot: runtime.workspaceRoot,
            userPrompt: opening,
            applyWorkAnchor: false,
            llmClient: client,
            signal: AbortSignal.any([payload.signal, controller.signal].filter(Boolean))
          }),
          timeout,
          externalAbort
        ]);
      } catch (error) {
        if (payload.signal?.aborted) throw payload.signal.reason ?? error;
        result = { ok: false, decision: null, error: error?.message ?? String(error) };
      } finally {
        clearTimeout(timer);
        removeAbort();
      }
      if (payload.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
      const elapsedMs = Date.now() - startedAt;
      if (!result.ok) {
        runtime.routeStates.set(sessionId, { terminal: true, result: 'error', error_code: result.error_code ?? 'router_error', elapsed_ms: elapsedMs });
        return decision;
      }
      if (result.decision === 'ambiguous') {
        const nextState = { result: 'ambiguous', opening: state?.opening ?? userText, retried: Boolean(state), lastTurn: payload.turn, elapsed_ms: elapsedMs };
        nextState.clarification = 'Cairn 找到多个可能的既有任务。请用户说明当前请求对应哪个任务；在澄清前不注入任何任务历史。';
        runtime.routeStates.set(sessionId, nextState);
        return decision;
      }
      runtime.routeStates.set(sessionId, {
        terminal: true,
        result: result.decision,
        taskId: result.decision === 'match' ? result.task_id : null,
        elapsed_ms: elapsedMs
      });
      if (result.decision === 'match') runtime.sessionBindingSources.set(sessionId, { taskId: result.task_id, source: 'cold_router_match' });
      return decision;
    }, { global: true });
    if (typeof disposePreStep === 'function') disposers.push(disposePreStep);

    const disposeStream = ctx.on('llm/stream', async function* (request, next) {
      const invoke = req => (typeof next === 'function' ? next(req) : next);
      if (request?.purpose === 'cairn-worker') {
        yield* invoke(request);
        return;
      }
      const sessionId = typeof request?.sessionId === 'string' && request.sessionId ? request.sessionId : null;
      const runtime = runtimeForSession(sessionId);
      if (!runtime) {
        yield* invoke(request);
        return;
      }
      if (request?.provider && request?.model && sessionId) {
        runtime.lastObservedRoute = { provider: request.provider, model: request.model, sessionId };
        runtime.routesBySession.set(sessionId, runtime.lastObservedRoute);
      }
      if (request?.purpose === 'compaction') {
        const messages = injectCompactionBoundary(request.messages, runtime.workspaceRoot);
        let effective = request;
        if (!Object.isFrozen(request)) request.messages = messages;
        else effective = Object.freeze({ ...request, messages });
        yield* invoke(effective);
        return;
      }
      if (!config.stripMarkerInStream) {
        yield* invoke(request);
        return;
      }

      const blocks = new Map();
      const ensure = index => {
        let state = blocks.get(index);
        if (!state) {
          state = { index, fullText: '', pendingTail: '', yieldedLen: 0, flushed: false };
          blocks.set(index, state);
        }
        return state;
      };
      function* flush(state) {
        if (!state || state.flushed) return;
        const parsed = parseTaskMarker(state.fullText);
        if (parsed.valid) runtime.accumulator.stashStreamMarker(sessionId, { rawText: state.fullText, parsed });
        const cleanText = parsed.valid ? parsed.display_text : state.fullText;
        const remainder = cleanText.slice(state.yieldedLen);
        if (remainder) yield { type: 'text-delta', index: state.index, text: remainder };
        state.yieldedLen = cleanText.length;
        state.pendingTail = '';
        state.flushed = true;
        state.cleanFullText = cleanText;
      }
      for await (const chunk of invoke(request)) {
        if (!chunk || typeof chunk !== 'object') { yield chunk; continue; }
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          const index = typeof chunk.index === 'number' ? chunk.index : 0;
          const state = ensure(index);
          if (state.flushed) continue;
          state.fullText += chunk.text;
          state.pendingTail += chunk.text;
          if (state.pendingTail.length > TAIL_BUFFER_CHARS) {
            const flushLength = state.pendingTail.length - TAIL_BUFFER_CHARS;
            const emitText = state.pendingTail.slice(0, flushLength);
            state.pendingTail = state.pendingTail.slice(flushLength);
            state.yieldedLen += emitText.length;
            yield { ...chunk, index, text: emitText };
          }
          continue;
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          const index = typeof chunk.index === 'number' ? chunk.index : 0;
          const state = blocks.get(index);
          let cleanText;
          if (state?.fullText) {
            yield* flush(state);
            cleanText = state.cleanFullText;
          } else {
            const rawText = String(chunk.block.text ?? '');
            const parsed = parseTaskMarker(rawText);
            if (parsed.valid) runtime.accumulator.stashStreamMarker(sessionId, { rawText, parsed });
            cleanText = parsed.valid ? parsed.display_text : rawText;
            if (state) state.flushed = true;
          }
          yield { ...chunk, block: { ...chunk.block, text: cleanText } };
          continue;
        }
        if (chunk.type === 'finish') {
          for (const state of blocks.values()) yield* flush(state);
        }
        yield chunk;
      }
      for (const state of blocks.values()) yield* flush(state);
    }, { prepend: true, global: true });
    if (typeof disposeStream === 'function') disposers.push(disposeStream);

    const disposeSessionEvent = ctx.on('session/event', (session, event) => {
      const sessionId = String(session?.id ?? '');
      const runtime = runtimeForSession(sessionId, { session });
      runtime?.accumulator.observeSessionEvent(session, event);
    }, { global: true });
    if (typeof disposeSessionEvent === 'function') disposers.push(disposeSessionEvent);

    const disposeSessionFlush = ctx.on('session/flush', async session => {
      const sessionId = String(session?.id ?? '');
      if (workerLlmCallContext.getStore() === sessionId) return;
      const runtime = runtimeForSession(sessionId, { session });
      if (runtime) await Promise.all([runtime.accumulator.flushPendingJobs(), runtime.compactionCoordinator.flush()]);
    }, { global: true });
    if (typeof disposeSessionFlush === 'function') disposers.push(disposeSessionFlush);

    const disposeSessionDisposed = ctx.on('session/disposed', session => {
      const sessionId = String(session?.id ?? '');
      const runtime = runtimeForSession(sessionId, { session });
      if (!runtime) { runtimeBySession.delete(sessionId); return; }
      const drain = Promise.all([runtime.accumulator.flushPendingJobs(), runtime.compactionCoordinator.flush()]);
      clearRuntimeSession(runtime, sessionId);
      return drain;
    }, { global: true });
    if (typeof disposeSessionDisposed === 'function') disposers.push(disposeSessionDisposed);
  }

  const currentRuntime = runCtx => runtimeForSession(agentId(runCtx?.agent), { agent: runCtx?.agent });
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const definitions = [
      toolDefinition('cairn_status', 'Inspect the current workspace Cairn ledger status.', { type: 'object', properties: {} }, async (_args, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        return runtime ? runCli(runtime.workspaceRoot, ['status']).text : unavailable();
      }),
      toolDefinition('cairn_tasks', 'List tasks in the current workspace.', { type: 'object', properties: {} }, async (_args, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        return runtime ? runCli(runtime.workspaceRoot, ['tasks']).text : unavailable();
      }),
      toolDefinition('cairn_commit', 'Commit pending Cairn proposals. HUMAN AUTHORITY RED LINE: only on explicit user instruction.', { type: 'object', properties: { proposal_id: { type: 'string' }, rebase: { type: 'boolean' } } }, async (args = {}, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        if (!runtime) return unavailable();
        const cliArgs = ['commit'];
        if (typeof args.proposal_id === 'string' && args.proposal_id.trim()) cliArgs.push(args.proposal_id.trim());
        if (args.rebase === true) cliArgs.push('--rebase');
        cliArgs.push('--actor', config.actorId);
        return runCli(runtime.workspaceRoot, cliArgs).text;
      }),
      toolDefinition('cairn_drop', 'Drop pending Cairn proposals. HUMAN AUTHORITY RED LINE: only on explicit user instruction.', { type: 'object', properties: { proposal_id: { type: 'string' } } }, async (args = {}, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        if (!runtime) return unavailable();
        return runCli(runtime.workspaceRoot, ['drop', ...(typeof args.proposal_id === 'string' && args.proposal_id.trim() ? [args.proposal_id.trim()] : [])]).text;
      }),
      toolDefinition('cairn_checkout', 'Set or clear task checkout. HUMAN AUTHORITY RED LINE: only on explicit user instruction.', { type: 'object', properties: { task_id: { type: 'integer' }, clear: { type: 'boolean' } } }, async (args = {}, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        if (!runtime) return unavailable();
        const sessionId = agentId(runCtx.agent);
        const result = runCli(runtime.workspaceRoot, args.clear ? ['checkout', '--clear'] : ['checkout', String(args.task_id)]);
        if (result.code === 0) {
          for (const id of runtime.sessions) runtime.clearSessionState(id);
          if (sessionId && !args.clear) runtime.sessionBindingSources.set(sessionId, { taskId: args.task_id, source: 'slash_checkout' });
        }
        return result.text;
      }),
      toolDefinition('cairn_compact', 'Compact a task-local history. HUMAN AUTHORITY RED LINE: only on explicit user instruction.', { type: 'object', properties: { task_id: { type: 'integer' }, full: { type: 'boolean' } } }, async (args = {}, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        if (!runtime) return unavailable();
        const sessionId = agentId(runCtx.agent);
        const taskId = Number.isSafeInteger(args.task_id) ? args.task_id : runtime.resolveActiveTaskId(null, sessionId);
        if (!taskId) return JSON.stringify({ ok: false, reason: 'no_active_task' });
        return JSON.stringify(await runtime.compact(taskId, sessionId, args.full ? 'full' : 'incremental'));
      })
    ];
    for (const action of ['close', 'archive', 'reopen']) {
      definitions.push(toolDefinition(`cairn_${action}_task`, `Change task lifecycle with ${action}. HUMAN AUTHORITY RED LINE: only on explicit user instruction.`, { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] }, async (args = {}, runCtx = {}) => {
        const runtime = currentRuntime(runCtx);
        if (!runtime) return unavailable();
        const result = runCli(runtime.workspaceRoot, [action, String(args.task_id)]);
        if (result.code === 0 && action !== 'reopen') runtime.clearTaskRuntime(args.task_id);
        return result.text;
      }));
    }
    for (const definition of definitions) {
      const disposeTool = ctx.tools.register(definition);
      if (typeof disposeTool === 'function') disposers.push(disposeTool);
    }
  }

  const commands = ctx.get?.('commands') ?? ctx.commands;
  if (commands && typeof commands.register === 'function') {
    const disposeCommand = commands.register({
      name: 'cairn',
      description: 'Manage Cairn workspace state and task continuity.',
      input: { hint: 'init | tasks [--all|--status <state>] | close|archive|reopen <id> | checkout <id|--clear> [--preview] | compact [id] [--full] | status | inspect | doctor | log | commit | drop' },
      async handler({ rawInput, agent }) {
        const sessionId = agentId(agent);
        const runtime = runtimeForSession(sessionId, { agent });
        if (!runtime) return { kind: 'error', text: unavailable() };
        const tokens = String(rawInput ?? '').trim().split(/\s+/u).filter(Boolean);
        const cliArgs = tokens.length ? tokens : ['status'];
        if (cliArgs[0] === 'checkout') {
          const out = runCli(runtime.workspaceRoot, cliArgs);
          if (out.code === 0 && sessionId) {
            runtime.clearSessionState(sessionId);
            if (cliArgs[1] && cliArgs[1] !== '--clear' && !cliArgs.includes('--preview')) {
              runtime.sessionBindingSources.set(sessionId, { taskId: Number(cliArgs[1]), source: 'slash_checkout' });
            }
          }
          return { kind: out.code === 0 ? 'success' : 'error', text: out.text };
        }
        if (cliArgs[0] === 'compact') {
          const explicitId = cliArgs[1] && !cliArgs[1].startsWith('--') ? Number(cliArgs[1]) : null;
          const taskId = explicitId ?? runtime.resolveActiveTaskId(null, sessionId);
          if (!taskId) return { kind: 'error', text: 'No active task selected.' };
          const result = await runtime.compact(taskId, sessionId, cliArgs.includes('--full') ? 'full' : 'incremental');
          return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
        }
        if (['close', 'archive', 'reopen'].includes(cliArgs[0])) {
          const id = Number(cliArgs[1]);
          const out = runCli(runtime.workspaceRoot, cliArgs);
          if (out.code === 0 && cliArgs[0] !== 'reopen') runtime.clearTaskRuntime(id);
          return { kind: out.code === 0 ? 'success' : 'error', text: out.text };
        }
        if (cliArgs[0] === 'inspect') {
          return { kind: 'success', text: JSON.stringify(runtime.inspect(sessionId), null, 2) };
        }
        const result = runCli(runtime.workspaceRoot, cliArgs);
        return { kind: result.code === 0 ? 'success' : 'error', text: result.text };
      }
    });
    if (typeof disposeCommand === 'function') disposers.push(disposeCommand);
  }

  return Object.freeze({
    config,
    get accumulator() {
      return config.workspaceRoot ? runtimeForSession(null)?.accumulator : undefined;
    },
    getLastObservedRoute(sessionId) {
      const runtime = sessionId ? runtimeBySession.get(sessionId) : (config.workspaceRoot ? runtimeForSession(null) : null);
      return runtime?.lastObservedRoute ?? null;
    },
    getRuntime(sessionId) { return runtimeBySession.get(sessionId) ?? null; },
    async dispose() {
      await Promise.all([...runtimes.values()].flatMap(runtime => [
        runtime.accumulator.flushPendingJobs(), runtime.compactionCoordinator.flush()
      ]));
      for (const dispose of disposers) {
        try { dispose(); } catch { /* Ignore individual teardown errors. */ }
      }
      for (const runtime of runtimes.values()) {
        runtime.routesBySession.clear();
        runtime.routeStates.clear();
        runtime.checkoutSnapshots.clear();
        runtime.activeSnapshotTaskBySession.clear();
        runtime.sessionBindingSources.clear();
        runtime.sessions.clear();
      }
      runtimeBySession.clear();
      runtimes.clear();
    }
  });
}
