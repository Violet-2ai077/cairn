import path from 'node:path';

import { normalizeTaskId, readTasksIndex } from '../kernel/index.mjs';
import { runStrictCompactor } from './strict-compactor.mjs';

export function createTaskCompactionCoordinator({
  workspaceRoot = process.cwd(),
  cooldownMs = 300000,
  compactor = runStrictCompactor,
  now = () => Date.now()
} = {}) {
  const root = path.resolve(workspaceRoot);
  const locks = new Map();
  const states = new Map();
  const pending = new Set();

  function keyFor(taskId) {
    return `${root}:${normalizeTaskId(taskId)}`;
  }

  function setState(key, state) {
    states.set(key, { ...state, updated_at: now() });
  }

  async function execute(options) {
    const { taskId, source = 'manual', mode = 'incremental', llmClient = null, signal } = options;
    const id = normalizeTaskId(taskId);
    const key = keyFor(id);
    const existingState = states.get(key);
    if (source === 'auto' && existingState?.cooldown_until > now()) {
      return { ok: false, skipped: true, reason: 'cooldown', task_id: id, cooldown_until: existingState.cooldown_until };
    }

    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const lockGate = new Promise(resolve => { release = resolve; });
    const lockTail = previous.catch(() => {}).then(() => lockGate);
    locks.set(key, lockTail);
    await previous.catch(() => {});

    try {
      if (source === 'auto' && states.get(key)?.cooldown_until > now()) {
        return { ok: false, skipped: true, reason: 'cooldown', task_id: id, cooldown_until: states.get(key).cooldown_until };
      }
      const task = readTasksIndex(root).tasks.find(entry => entry.id === id);
      if (!task) {
        setState(key, { status: 'idle', task_id: id, source, reason: 'task_not_found' });
        return { ok: false, skipped: true, reason: 'task_not_found', task_id: id, llm_called: false };
      }
      if (task.status !== 'active') {
        setState(key, { status: 'idle', task_id: id, source, reason: 'task_not_active', task_status: task.status });
        return { ok: false, skipped: true, reason: 'task_not_active', task_id: id, task_status: task.status, llm_called: false };
      }

      setState(key, { status: 'running', task_id: id, source, mode, started_at: now() });
      const result = await compactor({ workspaceRoot: root, taskId: id, mode, llmClient, signal });
      if (result.reason === 'task_not_active' || result.reason === 'task_not_found') {
        setState(key, { status: 'idle', task_id: id, source, reason: result.reason });
        return result;
      }
      if (result.ok) {
        setState(key, { status: 'succeeded', task_id: id, source, mode, completed_at: now(), compacted_record_count: result.compacted_record_count });
        return result;
      }

      const failedAt = now();
      const cooldownUntil = source === 'auto' ? failedAt + Math.max(0, cooldownMs) : existingState?.cooldown_until;
      setState(key, {
        status: cooldownUntil > failedAt ? 'cooldown' : 'failed',
        task_id: id,
        source,
        mode,
        reason: result.reason ?? 'compaction_failed',
        error_code: result.error_code ?? result.reason ?? 'compaction_failed',
        attempts: result.attempts ?? 0,
        ...(cooldownUntil > failedAt ? { cooldown_until: cooldownUntil } : {})
      });
      return result;
    } finally {
      release();
      if (locks.get(key) === lockTail) locks.delete(key);
    }
  }

  function run(options = {}) {
    const promise = execute(options);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  function getTaskStatus(taskId) {
    const state = states.get(keyFor(taskId));
    return state ? { ...state } : { status: 'idle', task_id: normalizeTaskId(taskId) };
  }

  function clearTask(taskId) {
    const key = keyFor(taskId);
    if (locks.has(key)) return false;
    states.delete(key);
    return true;
  }

  function recordSkipped(taskId, reason) {
    const id = normalizeTaskId(taskId);
    const key = keyFor(id);
    setState(key, { status: 'skipped', task_id: id, source: 'auto', reason });
  }

  function recordQueued(taskId) {
    const id = normalizeTaskId(taskId);
    setState(keyFor(id), { status: 'pending', task_id: id, source: 'auto' });
  }

  async function flush() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  return Object.freeze({ run, getTaskStatus, clearTask, recordSkipped, recordQueued, flush });
}
