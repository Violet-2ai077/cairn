import path from 'node:path';
import { buildStrictCompactorPrompt, readHubTaskCompaction, readHubTaskThread, readHubTasksIndex, readScopedHead, projectReadOnlyLedger, writeHubTaskCompaction } from '../kernel/index.mjs';
import { distillTaskThread } from './distill.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';

function exclusionWatchlist(...heads) {
  const keys = new Set(); const options = new Set();
  for (const head of heads) {
    for (const item of [...(head?.active ?? []), ...(head?.tombstones ?? [])]) { if (item.key) keys.add(item.key); if (item.option_code) options.add(item.option_code); }
    for (const item of head?.open_questions ?? []) if (item.key) keys.add(item.key);
  }
  return keys.size || options.size ? `### Applicable User / Project Ledger exclusion watchlist\nKeys: ${[...keys].join(', ')}\nOptions: ${[...options].join(', ')}\nDo not copy these global decisions into task-local compact output.` : '';
}

export async function runHubStrictCompactor({ hubRoot, taskId, mode = 'incremental', llmClient = null, signal, maxEmptyRetries = 1 } = {}) {
  const id = Number(taskId);
  const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === id);
  if (!task) return { ok: false, skipped: true, reason: 'task_not_found', task_id: id, llm_called: false };
  const records = readHubTaskThread(hubRoot, id);
  const oldCount = task.compacted_record_count;
  const compact = readHubTaskCompaction(hubRoot, id);
  if (task.status !== 'active') return { ok: false, skipped: true, reason: 'task_not_active', task_id: id, task_status: task.status, compacted_record_count: oldCount };
  const target = mode === 'full' ? records : records.slice(oldCount);
  if (!target.length) return { ok: true, skipped: true, reason: 'no_new_turns', task_id: id, compacted_record_count: oldCount, compact_markdown: compact };
  const userHead = projectReadOnlyLedger(readScopedHead(hubRoot, { scope: 'user' }), { includeTombstones: true });
  const projectHead = task.project_id ? projectReadOnlyLedger(readScopedHead(hubRoot, { scope: 'project', projectId: task.project_id }), { includeTombstones: true }) : null;
  const watchlist = exclusionWatchlist(userHead, projectHead);
  const system = [buildStrictCompactorPrompt({ taskId: id }), watchlist].filter(Boolean).join('\n\n');
  const distilled = distillTaskThread(target);
  const user = mode !== 'full' && compact ? `### Previous task-local summary\n${compact}\n\n### New task records\n${distilled.distilled_text}\n\nMerge without adding global rules.` : distilled.distilled_text;
  const client = llmClient ?? createOpenAICompatibleClient();
  let attempts = 0; let response;
  do {
    if (signal?.aborted) return { ok: false, reason: 'aborted', error_code: 'aborted', attempts, task_id: id, compacted_record_count: oldCount };
    attempts++;
    try { response = await client.complete({ system, messages: [{ role: 'user', content: user }], temperature: 0, signal }); }
    catch (error) {
      if (signal?.aborted) return { ok: false, reason: 'aborted', error_code: 'aborted', attempts, task_id: id, compacted_record_count: oldCount };
      return { ok: false, reason: 'llm_error', error_code: 'llm_error', attempts, task_id: id, compacted_record_count: oldCount };
    }
    if (!response.ok) return { ok: false, reason: 'llm_error', error_code: response.error_code, attempts, task_id: id, compacted_record_count: oldCount };
    if (String(response.content ?? '').trim()) break;
  } while (attempts <= Math.max(0, maxEmptyRetries));
  const content = String(response.content ?? '').trim();
  if (!content) return { ok: false, reason: 'empty_compaction_output', attempts, raw_response_length: String(response.content ?? '').length, finish_reason: response.finish_reason ?? response.metadata?.finish_reason ?? null, task_id: id, compacted_record_count: oldCount };
  if (signal?.aborted) return { ok: false, reason: 'aborted', error_code: 'aborted', attempts, task_id: id, compacted_record_count: oldCount };
  const current = readHubTasksIndex(hubRoot).tasks.find(item => item.id === id);
  if (!current || current.status !== 'active') return { ok: false, skipped: true, reason: current ? 'task_not_active' : 'task_not_found', task_id: id, compacted_record_count: oldCount };
  const nextCount = mode === 'full' ? records.length : Math.max(oldCount, ...target.map(record => Number(record.seq) || 0));
  const updated = writeHubTaskCompaction(hubRoot, id, content, Math.min(records.length, nextCount));
  return { ok: true, task_id: id, attempts, raw_response_length: String(response.content ?? '').length, compacted_record_count: updated.compacted_record_count, compact_markdown: content };
}

export function createHubTaskCompactionCoordinator({ hubRoot, cooldownMs = 300000, compactor = runHubStrictCompactor, now = () => Date.now() } = {}) {
  const root = path.resolve(hubRoot); const locks = new Map(); const states = new Map(); const pending = new Set();
  async function execute({ taskId, source = 'manual', mode = 'incremental', llmClient = null, signal } = {}) {
    const key = `${root}:${Number(taskId)}`; const existing = states.get(key);
    if (source === 'auto' && existing?.cooldown_until > now()) return { ok: false, skipped: true, reason: 'cooldown', task_id: Number(taskId), cooldown_until: existing.cooldown_until };
    const previous = locks.get(key) ?? Promise.resolve(); let release;
    const gate = new Promise(resolve => { release = resolve; }); const tail = previous.catch(() => {}).then(() => gate); locks.set(key, tail); await previous.catch(() => {});
    try {
      const currentState = states.get(key);
      if (source === 'auto' && currentState?.cooldown_until > now()) return { ok: false, skipped: true, reason: 'cooldown', task_id: Number(taskId), cooldown_until: currentState.cooldown_until };
      const task = readHubTasksIndex(root).tasks.find(item => item.id === Number(taskId));
      if (!task || task.status !== 'active') return { ok: false, skipped: true, reason: task ? 'task_not_active' : 'task_not_found', task_id: Number(taskId), llm_called: false };
      states.set(key, { status: 'running', source, task_id: Number(taskId), updated_at: now() });
      const result = await compactor({ hubRoot: root, taskId, mode, llmClient, signal });
      if (result.ok) states.set(key, { status: 'succeeded', source, task_id: Number(taskId), compacted_record_count: result.compacted_record_count, updated_at: now() });
      else if (source === 'auto' && !result.skipped) states.set(key, { status: 'cooldown', source, task_id: Number(taskId), reason: result.reason, cooldown_until: now() + cooldownMs, updated_at: now() });
      else states.set(key, { status: 'failed', source, task_id: Number(taskId), reason: result.reason, updated_at: now() });
      return result;
    } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
  }
  function run(options = {}) { const promise = execute(options); pending.add(promise); promise.finally(() => pending.delete(promise)); return promise; }
  return Object.freeze({ run, getTaskStatus: id => ({ ...(states.get(`${root}:${Number(id)}`) ?? { status: 'idle', task_id: Number(id) }) }), async flush() { while (pending.size) await Promise.allSettled([...pending]); } });
}
