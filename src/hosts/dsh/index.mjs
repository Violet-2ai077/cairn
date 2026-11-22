// Cairn Reference Host #1: DeepSeek Harness (dsh 0.2.2-rc.1 / Cordis 4.1.0) Plugin Adapter
// (src/hosts/dsh/index.mjs)
// Bridges Cairn Kernel & Workers into dsh lifecycle hooks:
// - ctx.systemPrompt.context: Anti-Recency contract, Light Task Catalog, Task compact.md, and Authority Checkout Ledger
// - ctx.on('llm/stream'): anti-reentrancy for 'cairn-worker', 64-char sliding-window tail marker stripping + block-end sync,
//   and immutable message cloning for `request.purpose === 'compaction'`
// - ctx.on('session/event') & ctx.on('session/disposed'): multi-step ReAct turn accumulation & serial async worker queue
// - ctx.tools.register & optional ctx.commands.register('/cairn'): human-authority-gated state management

import {
  isCairnInitialized,
  initCairnStore,
  readHead,
  projectReadOnlyLedger,
  readStaged,
  readTasksIndex,
  parseTaskMarker,
  buildAntiRecencyContract,
  buildAuthorityCheckoutContract,
  buildStrictCompactorPrompt
} from '../../kernel/index.mjs';
import {
  createOpenAICompatibleClient,
  buildGlobalExclusionWatchlistSection,
  compileTaskCheckout,
  runColdRouter,
  runStrictCompactor
} from '../../workers/index.mjs';
import { runCairnCli } from '../../../bin/cairn.mjs';
import { createTurnAccumulator } from './turn-accumulator.mjs';

export const name = 'cairn-dsh-host';

export const inject = ['systemPrompt', 'llm', 'tools'];

const TAIL_BUFFER_CHARS = 64;


export function resolveDshHostConfig(rawConfig = {}) {
  return Object.freeze({
    workspaceRoot: rawConfig.workspaceRoot ?? process.cwd(),
    actorId:
      typeof rawConfig.actorId === 'string' && rawConfig.actorId.trim()
        ? rawConfig.actorId.trim()
        : 'dsh-host',
    stripMarkerInStream:
      typeof rawConfig.stripMarkerInStream === 'boolean' ? rawConfig.stripMarkerInStream : true,
    useHostLlm: typeof rawConfig.useHostLlm === 'boolean' ? rawConfig.useHostLlm : true,
    workerProvider:
      typeof rawConfig.workerProvider === 'string' && rawConfig.workerProvider.trim()
        ? rawConfig.workerProvider.trim()
        : '',
    workerModel:
      typeof rawConfig.workerModel === 'string' && rawConfig.workerModel.trim()
        ? rawConfig.workerModel.trim()
        : '',
    workerApiBase: rawConfig.workerApiBase ?? process.env.CAIRN_API_BASE ?? '',
    workerApiKey: rawConfig.workerApiKey ?? process.env.CAIRN_API_KEY ?? '',
    autoCompactEveryTurns:
      typeof rawConfig.autoCompactEveryTurns === 'number' ? rawConfig.autoCompactEveryTurns : 0,
    coldRouterTimeoutMs:
      Number.isSafeInteger(rawConfig.coldRouterTimeoutMs) && rawConfig.coldRouterTimeoutMs > 0
        ? rawConfig.coldRouterTimeoutMs
        : 5000,
    llmClient: rawConfig.llmClient ?? null,
    onWorkerLog: typeof rawConfig.onWorkerLog === 'function' ? rawConfig.onWorkerLog : null
  });
}

/**
 * Adapts `ctx.llm.stream` into Cairn's `llmClient.complete()` interface
 * using `purpose: 'cairn-worker'` (which bypasses Cairn stream interception)
 * and zero-config fallback to the most recently observed conversation route.
 */
