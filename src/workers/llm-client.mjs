// Cairn Workers: Injectable Lightweight OpenAI-Compatible Transport Client (src/workers/llm-client.mjs)
// Zero external dependencies (uses Node native globalThis.fetch & AbortSignal).
// Defaults to non-streaming (`stream: false`), enforces `timeoutMs = 60000` (combined with external signal
// via AbortSignal.any), redacts Authorization headers, and retries ONLY transport-layer errors (HTTP 408/429/5xx,
// timeout, or socket failure) with zero semantic/format retries.

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function normalizeChatCompletionsEndpoint(apiBase) {
  const trimmed = String(apiBase ?? 'https://api.deepseek.com/v1')
    .trim()
    .replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function sleepAsync(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a lightweight OpenAI-compatible non-streaming completion client.
 */
export function createOpenAICompatibleClient(config = {}) {
  const apiBase = config.apiBase ?? process.env.CAIRN_API_BASE ?? 'https://api.deepseek.com/v1';
  const endpoint = normalizeChatCompletionsEndpoint(apiBase);
  const apiKey =
    config.apiKey ?? process.env.CAIRN_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
  const defaultModel = config.model ?? process.env.CAIRN_MODEL ?? 'deepseek-chat';
  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 60000;
  const maxTransportRetries =
    typeof config.maxTransportRetries === 'number' ? config.maxTransportRetries : 2;
  const retryDelayMs = typeof config.retryDelayMs === 'number' ? config.retryDelayMs : 100;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const onLog = typeof config.onLog === 'function' ? config.onLog : null;

  async function complete({
    system = '',
    messages = [],
    model = defaultModel,
    temperature = 0,
    maxTokens = 2048,
    reasoningEffort,
    signal
  } = {}) {
    const startTime = Date.now();
    const wireMessages = [];

    if (typeof system === 'string' && system.trim().length > 0) {
      wireMessages.push({ role: 'system', content: system });
    }
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m && typeof m.role === 'string' && typeof m.content === 'string') {
          wireMessages.push({ role: m.role, content: m.content });
        }
      }
    }

    const requestBody = {
      model,
      messages: wireMessages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      ...(reasoningEffort !== undefined && reasoningEffort !== null
        ? { reasoning_effort: reasoningEffort }
        : {})
    };

    const sanitizedRequest = {
      endpoint,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer [REDACTED]'
      },
      body: requestBody
    };

    if (!apiKey || !String(apiKey).trim()) {
      const result = {
        ok: false,
        error_code: 'missing_api_key',
        error_message: 'Missing API key (set CAIRN_API_KEY or pass apiKey in client config)',
        status: null,
        latency_ms: Date.now() - startTime,
        transport_retries: 0,
        raw_request: sanitizedRequest,
        raw_response: null
      };
      if (onLog) onLog(result);
      return result;
    }

    let transportRetries = 0;

    for (let attempt = 0; attempt <= maxTransportRetries; attempt++) {
      if (signal?.aborted) {
        const abortedRes = {
          ok: false,
          error_code: 'aborted',
          error_message: 'Request aborted by caller signal',
          status: null,
          latency_ms: Date.now() - startTime,
          transport_retries: transportRetries,
          raw_request: sanitizedRequest,
          raw_response: null
        };
        if (onLog) onLog(abortedRes);
        return abortedRes;
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const effectiveSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody),
          signal: effectiveSignal
        });

        if (!response.ok) {
          const isRetryableStatus = RETRYABLE_HTTP_STATUSES.has(response.status);
          if (isRetryableStatus && attempt < maxTransportRetries) {
            transportRetries++;
            await sleepAsync(retryDelayMs * Math.pow(2, attempt));
            continue;
          }

          let errorBodyText = '';
          try {
            errorBodyText = await response.text();
          } catch {
            // Ignore body read failure
          }

          const httpErrRes = {
            ok: false,
            error_code: 'http_error',
            error_message: `HTTP ${response.status}${errorBodyText ? `: ${errorBodyText.slice(0, 300)}` : ''}`,
            status: response.status,
            latency_ms: Date.now() - startTime,
            transport_retries: transportRetries,
            raw_request: sanitizedRequest,
            raw_response: null
          };
          if (onLog) onLog(httpErrRes);
          return httpErrRes;
        }

        const payload = await response.json();
        const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
        const message = choice?.message;

        if (!message || typeof message.content !== 'string') {
          const invalidPayloadRes = {
            ok: false,
            error_code: 'invalid_response_payload',
            error_message: 'Response missing choices[0].message.content string',
            status: response.status,
            latency_ms: Date.now() - startTime,
            transport_retries: transportRetries,
            raw_request: sanitizedRequest,
            raw_response: payload ?? null
          };
          if (onLog) onLog(invalidPayloadRes);
          return invalidPayloadRes;
        }

        const successRes = {
          ok: true,
          content: message.content,
          reasoning_content:
            typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
          model: payload.model ?? model,
          usage: payload.usage ?? null,
          latency_ms: Date.now() - startTime,
          transport_retries: transportRetries,
          raw_request: sanitizedRequest,
          raw_response: payload
        };
        if (onLog) onLog(successRes);
        return successRes;
      } catch (err) {
        if (signal?.aborted) {
          const abortedRes = {
            ok: false,
            error_code: 'aborted',
            error_message: 'Request aborted by caller signal',
            status: null,
            latency_ms: Date.now() - startTime,
            transport_retries: transportRetries,
            raw_request: sanitizedRequest,
            raw_response: null
          };
          if (onLog) onLog(abortedRes);
          return abortedRes;
        }

        const isTimeout =
          timeoutSignal.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError';

        if (attempt < maxTransportRetries) {
          transportRetries++;
          await sleepAsync(retryDelayMs * Math.pow(2, attempt));
          continue;
        }

        const netErrRes = {
          ok: false,
          error_code: isTimeout ? 'timeout_error' : 'network_error',
          error_message: isTimeout
            ? `Request timed out after ${timeoutMs}ms`
            : `Network failure: ${err?.message ?? String(err)}`,
          status: null,
          latency_ms: Date.now() - startTime,
          transport_retries: transportRetries,
          raw_request: sanitizedRequest,
          raw_response: null
        };
        if (onLog) onLog(netErrRes);
        return netErrRes;
      }
    }
  }

  return Object.freeze({
    complete
  });
}

