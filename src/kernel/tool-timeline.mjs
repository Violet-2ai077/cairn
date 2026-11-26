import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readHubTasksIndex, readSessionBinding, readTurnReceipts, resolveHubPaths } from './hub-store.mjs';
import { readConsistentHub, withHubWriteLock } from './hub-write-lock.mjs';
import { writeJsonAtomic } from './store.mjs';

const seq = n => Number.isSafeInteger(n) && n >= 0;
const turnKey = (session, turn) => createHash('sha256').update(JSON.stringify([session, turn])).digest('hex');
const pageName = (key, n) => key + '-' + Math.floor(n / 64) + '.json';
const timelineDir = (root, taskId) => path.join(resolveHubPaths(root).taskDir(taskId), 'tool-timeline');
const eventKeys = new Set(['kind', 'journal_seq', 'step', 'name', 'call_id', 'ok', 'call_seq']);

function readPage(file) {
  const page = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = turnKey(page?.session_id, page?.turn);
  const valid = Array.isArray(page?.events) && page.events.length <= 64 && seq(page.turn) && typeof page.session_id === 'string' &&
    page.events.every(e => e && Object.keys(e).every(k => eventKeys.has(k)) && seq(e.journal_seq) &&
      pageName(key, e.journal_seq) === path.basename(file) && seq(e.step) && e.step >= 1 &&
      typeof e.name === 'string' && (!Object.hasOwn(e, 'call_id') || typeof e.call_id === 'string') &&
      (e.kind === 'call' ? e.ok === undefined && e.call_seq === undefined : e.kind === 'result' && typeof e.ok === 'boolean' &&
        (e.call_seq === undefined || seq(e.call_seq) && e.call_seq < e.journal_seq)));
  if (!valid || new Set(page.events.map(e => e.journal_seq)).size !== page.events.length) throw new Error('tool_timeline_invalid');
  return page;
}

// Fixed-size atomic pages survive an interrupted writer without rewriting a growing turn.
// Explicit field allowlist: no native arguments, output, errors, or request text.
export function recordToolFact(root, { sessionId, turn, taskId, projectId, bindingEpoch, step, journalSeq, kind, callId, name, ok, callSeq }) {
  if (!bindingEpoch || !sessionId || !seq(turn) || !seq(journalSeq) || !seq(step) || step < 1 ||
      !['call', 'result'].includes(kind) || (kind === 'result' && typeof ok !== 'boolean')) return false;
  return withHubWriteLock(root, () => {
    const binding = readSessionBinding(root, sessionId);
    const receipt = readTurnReceipts(root, sessionId, turn);
    if (binding?.binding_epoch !== bindingEpoch || binding.task_id !== taskId || binding.project_id !== projectId ||
        (receipt && receipt.status !== 'in_progress') ||
        !readHubTasksIndex(root).tasks.some(t => t.id === taskId && t.status === 'active' && t.project_id === projectId)) return false;
    const file = path.join(timelineDir(root, taskId), pageName(turnKey(sessionId, turn), journalSeq));
    const page = fs.existsSync(file) ? readPage(file) : { session_id: sessionId, turn, events: [] };
    if (page.events.some(e => e.journal_seq === journalSeq)) return false;
    page.events.push({ kind, journal_seq: journalSeq, step, name: String(name ?? 'tool').slice(0, 128),
      ...(typeof callId === 'string' && callId && { call_id: callId }),
      ...(kind === 'result' && { ok, ...(seq(callSeq) && callSeq < journalSeq && { call_seq: callSeq }) }) });
    writeJsonAtomic(file, page);
    return true;
  });
}

// Operator-only query. This unabridged metadata is not part of a model's checkout prompt.
export function readToolTimeline(root, taskId, { sessionId, turn } = {}) {
  return readConsistentHub(root, () => {
    if (!readHubTasksIndex(root).tasks.some(t => t.id === taskId)) throw new Error('task_not_found');
    const dir = timelineDir(root, taskId), groups = new Map();
    const prefix = sessionId && turn != null ? turnKey(sessionId, turn) + '-' : '';
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !/^[a-f0-9]{64}-\d+\.json$/u.test(entry.name)) continue;
      const page = readPage(path.join(dir, entry.name));
      if ((sessionId && sessionId !== page.session_id) || (turn != null && turn !== page.turn)) continue;
      const key = JSON.stringify([page.session_id, page.turn]);
      if (!groups.has(key)) groups.set(key, { session_id: page.session_id, turn: page.turn, events: [] });
      groups.get(key).events.push(...page.events);
    }
    const turns = [...groups.values()].sort((a, b) => a.session_id.localeCompare(b.session_id) || a.turn - b.turn);
    return { task_id: taskId, turns: turns.map(({ session_id, turn, events }) => {
      const calls = new Map(), byId = new Map(), unmatched_results = [];
      for (const { kind, ...e } of events.sort((a, b) => a.journal_seq - b.journal_seq)) {
        if (kind === 'call') {
          const call = { ...e, result_status: 'unknown', results: [] };
          calls.set(e.journal_seq, call);
          if (e.call_id) byId.set(e.call_id, byId.has(e.call_id) ? null : call);
        } else if (kind === 'result') {
          const call = e.call_seq != null ? calls.get(e.call_seq) : byId.get(e.call_id);
          if (!call || (e.call_id && call.call_id && e.call_id !== call.call_id)) unmatched_results.push(e);
          else { call.result_status = 'observed'; call.results.push(e); }
        } else throw new Error('tool_timeline_invalid');
      }
      return { session_id, turn, calls: [...calls.values()], unmatched_results };
    }) };
  });
}
