// Cairn Reference Host #1 (dsh): Per-Session Turn Event Accumulator & Serial Worker Queue
// (src/hosts/dsh/turn-accumulator.mjs)
// Aggregates dsh SessionEvents (user/message, tool/call, tool/result, assistant/message, turn/end),
// supports multi-step ReAct turns without losing valid task markers to intermediate tool steps,
// archives turns to `.cairn/tasks/<id>/thread.jsonl`, and triggers out-of-band workers via a
// per-workspace serial queue (fire-and-forget, never blocking or throwing into the host session).

import {
  isCairnInitialized,
  initCairnStore,
  readTasksIndex,
  readTaskThread,
  parseTaskMarker,
  appendTaskTurn
} from '../../kernel/index.mjs';
import {
  runStagingExtractor,
} from '../../workers/index.mjs';
import { distillTaskThread } from '../../workers/distill.mjs';

const SYNTHETIC_USER_SOURCES = new Set(['runtime-context', 'compact-checkpoint', 'agent-instructions']);

export function extractTextFromDshMessage(message) {
  if (!message) return '';
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

function stripTrailingDshSystemReminders(text) {
  let cleaned = String(text ?? '').trimEnd();
  const reminder = /(?:\r?\n){0,2}<system-reminder>\s*[\s\S]*?<\/system-reminder>\s*$/iu;
  while (reminder.test(cleaned)) cleaned = cleaned.replace(reminder, '').trimEnd();
  return cleaned.trim();
}

function summarizeToolTarget(name, rawArgs) {
  if (!rawArgs) return '';
  let parsed = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return rawArgs.slice(0, 120);
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return String(rawArgs).slice(0, 120);
  }
  for (const key of ['command', 'CommandLine', 'path', 'Path', 'file', 'pattern', 'query', 'url']) {
    if (typeof parsed[key] === 'string' && parsed[key].trim()) {
      return parsed[key].trim().slice(0, 160);
    }
  }
  return '';
}