export function createDshHostLlmClient(ctx, config, getLastObservedRoute) {
  return Object.freeze({
    async complete({
      system = '',
      messages = [],
      temperature = 0,
      maxTokens = 2048,
      reasoningEffort,
      signal
    } = {}) {
      const startTime = Date.now();
      const observed = typeof getLastObservedRoute === 'function' ? getLastObservedRoute() : null;
      const provider = config.workerProvider || observed?.provider || 'deepseek';
      const model = config.workerModel || observed?.model || 'deepseek-chat';

      const dshMessages = [];
      if (typeof system === 'string' && system.trim().length > 0) {
        dshMessages.push({
          role: 'system',
          content: [{ type: 'text', text: system }]
        });
      }
      for (const m of messages) {
        if (!m || typeof m.role !== 'string') continue;
        const text = typeof m.content === 'string' ? m.content : '';
        dshMessages.push({
          role: m.role,
          content: [{ type: 'text', text }]
        });
      }

      const requestOptions = {
        provider,
        model,
        messages: dshMessages,
        temperature,
        maxTokens,
        purpose: 'cairn-worker',
        ...(observed?.sessionId ? { sessionId: observed.sessionId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(signal ? { signal } : {})
      };

      try {
        const textParts = [];
        const reasoningParts = [];
        let blockEndText = null;

        for await (const chunk of ctx.llm.stream(requestOptions)) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            textParts.push(chunk.text);
          } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            reasoningParts.push(chunk.text);
          } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
            blockEndText = chunk.block.text;
          } else if (
            chunk.type === 'finish' &&
            (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')
          ) {
            return {
              ok: false,
              error_code: chunk.reason.failure?.code ?? chunk.reason.kind,
              error_message: chunk.reason.failure?.message ?? `Host LLM stream ${chunk.reason.kind}`,
              status: chunk.reason.failure?.status ?? null,
              latency_ms: Date.now() - startTime,
              transport_retries: 0
            };
          }
        }

        const finalContent = textParts.length > 0 ? textParts.join('') : (blockEndText ?? '');
        return {
          ok: true,
          content: finalContent,
          reasoning_content: reasoningParts.join(''),
          model,
          usage: null,
          latency_ms: Date.now() - startTime,
          transport_retries: 0
        };
      } catch (err) {
        return {
          ok: false,
          error_code: 'host_llm_error',
          error_message: err?.message ?? String(err),
          status: null,
          latency_ms: Date.now() - startTime,
          transport_retries: 0
        };
      }
    }
  });
}

/**
 * Immutable helper that clones `request.messages` and appends Cairn's
 * COMPRESSOR_STRICT hard boundary & Global Ledger Exclusion Watchlist
 * to the final user compaction directive message without mutating deepFreeze-d messages.
 */
export function injectStrictBoundaryIntoCompactionMessages(messages, workspaceRoot) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const head = isCairnInitialized(workspaceRoot) ? readHead(workspaceRoot) : null;
  const strictPrompt = buildStrictCompactorPrompt();
  const watchlist = buildGlobalExclusionWatchlistSection(head);
  const boundaryDirective = watchlist ? `${strictPrompt}\n\n${watchlist}` : strictPrompt;

  const nextMessages = [...messages];
  let targetIdx = -1;
  for (let i = nextMessages.length - 1; i >= 0; i--) {
    if (nextMessages[i]?.role === 'user') {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) {
    targetIdx = nextMessages.length - 1;
  }

  const targetMsg = nextMessages[targetIdx];
  let nextContent;

  if (typeof targetMsg.content === 'string') {
    nextContent = `${targetMsg.content}\n\n${boundaryDirective}`;
  } else if (Array.isArray(targetMsg.content)) {
    nextContent = targetMsg.content.map((block, idx) => {
      if (idx === targetMsg.content.length - 1 && block?.type === 'text') {
        return Object.freeze({
          ...block,
          text: `${block.text}\n\n${boundaryDirective}`
        });
      }
      return block;
    });
    if (!nextContent.some(b => b?.type === 'text')) {
      nextContent.push(Object.freeze({ type: 'text', text: boundaryDirective }));
    }
    Object.freeze(nextContent);
  } else {
    nextContent = Object.freeze([{ type: 'text', text: boundaryDirective }]);
  }

  nextMessages[targetIdx] = Object.freeze({
    ...targetMsg,
    content: nextContent
  });

  return Object.freeze(nextMessages);
}

function executeCairnCliCommand(workspaceRoot, args) {
  const out = [];
  const err = [];
  const code = runCairnCli([...args, '--cwd', workspaceRoot], {
    cwd: workspaceRoot,
    stdout: line => out.push(line),
    stderr: line => err.push(line)
  });
  const text = [...out, ...err].filter(Boolean).join('\n').trim();
  return {
    code,
    text: text || (code === 0 ? 'OK' : 'Command failed')
  };
}

