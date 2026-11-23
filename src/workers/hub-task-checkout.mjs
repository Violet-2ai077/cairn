import {
  readHubTaskCompaction,
  readHubTaskThread,
  readHubTasksIndex
} from '../kernel/index.mjs';
import { distillTaskThread } from './distill.mjs';

const AUTHORITY_BOUNDARY = 'User Ledger 与适用的 Project Ledger（含 Tombstone）均高于并覆盖 Task 局部历史；项目决策优先于通用 User 默认偏好。';

export function compileHubTaskCheckout({ hubRoot, taskId, maxTailChars = 6000 } = {}) {
  if (!Number.isSafeInteger(maxTailChars) || maxTailChars < 0) throw new RangeError('maxTailChars must be a non-negative safe integer');
  const index = readHubTasksIndex(hubRoot);
  const task = index.tasks.find(item => item.id === Number(taskId));
  if (!task) return { ok: false, status: 'not_found', task_id: Number(taskId), text: '' };
  const compact = String(readHubTaskCompaction(hubRoot, task.id) ?? '').trim();
  const thread = readHubTaskThread(hubRoot, task.id);
  const cursor = Math.max(0, Math.min(Number.isSafeInteger(task.compacted_record_count) ? task.compacted_record_count : 0, thread.length));
  const tail = maxTailChars > 0 ? distillTaskThread(thread.slice(cursor), { maxThreadChars: maxTailChars }) : { distilled_text: '', record_count: 0 };
  const parts = [`# Task Checkout ${task.id}`, AUTHORITY_BOUNDARY];
  if (compact) parts.push(`## Compressed task-local history\n${compact}`);
  if (tail.distilled_text.trim()) parts.push(`## Uncompressed recent history\n${tail.distilled_text.trim()}`);
  return {
    ok: true,
    status: compact && tail.distilled_text.trim() ? 'ready' : compact ? 'compact_only' : tail.distilled_text.trim() ? 'tail_only' : 'empty',
    task_id: task.id,
    project_id: task.project_id,
    compacted_record_count: cursor,
    total_record_count: thread.length,
    text: parts.join('\n\n')
  };
}