export function createTurnAccumulator({
  workspaceRoot = process.cwd(),
  actorId = 'dsh-host',
  autoInitWorkspace = true,
  getLlmClient,
  autoCompactMinRecords = 0,
  autoCompactMinChars = 0,
  maxTailChars = 6000,
  compactionCoordinator = null,
  canAutoCompact = null,
  resolveBoundTaskId = null,
  onWorkerLog = null
} = {}) {
  const turnStateBySession = new Map();
  const lastTaskIdBySession = new Map();
  const bindingSourceBySession = new Map();
  const stashedMarkersBySession = new Map();
  const queuedAutoCompactions = new Set();

  let workspaceSerialQueue = Promise.resolve();
  const pendingJobs = new Set();

  function logSafe(entry) {
    if (typeof onWorkerLog === 'function') {
      try {
        onWorkerLog(entry);
      } catch {
        // Never allow logging callback to throw into host loop
      }
    }
  }

  function enqueueWorkspaceJob(label, asyncFn) {
    const jobPromise = workspaceSerialQueue
      .then(() => asyncFn())
      .catch(err => {
        logSafe({
          level: 'warn',
          job: label,
          error: err?.message ?? String(err)
        });
        return null;
      });

    workspaceSerialQueue = jobPromise.then(
      () => void 0,
      () => void 0
    );

    pendingJobs.add(jobPromise);
    jobPromise.finally(() => {
      pendingJobs.delete(jobPromise);
    });
    return jobPromise;
  }

  function ensureTurnState(sessionId, turnNumber = 1) {
    let state = turnStateBySession.get(sessionId);
    if (!state || (turnNumber !== null && state.turn !== turnNumber)) {
      state = {
        sessionId,
        turn: turnNumber ?? 1,
        userTexts: [],
        assistantTexts: [],
        rawAssistantTexts: [],
        lastValidParsedMarker: null,
        lastMarkedRawAssistantText: null,
        lastMarkedDisplayAssistantText: null,
        toolCallsById: new Map(),
        toolCallsBySeq: new Map(),
        completedTools: []
      };
      turnStateBySession.set(sessionId, state);
    }
    return state;
  }

  function stashStreamMarker(sessionId, { rawText, parsed, turn = null } = {}) {
    if (!sessionId || !parsed || !parsed.valid) return;
    let queue = stashedMarkersBySession.get(sessionId);
    if (!queue) {
      queue = [];
      stashedMarkersBySession.set(sessionId, queue);
    }
    queue.push({
      rawText: String(rawText ?? ''),
      parsed,
      turn
    });
  }

  function consumeStashedMarker(sessionId) {
    const queue = stashedMarkersBySession.get(sessionId);
    if (!queue || queue.length === 0) return null;
    const item = queue.shift();
    if (queue.length === 0) {
      stashedMarkersBySession.delete(sessionId);
    }
    return item;
  }

  function observeSessionEvent(session, event) {
    const sessionId = String(session?.id ?? 'default-session');
    if (!event || typeof event.type !== 'string') return;

    if (event.type === 'turn/start') {
      const turnNum = event.data?.turn ?? 1;
      turnStateBySession.delete(sessionId);
      ensureTurnState(sessionId, turnNum);
      return;
    }

    if (event.type === 'user/message') {
      const msg = event.data?.message ?? event.data;
      const sourceKind = msg?.source?.kind ?? '';
      // Ignore host-synthesized runtime-context and compaction checkpoint user messages
      if (SYNTHETIC_USER_SOURCES.has(sourceKind)) {
        return;
      }
      const text = stripTrailingDshSystemReminders(extractTextFromDshMessage(msg));
      if (!text) return;
      const current = turnStateBySession.get(sessionId) ?? ensureTurnState(sessionId, event.data?.turn ?? 1);
      current.userTexts.push(text);
      return;
    }

    if (event.type === 'tool/call') {
      const turnNum = event.data?.turn ?? turnStateBySession.get(sessionId)?.turn ?? 1;
      const current = ensureTurnState(sessionId, turnNum);
      const callId = event.data?.callId ?? event.data?.id ?? `seq_${event.seq}`;
      const name = event.data?.name ?? event.data?.toolName ?? 'tool';
      const args = event.data?.arguments ?? event.data?.args ?? '';
      const callRecord = {
        seq: event.seq,
        callId,
        name,
        target: summarizeToolTarget(name, args)
      };
      current.toolCallsById.set(callId, callRecord);
      if (typeof event.seq === 'number') {
        current.toolCallsBySeq.set(event.seq, callRecord);
      }
      return;
    }

    if (event.type === 'assistant/message') {
      const turnNum = event.data?.turn ?? turnStateBySession.get(sessionId)?.turn ?? 1;
      const current = ensureTurnState(sessionId, turnNum);
      const msg = event.data?.message ?? event.data;

      // Also index any inline tool-call blocks inside assistant/message content
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool-call' && block.id) {
            const callRecord = {
              seq: event.seq,
              callId: block.id,
              name: block.name ?? 'tool',
              target: summarizeToolTarget(block.name, block.arguments)
            };
            current.toolCallsById.set(block.id, callRecord);
            if (typeof event.seq === 'number') {
              current.toolCallsBySeq.set(event.seq, callRecord);
            }
          }
        }
      }

      const eventText = extractTextFromDshMessage(msg).trim();
      const stashed = consumeStashedMarker(sessionId);

      let rawText = eventText;
      let parsed = parseTaskMarker(eventText);

      if (stashed && stashed.parsed?.valid) {
        rawText = stashed.rawText;
        parsed = stashed.parsed;
      }

      if (eventText) {
        current.assistantTexts.push(parsed.valid ? parsed.display_text : eventText);
      }
      if (rawText) {
        current.rawAssistantTexts.push(rawText);
      }

      // Multi-step ReAct guard: only update turn attribution when a valid marker is present,
      // so intermediate tool-calling steps without markers never clobber a valid marker.
      if (parsed.valid) {
        current.lastValidParsedMarker = parsed;
        current.lastMarkedRawAssistantText = rawText;
        current.lastMarkedDisplayAssistantText = parsed.display_text;
        if (!parsed.is_unresolved && typeof parsed.task_number === 'number') {
          lastTaskIdBySession.set(sessionId, parsed.task_number);
          if (!bindingSourceBySession.has(sessionId)) bindingSourceBySession.set(sessionId, 'task_marker');
        }
      }
      return;
    }

    if (event.type === 'tool/result') {
      const turnNum = event.data?.turn ?? turnStateBySession.get(sessionId)?.turn ?? 1;
      const current = ensureTurnState(sessionId, turnNum);
      const msg = event.data?.message ?? event.data;
      const toolCallId = msg?.toolCallId ?? msg?.source?.callId ?? event.data?.callId ?? null;

      let matchedCall = toolCallId ? current.toolCallsById.get(toolCallId) : null;
      if (!matchedCall && Array.isArray(event.sourceEventSeqs)) {
        for (const seq of event.sourceEventSeqs) {
          if (current.toolCallsBySeq.has(seq)) {
            matchedCall = current.toolCallsBySeq.get(seq);
            break;
          }
        }
      }

      const outputText = extractTextFromDshMessage(msg);
      const isError = Boolean(msg?.isError ?? event.data?.error !== undefined);
      current.completedTools.push({
        name: matchedCall?.name ?? 'tool',
        target: matchedCall?.target ?? '',
        ok: !isError,
        exit_code: isError ? 1 : 0,
        output: outputText
      });
      return;
    }

    if (event.type === 'turn/end') {
      const current = turnStateBySession.get(sessionId);
      if (!current) return;
      turnStateBySession.delete(sessionId);

      const userCombined = current.userTexts.join('\n\n').trim();
      const assistantCombined =
        current.lastMarkedDisplayAssistantText ?? current.assistantTexts.join('\n\n').trim();
      const rawAssistantCombined =
        current.lastMarkedRawAssistantText ?? current.rawAssistantTexts.join('\n\n').trim();
      const parsedMarker = current.lastValidParsedMarker;
      const turnNum = event.data?.turn ?? current.turn ?? 1;

      if (!userCombined && !assistantCombined) {
        return;
      }

      // 1. Archive to .cairn/tasks/<id>/thread.jsonl if resolved to a specific task 1..999
      let resolvedTaskId = null;
      let attribution = null;
      if (parsedMarker?.valid && !parsedMarker.is_unresolved && typeof parsedMarker.task_number === 'number') {
        resolvedTaskId = parsedMarker.task_number;
        lastTaskIdBySession.set(sessionId, resolvedTaskId);
      } else if (
        !parsedMarker &&
        rawAssistantCombined &&
        !rawAssistantCombined.includes('<|task')
      ) {
        const sessionBoundTaskId = typeof resolveBoundTaskId === 'function'
          ? resolveBoundTaskId(sessionId)
          : null;
        const fallbackTaskId = sessionBoundTaskId ?? lastTaskIdBySession.get(sessionId) ?? null;
        const tracked = Number.isSafeInteger(fallbackTaskId) && fallbackTaskId > 0 &&
          readTasksIndex(workspaceRoot).tasks.some(task => Number(task.id) === fallbackTaskId);
        if (tracked) {
          resolvedTaskId = fallbackTaskId;
          attribution = 'session_fallback';
          lastTaskIdBySession.set(sessionId, resolvedTaskId);
        }
      }

      if (!isCairnInitialized(workspaceRoot)) {
        const hasConcreteMarker = parsedMarker?.valid &&
          !parsedMarker.is_unresolved && typeof parsedMarker.task_number === 'number';
        if (!autoInitWorkspace || !hasConcreteMarker) return;
        initCairnStore(workspaceRoot);
      }

      if (resolvedTaskId !== null) {
        const taskIndex = readTasksIndex(workspaceRoot);
        const trackedTask = taskIndex.tasks.find(task => task.id === resolvedTaskId);
        if (trackedTask && trackedTask.status !== 'active') {
          logSafe({ level: 'info', job: 'task-archive-skipped', task_id: resolvedTaskId, reason: 'task_not_active' });
          resolvedTaskId = null;
          attribution = null;
        }
      }

      if (resolvedTaskId !== null) {
        if (parsedMarker?.valid) lastTaskIdBySession.set(sessionId, resolvedTaskId);
        if (userCombined) {
          appendTaskTurn(workspaceRoot, {
            task_id: resolvedTaskId,
            turn: turnNum,
            role: 'user',
            content: userCombined
          });
        }

        const appended = appendTaskTurn(workspaceRoot, {
          task_id: resolvedTaskId,
          turn: turnNum,
          role: 'assistant',
          content: assistantCombined,
          raw_content: rawAssistantCombined || assistantCombined,
          meta: {
            ...(current.completedTools.length > 0 ? { tools: current.completedTools } : {}),
            ...(attribution ? { attribution } : {})
          }
        });

        if (parsedMarker?.valid && !parsedMarker.is_unresolved && typeof parsedMarker.task_number === 'number') {
          bindingSourceBySession.set(sessionId, 'task_marker');
        }

        const thresholdsEnabled = autoCompactMinRecords > 0 || autoCompactMinChars > 0;
        if (thresholdsEnabled && appended.task.status === 'active' && compactionCoordinator) {
          const currentIndex = readTasksIndex(workspaceRoot);
          const currentTask = currentIndex.tasks.find(task => task.id === resolvedTaskId);
          if (currentTask?.status === 'active') {
            const records = readTaskThread(workspaceRoot, resolvedTaskId);
            const cursor = Math.min(Math.max(0, currentTask.compacted_record_count ?? 0), records.length);
            const tailRecords = records.slice(cursor);
            const tailChars = distillTaskThread(tailRecords, {
              maxThreadChars: Number.MAX_SAFE_INTEGER,
              maxPerRecordChars: Number.MAX_SAFE_INTEGER,
              maxCodeBlockChars: Number.MAX_SAFE_INTEGER,
              maxPerToolChars: Number.MAX_SAFE_INTEGER
            }).distilled_text.length;
            const reached = (autoCompactMinRecords > 0 && tailRecords.length >= autoCompactMinRecords) ||
              (autoCompactMinChars > 0 && tailChars >= autoCompactMinChars);
            if (reached) {
              if (typeof canAutoCompact === 'function' && !canAutoCompact(sessionId)) {
                compactionCoordinator.recordSkipped(resolvedTaskId, 'llm_route_unavailable');
              } else {
                const autoState = compactionCoordinator.getTaskStatus(resolvedTaskId);
                const pendingKey = String(resolvedTaskId);
                if (!(autoState.status === 'cooldown' && autoState.cooldown_until > Date.now()) &&
                    !queuedAutoCompactions.has(pendingKey)) {
                  const client = typeof getLlmClient === 'function' ? getLlmClient(sessionId) : null;
                  if (!client) {
                    compactionCoordinator.recordSkipped(resolvedTaskId, 'llm_route_unavailable');
                  } else {
                    queuedAutoCompactions.add(pendingKey);
                    compactionCoordinator.recordQueued(resolvedTaskId);
                    enqueueWorkspaceJob(`strict-compactor:task_${resolvedTaskId}:turn_${turnNum}`, async () => {
                      try {
                        const res = await compactionCoordinator.run({
                          taskId: resolvedTaskId,
                          mode: 'incremental',
                          source: 'auto',
                          llmClient: client
                        });
                        logSafe({ level: 'info', job: 'strict-compactor', task_id: resolvedTaskId, result: res });
                        return res;
                      } finally {
                        queuedAutoCompactions.delete(pendingKey);
                      }
                    });
                  }
                }
              }
            }
          }
        }
      }

      // 2. Out-of-band Asynchronous Staging Operator Extraction (fire-and-forget on serial queue)
      const client = typeof getLlmClient === 'function' ? getLlmClient(sessionId) : null;
      if (client) {
        const turnInput = {
          turn: turnNum,
          user: userCombined,
          assistant: rawAssistantCombined || assistantCombined,
          tools: current.completedTools
        };
        const sourceStep = `session_${sessionId}_turn_${turnNum}`;

        enqueueWorkspaceJob(`staging-extractor:${sourceStep}`, async () => {
          const res = await runStagingExtractor({
            workspaceRoot,
            turnInput,
            source_step: sourceStep,
            actor_id: actorId,
            llmClient: client
          });
          logSafe({ level: 'info', job: 'staging-extractor', source_step: sourceStep, result: res });
          return res;
        });
      }
    }
  }

  function disposeSession(sessionOrId) {
    const sessionId =
      typeof sessionOrId === 'string' ? sessionOrId : String(sessionOrId?.id ?? '');
    if (!sessionId) return;
    turnStateBySession.delete(sessionId);
    lastTaskIdBySession.delete(sessionId);
    bindingSourceBySession.delete(sessionId);
    stashedMarkersBySession.delete(sessionId);
  }

  function getLastTaskId(sessionOrId, { allowFallback = true } = {}) {
    const sessionId =
      typeof sessionOrId === 'string' ? sessionOrId : String(sessionOrId?.id ?? '');
    const isActive = id => readTasksIndex(workspaceRoot).tasks.some(task => task.id === id && task.status === 'active');
    if (sessionId && lastTaskIdBySession.has(sessionId)) {
      const id = lastTaskIdBySession.get(sessionId);
      return isActive(id) ? id : null;
    }
    if (!allowFallback) return null;
    // Fallback to the most recently recorded session's task id in single-agent mode
    let fallback = null;
    for (const val of lastTaskIdBySession.values()) {
      if (isActive(val)) fallback = val;
    }
    return fallback;
  }

  async function flushPendingJobs() {
    while (pendingJobs.size > 0) {
      await Promise.allSettled([...pendingJobs]);
    }
  }

  function clearTaskBindings(taskId) {
    const clearedSessions = [];
    for (const [sessionId, boundTaskId] of lastTaskIdBySession) {
      if (boundTaskId === taskId) {
        lastTaskIdBySession.delete(sessionId);
        bindingSourceBySession.delete(sessionId);
        clearedSessions.push(sessionId);
      }
    }
    for (const [sessionId, state] of turnStateBySession) {
      if (state.lastValidParsedMarker?.task_number === taskId) {
        state.lastValidParsedMarker = null;
        state.lastMarkedRawAssistantText = null;
        state.lastMarkedDisplayAssistantText = null;
        clearedSessions.push(sessionId);
      }
    }
    return [...new Set(clearedSessions)];
  }

  return Object.freeze({
    observeSessionEvent,
    stashStreamMarker,
    consumeStashedMarker,
    disposeSession,
    getLastTaskId,
    clearTaskBindings,
    getBindingSource: sessionId => bindingSourceBySession.get(sessionId) ?? null,
    flushPendingJobs,
    _internal: {
      turnStateBySession,
      lastTaskIdBySession,
      stashedMarkersBySession
    }
  });
}
