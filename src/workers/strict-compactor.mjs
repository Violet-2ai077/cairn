// Cairn Workers: Hard Global/Local Boundary Task Compactor (src/workers/strict-compactor.mjs)
// Reads `.cairn/tasks/<id>/thread.jsonl` and optional `compact.md`, short-circuits with zero LLM
// calls when incremental mode has `no_new_turns` beyond `compacted_record_count`, injects an explicit
// Global Ledger Exclusion Watchlist from `.cairn/head.json` to purge global rules during both full
// and incremental compaction, and updates `compact.md` + `compacted_record_count`.

import {
  isCairnInitialized,
  initCairnStore,
  normalizeTaskId,
  readHead,
  readTasksIndex,
  readTaskThread,
  readTaskCompaction,
  writeTaskCompaction,
  buildStrictCompactorPrompt
} from '../kernel/index.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';
import { summarizeBatches } from './compaction-batches.mjs';

export function buildGlobalExclusionWatchlistSection(head) {
  if (!head) return '';

  const globalKeys = new Set();
  const globalOptions = new Set();

  for (const d of head.active ?? []) {
    if (d.key) globalKeys.add(d.key);
    if (d.option_code) globalOptions.add(d.option_code);
  }
  for (const t of head.tombstones ?? []) {
    if (t.key) globalKeys.add(t.key);
    if (t.option_code) globalOptions.add(t.option_code);
  }
  for (const q of head.open_questions ?? []) {
    if (q.key) globalKeys.add(q.key);
  }

  if (globalKeys.size === 0 && globalOptions.size === 0) {
    return '';
  }

  const lines = [
    '### 宿主权威全局账本剔除黑名单（Global Ledger Exclusion Watchlist）',
    '以下键名（keys）与方案代号（option_codes）属于工作区全局账本（Workspace State Ledger）管辖范围：'
  ];
  if (globalKeys.size > 0) {
    lines.push(`- Global Keys: ${Array.from(globalKeys).join(', ')}`);
  }
  if (globalOptions.size > 0) {
    lines.push(`- Global Option Codes: ${Array.from(globalOptions).join(', ')}`);
  }
  lines.push(
    '无论是从新增任务对话记录中提取，还是在增量合并既有 `previous_compact_note` 时发现残留的上述全局规则或代号描述，都必须彻底剥离，绝不能写入输出的局部交接摘要中。'
  );

  return lines.join('\n');
}

