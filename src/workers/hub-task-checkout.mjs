import { createHash } from 'node:crypto';
import { pick } from '../i18n/locale.mjs';
import {
  readHubTaskCompaction,
  readHubTaskThread,
  readHubTasksIndex
} from '../kernel/index.mjs';
import { distillTaskThread } from './distill.mjs';
import { readConsistentHub } from '../kernel/hub-write-lock.mjs';

const AUTHORITY_BOUNDARY = pick('User Ledger 与适用的 Project Ledger（含 Tombstone）均高于并覆盖 Task 局部历史；项目决策优先于通用 User 默认偏好。',
  'The User Ledger and applicable Project Ledger, including tombstones, override task-local history. Project decisions take precedence over general User defaults.');

export function readCheckoutHistory(hubRoot, task) {
  const raw = readHubTaskCompaction(hubRoot, task.id);
  const compact = String(raw ?? '').trim();
  const compactHash = raw === null ? null : createHash('sha256').update(raw).digest('hex');
  const thread = readHubTaskThread(hubRoot, task.id, { requireComplete: true });
  if (task.turn_count !== thread.length || task.compacted_record_count > thread.length ||
      thread.some((r, i) => r?.seq !== i + 1 || r.project_id !== task.project_id) ||
      task.has_compact !== (raw !== null) || (task.compacted_record_count > 0 && !compact) ||
      (task.compact_sha256 && task.compact_sha256 !== compactHash)) {
    return { ok: false, status: 'task_history_inconsistent', task_id: task.id, text: '',
      total_record_count: thread.length, compacted_record_count: task.compacted_record_count };
  }
  return { ok: true, raw, compact, compactHash, thread };
}

export function compileHubTaskCheckout({ hubRoot, taskId, maxTailChars = 6000 } = {}) {
  return readConsistentHub(hubRoot, () => {
    const task = readHubTasksIndex(hubRoot).tasks.find(t => t.id === Number(taskId));
    if (!task) return { ok: false, status: 'not_found', task_id: Number(taskId), text: '' };
    const history = readCheckoutHistory(hubRoot, task);
    return history.ok ? renderCheckout(task, history, maxTailChars) : history;
  });
}

function renderCheckout(task, { thread, compact, compactHash }, maxTailChars) {
  if (!Number.isSafeInteger(maxTailChars) || maxTailChars < 0) throw new RangeError('maxTailChars must be a non-negative safe integer');
  const filed = thread.findLast(row => row.role === 'assistant' && row.meta?.tools?.length);
  const tool = filed?.meta.tools.at(-1);
  const cursor = task.compacted_record_count;
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
    compact_sha256: compactHash,
    last_filed_tool: tool ? {
      thread_seq: filed.seq, turn: filed.turn, session_id: filed.meta.dsh_session_id ?? null,
      journal_seq: tool.seq ?? null, name: String(tool.name ?? 'tool').slice(0, 128),
      ...(typeof tool.call_id === 'string' && tool.call_id && { call_id: tool.call_id }),
      ok: typeof tool.ok === 'boolean' ? tool.ok : null, output: String(tool.output ?? '').slice(0, 500)
    } : null,
    text: parts.join('\n\n')
  };
}