function createDshToolDefinition({ name: toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      }
    },
    execute
  };
}

export async function createCairnDshHost(ctx, rawConfig = {}) {
  const config = resolveDshHostConfig(rawConfig);
  const { workspaceRoot } = config;

  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }

  let lastObservedRoute = null;
  const disposers = [];
  const routesBySession = new Map();
  const routeStates = new Map();
  const checkoutSnapshots = new Map();
  const activeSnapshotTaskBySession = new Map();

  function resolveWorkerLlmClient(sessionId = null) {
    if (config.llmClient) {
      return config.llmClient;
    }
    if (!config.useHostLlm || config.workerApiKey) {
      return createOpenAICompatibleClient({
        ...(config.workerApiBase ? { apiBase: config.workerApiBase } : {}),
        ...(config.workerApiKey ? { apiKey: config.workerApiKey } : {}),
        ...(config.workerModel ? { model: config.workerModel } : {})
      });
    }
    if (ctx.llm && typeof ctx.llm.stream === 'function') {
      return createDshHostLlmClient(ctx, config, () => routesBySession.get(sessionId) ?? lastObservedRoute);
    }
    return createOpenAICompatibleClient();
  }

  const accumulator = createTurnAccumulator({
    workspaceRoot,
    actorId: config.actorId,
    getLlmClient: resolveWorkerLlmClient,
    autoCompactEveryTurns: config.autoCompactEveryTurns,
    onWorkerLog: config.onWorkerLog
  });

  function snapshotFor(sessionId, taskId, refresh = false) {
    const key = `${sessionId ?? 'default'}:${taskId}`;
    if (!refresh && checkoutSnapshots.has(key)) return checkoutSnapshots.get(key);
    const value = compileTaskCheckout({ workspaceRoot, taskId });
    checkoutSnapshots.set(key, value);
    return value;
  }

  function checkoutFor(sessionId, taskId) {
    const switched = activeSnapshotTaskBySession.has(sessionId) && activeSnapshotTaskBySession.get(sessionId) !== taskId;
    activeSnapshotTaskBySession.set(sessionId, taskId);
    return snapshotFor(sessionId, taskId, switched);
  }

  function resolveActiveTaskId(explicitTaskId, sessionOrId) {
    if (Number.isSafeInteger(explicitTaskId) && explicitTaskId > 0) return explicitTaskId;
    const currentTask = sessionOrId
      ? accumulator.getLastTaskId(sessionOrId, { allowFallback: false })
      : null;
    return currentTask ?? readTasksIndex(workspaceRoot).work_anchor_task_id;
  }

  // 1. Dynamic Context Injection: Task Continuity + Light Task Catalog + Active Task Compact Note
  if (ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
    const disposeTaskCtx = ctx.systemPrompt.context({
      name: 'cairn:task-continuity',
      order: 300,
      interpolate: false,
      text(contextArg = {}) {
        if (!isCairnInitialized(workspaceRoot)) return '';
        const tasksIndex = readTasksIndex(workspaceRoot);
        const sessionId = contextArg?.agent?.session?.id ?? null;
        const activeTaskId = tasksIndex.work_anchor_task_id ?? accumulator.getLastTaskId(sessionId) ?? routeStates.get(sessionId)?.taskId ?? null;

        const baseContract = buildAntiRecencyContract({
          tasks: tasksIndex.tasks,
          workAnchorTaskId: tasksIndex.work_anchor_task_id
        });

        const routingNotice = routeStates.get(sessionId)?.clarification ?? '';
        if (activeTaskId === null) return [baseContract, routingNotice].filter(Boolean).join('\n\n');

        const compiled = checkoutFor(sessionId, activeTaskId);
        return [baseContract, compiled.ok && compiled.status !== 'empty' ? `<cairn_task_checkout task_id="${activeTaskId}">\n${compiled.text}\n</cairn_task_checkout>` : '', routingNotice].filter(Boolean).join('\n\n');
      }
    });
    if (typeof disposeTaskCtx === 'function') disposers.push(disposeTaskCtx);

    // 2. Dynamic Context Injection: Workspace Authority Ledger + Tombstones + Staged Notice
    const disposeLedgerCtx = ctx.systemPrompt.context({
      name: 'cairn:workspace-ledger',
      order: 310,
      interpolate: false,
      text() {
        if (!isCairnInitialized(workspaceRoot)) return '';
        const head = readHead(workspaceRoot);
        const staged = readStaged(workspaceRoot);
        const readOnlyHead = projectReadOnlyLedger(head, { includeTombstones: true });
        const parts = [buildAuthorityCheckoutContract(readOnlyHead)];

        if (staged.proposals.length > 0) {
          const ids = staged.proposals.map(p => p.proposal_id).join(', ');
          parts.push(
            `[Cairn Notice: .cairn/staged.json currently holds ${staged.proposals.length} pending state proposal(s) (${ids}). They are awaiting human review and are NOT active until the user confirms via "/cairn commit" or CLI "cairn commit". Do NOT autonomously commit or drop staged proposals unless explicitly instructed by the user.]`
          );
        }

        return parts.join('\n\n');
      }
    });
    if (typeof disposeLedgerCtx === 'function') disposers.push(disposeLedgerCtx);
  }

  // 3. Outbound LLM Stream Middleware:
  //    - Anti-reentrancy pass-through for `purpose === 'cairn-worker'`
  //    - Immutable compaction prompt injection for `purpose === 'compaction'`
  //    - 64-char sliding-window tail marker stripping + synchronous `block-end` stripping
  if (typeof ctx.on === 'function') {
    const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const sessionId = payload?.agent?.session?.id ?? payload?.sessionId;
      if (!sessionId || payload?.signal?.aborted) {
        if (payload?.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
        return next();
      }
      const decision = await next();
      if (payload?.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
      if (decision?.kind !== 'enter') return decision;
      const tasks = readTasksIndex(workspaceRoot);
      const state = routeStates.get(sessionId);
      const anchor = tasks.work_anchor_task_id;
      if (anchor !== null) { snapshotFor(sessionId, anchor); activeSnapshotTaskBySession.set(sessionId, anchor); return decision; }
      if (state?.terminal) return decision;
      if (tasks.tasks.length === 0) { routeStates.set(sessionId, { terminal: true, result: 'new' }); return decision; }
      const selected = payload?.modelSelection;
      if (!selected?.provider || !selected?.model) { routeStates.set(sessionId, { terminal: true, result: 'error' }); return decision; }
      const userText = (payload.messages ?? []).filter(m => m?.source?.kind === 'user').map(m => Array.isArray(m.content) ? m.content.map(b => b.text ?? '').join('') : String(m.content ?? '')).join('\n');
      const opening = state?.result === 'ambiguous' ? `${state.opening}\n${userText}` : userText;
      if (state?.result === 'ambiguous' && (state.retried || state.lastTurn === payload.turn)) return decision;
      const client = config.llmClient ?? createDshHostLlmClient(ctx, config, () => ({ ...selected, sessionId }));
      const controller = new AbortController();
      let timer;
      let result;
      let removeAbortListener = () => {};
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
          removeAbortListener = () => payload.signal.removeEventListener('abort', onAbort);
        });
        result = await Promise.race([
          runColdRouter({ workspaceRoot, userPrompt: opening, applyWorkAnchor: false, llmClient: client, signal: AbortSignal.any([payload.signal, controller.signal].filter(Boolean)) }),
          timeout,
          externalAbort
        ]);
      } catch (err) {
        if (payload.signal?.aborted) throw payload.signal.reason ?? err;
        result = { ok: false, decision: null, error: err.message };
      } finally { clearTimeout(timer); removeAbortListener(); }
      if (payload.signal?.aborted) throw payload.signal.reason ?? new Error('Aborted');
      if (!result.ok) { routeStates.set(sessionId, { terminal: true, result: 'error' }); return decision; }
      if (result.decision === 'ambiguous') {
        routeStates.set(sessionId, { result: 'ambiguous', opening: state?.opening ?? userText, retried: Boolean(state), lastTurn: payload.turn });
        routeStates.get(sessionId).clarification = 'Cairn 找到多个可能的既有任务。请用户说明当前请求对应哪个任务；在澄清前不注入任何任务历史。';
        return decision;
      }
      routeStates.set(sessionId, { terminal: true, result: result.decision, taskId: result.decision === 'match' ? result.task_id : null });
      return decision;
    }, { global: true });
    if (typeof disposePreStep === 'function') disposers.push(disposePreStep);

    const disposeStream = ctx.on(
      'llm/stream',
      async function* (request, next) {
        const invokeNext = req => (typeof next === 'function' ? next(req) : next);

        // (a) Anti-reentrancy guard: never intercept Cairn's own out-of-band worker calls
        if (request?.purpose === 'cairn-worker') {
          yield* invokeNext(request);
          return;
        }

        // Record observed primary conversation route for zero-config worker fallback
        if (
          typeof request?.provider === 'string' &&
          request.provider &&
          typeof request?.model === 'string' &&
          request.model
        ) {
          lastObservedRoute = {
            provider: request.provider,
            model: request.model,
            ...(typeof request.sessionId === 'string' && request.sessionId
              ? { sessionId: request.sessionId }
              : {})
          };
          if (request.sessionId) routesBySession.set(request.sessionId, lastObservedRoute);
        }

        // (b) Native compaction interception (`request.purpose === 'compaction'`)
        if (request?.purpose === 'compaction') {
          const nextMessages = injectStrictBoundaryIntoCompactionMessages(
            request.messages,
            workspaceRoot
          );
          let effectiveRequest = request;
          if (!Object.isFrozen(request)) {
            request.messages = nextMessages;
          } else {
            effectiveRequest = Object.freeze({
              ...request,
              messages: nextMessages
            });
          }
          yield* invokeNext(effectiveRequest);
          return;
        }

        // (c) Normal conversation stream: pass through untouched if stripMarkerInStream is disabled
        if (!config.stripMarkerInStream) {
          yield* invokeNext(request);
          return;
        }

        const sessionId = String(request?.sessionId ?? 'default-session');
        const textBlocksByIndex = new Map();

        function ensureBlockState(index) {
          let state = textBlocksByIndex.get(index);
          if (!state) {
            state = {
              index,
              fullText: '',
              pendingTail: '',
              yieldedLen: 0,
              flushed: false
            };
            textBlocksByIndex.set(index, state);
          }
          return state;
        }

        function* flushBlockState(state) {
          if (!state || state.flushed) return;
          const parsed = parseTaskMarker(state.fullText);
          if (parsed.valid) {
            accumulator.stashStreamMarker(sessionId, {
              rawText: state.fullText,
              parsed
            });
          }
          const cleanFullText = parsed.valid ? parsed.display_text : state.fullText;
          const remainingDelta = cleanFullText.slice(state.yieldedLen);
          if (remainingDelta.length > 0) {
            yield {
              type: 'text-delta',
              index: state.index,
              text: remainingDelta
            };
          }
          state.yieldedLen = cleanFullText.length;
          state.pendingTail = '';
          state.flushed = true;
          state.cleanFullText = cleanFullText;
        }

        for await (const chunk of invokeNext(request)) {
          if (!chunk || typeof chunk !== 'object') {
            yield chunk;
            continue;
          }

          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            const idx = typeof chunk.index === 'number' ? chunk.index : 0;
            const state = ensureBlockState(idx);
            if (state.flushed) continue;

            state.fullText += chunk.text;
            state.pendingTail += chunk.text;

            if (state.pendingTail.length > TAIL_BUFFER_CHARS) {
              const flushLen = state.pendingTail.length - TAIL_BUFFER_CHARS;
              const emitText = state.pendingTail.slice(0, flushLen);
              state.pendingTail = state.pendingTail.slice(flushLen);
              state.yieldedLen += emitText.length;
              yield {
                ...chunk,
                index: idx,
                text: emitText
              };
            }
            continue;
          }

          if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
            const idx = typeof chunk.index === 'number' ? chunk.index : 0;
            const state = textBlocksByIndex.get(idx);
            let cleanBlockText;

            if (state && state.fullText.length > 0) {
              yield* flushBlockState(state);
              cleanBlockText = state.cleanFullText;
            } else {
              const rawBlockText = String(chunk.block.text ?? '');
              const parsed = parseTaskMarker(rawBlockText);
              if (parsed.valid) {
                accumulator.stashStreamMarker(sessionId, {
                  rawText: rawBlockText,
                  parsed
                });
              }
              cleanBlockText = parsed.valid ? parsed.display_text : rawBlockText;
              if (state) state.flushed = true;
            }

            // Shallow-clone chunk and chunk.block so frozen chunks are never mutated in-place
            yield {
              ...chunk,
              block: {
                ...chunk.block,
                text: cleanBlockText
              }
            };
            continue;
          }

          if (chunk.type === 'finish') {
            for (const state of textBlocksByIndex.values()) {
              yield* flushBlockState(state);
            }
            yield chunk;
            continue;
          }

          yield chunk;
        }

        for (const state of textBlocksByIndex.values()) {
          yield* flushBlockState(state);
        }
      },
      { prepend: true, global: true }
    );
    if (typeof disposeStream === 'function') disposers.push(disposeStream);

    // 4. Committed Session Event Feed & Session Disposal Cleanup
    const disposeSessionEvent = ctx.on(
      'session/event',
      (session, event) => {
        accumulator.observeSessionEvent(session, event);
      },
      { global: true }
    );
    if (typeof disposeSessionEvent === 'function') disposers.push(disposeSessionEvent);

    const disposeSessionDisposed = ctx.on(
      'session/disposed',
      session => {
        accumulator.disposeSession(session);
        const sessionId = String(session?.id ?? '');
        routeStates.delete(sessionId);
        activeSnapshotTaskBySession.delete(sessionId);
        routesBySession.delete(sessionId);
        for (const key of checkoutSnapshots.keys()) {
          if (key.startsWith(`${sessionId}:`)) checkoutSnapshots.delete(key);
        }
      },
      { global: true }
    );
    if (typeof disposeSessionDisposed === 'function') disposers.push(disposeSessionDisposed);
  }

  // 5. Register dsh-tools compliant Cairn inspection & human-authorized commit/drop tools
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const toolDefs = [
      createDshToolDefinition({
        name: 'cairn_status',
        description:
          'Inspect the current Cairn Workspace State Ledger HEAD, active decisions, tombstones, open questions, and pending staged proposals.',
        parameters: {
          type: 'object',
          properties: {}
        },
        async execute() {
          return executeCairnCliCommand(workspaceRoot, ['status']).text;
        }
      }),
      createDshToolDefinition({
        name: 'cairn_tasks',
        description:
          'List tracked tasks in .cairn/tasks/index.json and display the 1-line-per-task read-only task catalog.',
        parameters: {
          type: 'object',
          properties: {}
        },
        async execute() {
          return executeCairnCliCommand(workspaceRoot, ['tasks']).text;
        }
      }),
      createDshToolDefinition({
        name: 'cairn_commit',
        description:
          'Commits pending staged workspace state proposals (.cairn/staged.json) into .cairn/head.json. HUMAN AUTHORITY RED LINE: NEVER call this tool autonomously; ONLY invoke it when the user explicitly instructs you to commit staged Cairn proposals.',
        parameters: {
          type: 'object',
          properties: {
            proposal_id: {
              type: 'string',
              description: 'Optional proposal ID (e.g. "stg_1"). Commits all queued proposals if omitted.'
            },
            rebase: {
              type: 'boolean',
              description: 'Whether to rebase onto the latest HEAD revision on base_revision mismatch.'
            }
          }
        },
        async execute(args = {}) {
          const cliArgs = ['commit'];
          if (typeof args.proposal_id === 'string' && args.proposal_id.trim()) {
            cliArgs.push(args.proposal_id.trim());
          }
          if (args.rebase === true) {
            cliArgs.push('--rebase');
          }
          cliArgs.push('--actor', config.actorId);
          return executeCairnCliCommand(workspaceRoot, cliArgs).text;
        }
      }),
      createDshToolDefinition({
        name: 'cairn_drop',
        description:
          'Drops pending staged workspace state proposals from .cairn/staged.json. HUMAN AUTHORITY RED LINE: NEVER call this tool autonomously; ONLY invoke it when the user explicitly instructs you to drop or discard staged Cairn proposals.',
        parameters: {
          type: 'object',
          properties: {
            proposal_id: {
              type: 'string',
              description: 'Optional proposal ID (e.g. "stg_1"). Clears all staged proposals if omitted.'
            }
          }
        },
        async execute(args = {}) {
          const cliArgs = ['drop'];
          if (typeof args.proposal_id === 'string' && args.proposal_id.trim()) {
            cliArgs.push(args.proposal_id.trim());
          }
          return executeCairnCliCommand(workspaceRoot, cliArgs).text;
        }
      })
      ,createDshToolDefinition({ name: 'cairn_checkout', description: 'Set or clear task checkout. HUMAN AUTHORITY RED LINE: NEVER change checkout autonomously; ONLY invoke when explicitly instructed by the user.', parameters: { type:'object', properties:{ task_id:{type:'integer'}, clear:{type:'boolean'} } }, async execute(args={}) { const result = args.clear ? executeCairnCliCommand(workspaceRoot,['checkout','--clear']) : executeCairnCliCommand(workspaceRoot,['checkout',String(args.task_id)]); routeStates.clear(); checkoutSnapshots.clear(); activeSnapshotTaskBySession.clear(); return result.text; } })
      ,createDshToolDefinition({ name: 'cairn_compact', description: 'Compact a task-local history. HUMAN AUTHORITY RED LINE: NEVER compact autonomously; ONLY invoke when explicitly instructed by the user.', parameters: { type:'object', properties:{ task_id:{type:'integer'}, full:{type:'boolean'} } }, async execute(args={}, runCtx={}) { const sessionId=runCtx.agent?.session?.id ?? lastObservedRoute?.sessionId; const taskId=resolveActiveTaskId(args.task_id,sessionId); if (!taskId) return 'No task selected.'; const result=await runStrictCompactor({workspaceRoot,taskId,mode:args.full?'full':'incremental',llmClient:resolveWorkerLlmClient(sessionId)}); if(sessionId) { snapshotFor(sessionId,taskId,true); activeSnapshotTaskBySession.set(sessionId,taskId); } return JSON.stringify(result); } })
    ];

    for (const def of toolDefs) {
      const disposeTool = ctx.tools.register(def);
      if (typeof disposeTool === 'function') disposers.push(disposeTool);
    }
  }

  // 6. Optional `/cairn` Human Slash Command Registration (when `@deepseek-ai/dsh-commands` is mounted)
  const commandsService = ctx.get?.('commands') ?? ctx.commands;
  if (commandsService && typeof commandsService.register === 'function') {
    const disposeCommand = commandsService.register({
      name: 'cairn',
      description:
          'Manage Cairn workspace state and task continuity (checkout | compact | status | log | commit | drop | tasks)',
      input: {
        hint: 'checkout <id|--clear> [--preview] | compact [id] [--full] | status | log | commit | drop | tasks'
      },
      async handler({ rawInput, agent }) {
        const tokens = String(rawInput ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const cliArgs = tokens.length > 0 ? tokens : ['status'];
        if (cliArgs[0] === 'checkout') { const out=executeCairnCliCommand(workspaceRoot,cliArgs); routeStates.clear(); checkoutSnapshots.clear(); activeSnapshotTaskBySession.clear(); return {kind:out.code===0?'success':'error',text:out.text}; }
        if (cliArgs[0] === 'compact') { const sessionId=agent?.session?.id ?? null; const taskId=resolveActiveTaskId(Number(cliArgs[1]) || null,sessionId); if(!taskId)return {kind:'error',text:'No task selected.'}; const res=await runStrictCompactor({workspaceRoot,taskId,mode:cliArgs.includes('--full')?'full':'incremental',llmClient:resolveWorkerLlmClient(sessionId)}); if(sessionId) { snapshotFor(sessionId,taskId,true); activeSnapshotTaskBySession.set(sessionId,taskId); } return {kind:res.ok?'success':'error',text:JSON.stringify(res)}; }
        const { code, text } = executeCairnCliCommand(workspaceRoot, cliArgs);
        return code === 0
          ? { kind: 'success', text }
          : { kind: 'error', text };
      }
    });
    if (typeof disposeCommand === 'function') disposers.push(disposeCommand);
  }

  return Object.freeze({
    config,
    accumulator,
    getLastObservedRoute: () => lastObservedRoute,
    async dispose() {
      await accumulator.flushPendingJobs();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Ignore individual teardown errors
        }
      }
      checkoutSnapshots.clear(); routeStates.clear(); activeSnapshotTaskBySession.clear(); routesBySession.clear();
    }
  });
}

/**
 * Cordis plugin entry. Cordis treats the value returned by `apply` as an *effect*
 * (a disposer function, a Promise of one, an iterable of them, or nullish) and throws
 * `TypeError: Invalid effect` for any other object. Therefore `apply` returns only the
 * disposer function; programmatic callers/tests that need the handle use `createCairnDshHost`.
 */
export async function apply(ctx, rawConfig = {}) {
  const host = await createCairnDshHost(ctx, rawConfig);
  return () => host.dispose();
}