export async function runStrictCompactor({
  workspaceRoot = process.cwd(),
  taskId,
  mode = 'incremental',
  fromSeq = null,
  llmClient = null,
  distillOptions = {},
  reasoningEffort,
  signal,
  maxEmptyRetries = 1
} = {}) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }

  const id = normalizeTaskId(taskId);
  const tasksIndex = readTasksIndex(workspaceRoot);
  const taskEntry = tasksIndex.tasks.find(t => t.id === id) ?? null;
  if (!taskEntry) {
    return {
      ok: false,
      skipped: true,
      reason: 'task_not_found',
      llm_called: false,
      task_id: id
    };
  }
  if (taskEntry.status !== 'active') {
    return {
      ok: false,
      skipped: true,
      reason: 'task_not_active',
      task_id: id,
      task_status: taskEntry.status,
      llm_called: false,
      compacted_record_count: taskEntry.compacted_record_count,
      compact_markdown: readTaskCompaction(workspaceRoot, id)
    };
  }
  const prevCompactedCount = taskEntry?.compacted_record_count ?? 0;

  const allRecords = readTaskThread(workspaceRoot, id);
  const existingCompact = readTaskCompaction(workspaceRoot, id);

  let targetRecords;
  if (mode === 'full') {
    targetRecords = allRecords;
  } else {
    // Incremental mode: slice from explicit `fromSeq` or persisted `compacted_record_count`
    if (typeof fromSeq === 'number' && fromSeq < prevCompactedCount) {
      targetRecords = allRecords.filter(
        (r, idx) => (typeof r.seq === 'number' ? r.seq : idx + 1) > fromSeq
      );
    } else {
      targetRecords = allRecords.slice(prevCompactedCount);
    }
  }

  // Deterministic short-circuit when there are no new turns to compact
  if (targetRecords.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_new_turns',
      llm_called: false,
      task_id: id,
      compacted_record_count: prevCompactedCount,
      compact_markdown: existingCompact
    };
  }

  const head = readHead(workspaceRoot);
  const basePrompt = buildStrictCompactorPrompt({ taskId: id });
  const watchlistSection = buildGlobalExclusionWatchlistSection(head);
  const systemPrompt = watchlistSection ? `${basePrompt}\n\n${watchlistSection}` : basePrompt;

  const { attempts, response: llmRes } = await summarizeBatches({
    records: targetRecords, previous: mode === 'full' ? '' : existingCompact,
    client: llmClient ?? createOpenAICompatibleClient(), system: systemPrompt,
    signal, reasoningEffort, maxEmptyRetries, options: distillOptions
  });

  const rawResponse = llmRes?.raw_response;
  const finishReason = Array.isArray(rawResponse?.choices)
    ? rawResponse.choices[0]?.finish_reason ?? null
    : null;
  const usage = llmRes?.usage && typeof llmRes.usage === 'object'
    ? Object.fromEntries(
        ['prompt_tokens', 'completion_tokens', 'total_tokens']
          .filter(key => Number.isFinite(llmRes.usage[key]))
          .map(key => [key, llmRes.usage[key]])
      )
    : {};
  const safeDiagnostics = {
    attempts,
    raw_response_length: String(llmRes?.content ?? '').length,
    ...(typeof finishReason === 'string' ? { finish_reason: finishReason } : {}),
    ...(typeof llmRes?.model === 'string' ? { model: llmRes.model } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {})
  };

  if (signal?.aborted || llmRes?.error_code === 'aborted') {
    return {
      ok: false,
      skipped: false,
      reason: 'aborted',
      llm_called: true,
      ...safeDiagnostics,
      task_id: id,
      compacted_record_count: prevCompactedCount,
      compact_markdown: existingCompact,
      error_code: 'aborted'
    };
  }

  if (!llmRes.ok) {
    return {
      ok: false,
      skipped: false,
      reason: 'transport_error',
      llm_called: true,
      ...safeDiagnostics,
      task_id: id,
      compacted_record_count: prevCompactedCount,
      compact_markdown: existingCompact,
      error_code: llmRes.error_code,
      error: llmRes.error_message
    };
  }

  const summaryText = String(llmRes.content ?? '').trim();
  if (!summaryText) {
    return {
      ok: false,
      skipped: false,
      reason: 'empty_compaction_output',
      llm_called: true,
      ...safeDiagnostics,
      task_id: id,
      compacted_record_count: prevCompactedCount,
      compact_markdown: existingCompact,
      error_code: 'empty_compaction_output',
      error: 'Compactor model returned an empty summary'
    };
  }

  const latestTask = readTasksIndex(workspaceRoot).tasks.find(task => task.id === id);
  if (!latestTask || latestTask.status !== 'active') {
    return {
      ok: false,
      skipped: true,
      reason: latestTask ? 'task_not_active' : 'task_not_found',
      task_id: id,
      ...(latestTask ? { task_status: latestTask.status } : {}),
      llm_called: true,
      ...safeDiagnostics,
      compacted_record_count: latestTask?.compacted_record_count ?? prevCompactedCount,
      compact_markdown: readTaskCompaction(workspaceRoot, id)
    };
  }

  const writeRes = writeTaskCompaction(workspaceRoot, id, summaryText, {
    compactedRecordCount: allRecords.length
  });

  return {
    ok: true,
    skipped: false,
    reason: 'compacted',
    llm_called: true,
    ...safeDiagnostics,
    task_id: id,
    compacted_record_count: writeRes.compacted_record_count,
    compact_markdown: writeRes.content
  };
}