/**
 * Helper to create an injectable offline mock LLM client for deterministic unit testing.
 */
export function createMockLlmClient(handler) {
  const calls = [];
  return Object.freeze({
    calls,
    async complete(req = {}) {
      calls.push(req);
      const reply = typeof handler === 'function' ? await handler(req, calls.length - 1) : handler;
      if (typeof reply === 'string') {
        return {
          ok: true,
          content: reply,
          reasoning_content: '',
          model: 'mock-model',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          latency_ms: 1,
          transport_retries: 0,
          raw_request: {
            headers: { Authorization: 'Bearer [REDACTED]' },
            body: { stream: false, ...req }
          },
          raw_response: null
        };
      }
      return {
        ok: reply?.ok ?? true,
        content: reply?.content ?? '',
        reasoning_content: reply?.reasoning_content ?? '',
        error_code: reply?.error_code ?? null,
        error_message: reply?.error_message ?? null,
        status: reply?.status ?? 200,
        model: reply?.model ?? 'mock-model',
        usage: reply?.usage ?? null,
        latency_ms: reply?.latency_ms ?? 1,
        transport_retries: reply?.transport_retries ?? 0,
        raw_request: {
          headers: { Authorization: 'Bearer [REDACTED]' },
          body: { stream: false, ...req }
        },
        raw_response: null
      };
    }
  });
}
