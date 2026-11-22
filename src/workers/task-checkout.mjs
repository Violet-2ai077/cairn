// Cairn Workers: deterministic compiler for a task-local checkout snapshot.

import {
  isCairnInitialized,
  normalizeTaskId,
  readTasksIndex,
  readTaskThread,
  readTaskCompaction
} from '../kernel/index.mjs';
import { distillTaskThread } from './distill.mjs';

const AUTHORITY_BOUNDARY =
  '局部历史服从工作区全局 Ledger / Tombstone 权威覆盖；任务记录不得覆盖或推翻全局权威状态。';

export function compileTaskCheckout({
  workspaceRoot = process.cwd(),
  taskId,
  maxTailChars = 6000
} = {}) {
  const id = normalizeTaskId(taskId);
  if (!Number.isSafeInteger(maxTailChars) || maxTailChars < 0) {
    throw new RangeError('maxTailChars must be a non-negative safe integer');
  }

  const base = {
    task_id: id,
    compacted_record_count: 0,
    total_record_count: 0,
    included_tail_record_count: 0,
    compact_markdown: '',
    tail_text: '',
    text: ''
  };
  if (!isCairnInitialized(workspaceRoot)) {
    return { ok: false, status: 'not_found', ...base };
  }

  const task = readTasksIndex(workspaceRoot).tasks.find(entry => entry.id === id);
  if (!task) {
    return { ok: false, status: 'not_found', ...base };
  }

  const compactMarkdown = String(readTaskCompaction(workspaceRoot, id) ?? '').trim();
  const records = readTaskThread(workspaceRoot, id);
  const rawCursor = task.compacted_record_count;
  const cursor = Number.isSafeInteger(rawCursor) ? Math.max(0, rawCursor) : 0;
  const safeCursor = Math.min(cursor, records.length);
  const tailRecords = records.slice(safeCursor);
  const tail = maxTailChars > 0
    ? distillTaskThread(tailRecords, { maxThreadChars: maxTailChars })
    : { distilled_text: '', record_count: 0 };
  const tailText = tail.distilled_text.trim();
  const parts = [`# Task Checkout ${id}`, AUTHORITY_BOUNDARY];

  if (compactMarkdown) {
    parts.push(`## 已压缩的任务局部摘要\n${compactMarkdown}`);
  }
  if (tailText) {
    parts.push(`## 未压缩的近期任务记录\n${tailText}`);
  }

  let status = 'empty';
  if (compactMarkdown && tailText) status = 'ready';
  else if (compactMarkdown) status = 'compact_only';
  else if (tailText) status = 'tail_only';

  return {
    ok: true,
    status,
    task_id: id,
    compacted_record_count: safeCursor,
    total_record_count: records.length,
    included_tail_record_count: tail.record_count,
    compact_markdown: compactMarkdown,
    tail_text: tailText,
    text: parts.join('\n\n')
  };
}
