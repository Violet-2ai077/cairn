// Cairn Reference Host #1: DeepSeek Harness (dsh 0.2.2-rc.5 / Cordis 4.1.0) Plugin Adapter
// (src/hosts/dsh/index.mjs)
// Bridges Cairn Kernel & Workers into dsh lifecycle hooks:
// - ctx.systemPrompt.context: Anti-Recency contract, Light Task Catalog, Task compact.md, and Authority Checkout Ledger
// - ctx.on('llm/stream'): anti-reentrancy for 'cairn-worker', 64-char sliding-window tail marker stripping + block-end sync,
//   and immutable message cloning for `request.purpose === 'compaction'`
// - ctx.on('session/event') & ctx.on('session/disposed'): multi-step ReAct turn accumulation & serial async worker queue
// - ctx.tools.register & optional ctx.commands.register('/cairn'): human-authority-gated state management

import { isCairnInitialized, readHead, buildStrictCompactorPrompt } from '../../kernel/index.mjs';
import { buildGlobalExclusionWatchlistSection } from '../../workers/index.mjs';
import { createCairnDshHost as createMultiWorkspaceDshHost } from './multi-workspace-host.mjs';

export { createMultiWorkspaceDshHost as createCairnDshHost };

export const name = 'cairn-dsh-host';

export const inject = ['systemPrompt', 'llm', 'tools', 'sessions'];

export function resolveDshHostConfig(rawConfig = {}) {
  const hasNewAutoCompactThreshold =
    rawConfig.autoCompactMinRecords !== undefined || rawConfig.autoCompactMinChars !== undefined;
  const hasLegacyAutoCompactThreshold = rawConfig.autoCompactEveryTurns !== undefined;
  const legacyRecords = Number.isSafeInteger(rawConfig.autoCompactEveryTurns) && rawConfig.autoCompactEveryTurns > 0
    ? rawConfig.autoCompactEveryTurns
    : 0;
  return Object.freeze({
    workspaceRoot: typeof rawConfig.workspaceRoot === 'string' && rawConfig.workspaceRoot.trim()
      ? rawConfig.workspaceRoot.trim()
      : null,
    autoInitWorkspace: typeof rawConfig.autoInitWorkspace === 'boolean' ? rawConfig.autoInitWorkspace : true,
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
    autoCompactMinRecords: Number.isSafeInteger(rawConfig.autoCompactMinRecords) && rawConfig.autoCompactMinRecords >= 0
      ? rawConfig.autoCompactMinRecords
      : hasNewAutoCompactThreshold ? 12 : hasLegacyAutoCompactThreshold ? legacyRecords : 12,
    autoCompactMinChars: Number.isSafeInteger(rawConfig.autoCompactMinChars) && rawConfig.autoCompactMinChars >= 0
      ? rawConfig.autoCompactMinChars
      : hasNewAutoCompactThreshold ? 4500 : hasLegacyAutoCompactThreshold ? 0 : 4500,
    maxTailChars: Number.isSafeInteger(rawConfig.maxTailChars) && rawConfig.maxTailChars >= 0
      ? rawConfig.maxTailChars
      : 6000,
    autoCompactCooldownMs: Number.isSafeInteger(rawConfig.autoCompactCooldownMs) && rawConfig.autoCompactCooldownMs >= 0
      ? rawConfig.autoCompactCooldownMs
      : 300000,
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

/**
 * Cordis plugin entry. Cordis treats the value returned by `apply` as an *effect*
 * (a disposer function, a Promise of one, an iterable of them, or nullish) and throws
 * `TypeError: Invalid effect` for any other object. Therefore `apply` returns only the
 * disposer function; programmatic callers/tests that need the handle use `createCairnDshHost`.
 */
export async function apply(ctx, rawConfig = {}) {
  const host = await createMultiWorkspaceDshHost(ctx, rawConfig);
  return () => host.dispose();
}
