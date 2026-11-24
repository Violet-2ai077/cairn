import fs from 'node:fs';
import { readHubTasksIndex, readProjectsIndex, resolveHubPaths } from '../kernel/index.mjs';
import { buildHubRoutingCards, sanitizeHubRoutingText } from '../kernel/marker.mjs';
import { resolveTaskHeatPolicy, selectHubTaskPools } from '../kernel/task-heat.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';

const START_CONTINUE = /^(?:(?:please\s+)?(?:continue|resume|revisit|return to|pick up)\b|(?:请\s*)?(?:继续|接着|恢复|回到|跟进))/iu;
const START_EXACT = /^(?:(?:please\s+)?(?:continue|resume|revisit|return to|pick up|switch to|open|work on)\s+|(?:请\s*)?(?:继续|接着|恢复|回到|跟进|切到|打开)\s*)?(?:task\b\s*|任务\s*|<\|task:)#?\s*([1-9]\d{0,2})(?!\d)(?:\|>)?(?=$|[\s，。,.!！:：])/iu;

function taskReferences(text) {
  return new Set([...text.matchAll(/(?:\btask\b\s*|任务\s*|<\|task:)#?\s*([1-9]\d{0,2})(?!\d)/giu)].map(match => Number(match[1])));
}

const STOP = new Set(['continue', 'resume', 'work', 'task', 'the', 'for', 'and', 'with', 'ing', '继续', '任务', '接着', '恢复', '回到', '跟进', '项目', '之前', '这个', '切到']);

function terms(value) {
  const tokens = new Set();
  const text = sanitizeHubRoutingText(value).normalize('NFKC').toLowerCase();
  for (const match of text.matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu)) {
    const word = [...match[0]];
    if (/^\p{Script=Han}/u.test(match[0])) {
      for (let i = 1; i < word.length; i++) tokens.add(word[i - 1] + word[i]);
    } else if (word.length >= 2 && /\p{L}/u.test(match[0])) tokens.add(match[0]);
  }
  for (const token of STOP) tokens.delete(token);
  return tokens;
}

export function shortlistDormant({ userPrompt, tasks, limit }) {
  const ids = taskReferences(userPrompt);
  const query = terms(userPrompt);
  const hits = text => [...terms(text)].filter(token => query.has(token)).length;
  return tasks.map(task => ({
    task,
    score: (ids.has(task.id) ? 1000 : 0) + hits(task.title) * 3 + hits(task.project_name ?? task.project_id)
  })).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.task.id - b.task.id)
    .slice(0, limit).map(({ task }) => task);
}

export function buildHubColdRouterPrompt(tasks, { cwdProjectHint = null } = {}) {
  const cards = buildHubRoutingCards(tasks);
  return `Route the opening request to an active task, or classify as new/ambiguous. cwdProjectHint is only a soft prior, never a forced match. Return strict JSON: {"decision":"match|new|ambiguous","task_id":number|null,"project_id":string|null,"candidates":[number],"reason":"short"}. Match requires unique semantic evidence; ambiguity must not default.
cwdProjectHint=${JSON.stringify(cwdProjectHint)}
Candidates (no timestamps or turn counts):
${JSON.stringify(cards)}`;
}

function readWindow(file, tail = false) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return { text: '', clipped: false }; throw error; }
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(tail ? 16_384 : 4096, size));
    const start = tail ? size - buffer.length : 0;
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString('utf8', 0, length), clipped: start > 0 };
  } finally { fs.closeSync(fd); }
}

function readPreview(paths, id) {
  const compact = readWindow(paths.taskCompactFile(id)).text;
  if (compact.trim()) return compact;
  const { text, clipped } = readWindow(paths.taskThreadFile(id), true);
  if (clipped && !text.includes('\n')) return '';
  const lines = (clipped ? text.slice(text.indexOf('\n') + 1) : text).trim().split(/\r?\n/u);
  return lines.filter(Boolean).slice(-2).map(line => JSON.parse(line)?.content ?? '').join(' | ');
}

const failure = (error_code, llm_called = false) => ({
  ok: false, decision: null, task_id: null, project_id: null, candidates: [], llm_called, error_code
});
const newDecision = (reason, llm_called = false) => ({
  ok: true, decision: 'new', task_id: null, project_id: null, candidates: [], reason, llm_called
});
const match = (task, pool, llm_called, reason) => ({
  ok: true, decision: 'match', task_id: task.id, project_id: task.project_id ?? null,
  candidates: [task.id], pool, reason, llm_called
});

async function completeWithSignal(client, request, signal) {
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => client.complete({ ...request, signal })), aborted]);
  } finally { signal.removeEventListener('abort', cancel); }
}

async function routeCandidates(tasks, { paths, userPrompt, cwdProjectHint, client, signal, pool }) {
  if (!tasks.length) return newDecision('empty_task_catalog');
  let called = false;
  try {
    signal.throwIfAborted();
    const cards = tasks.map(task => ({ ...task, preview: readPreview(paths, task.id) }));
    called = true;
    const reply = await completeWithSignal(client, {
      system: buildHubColdRouterPrompt(cards, { cwdProjectHint }),
      messages: [{ role: 'user', content: userPrompt }], temperature: 0
    }, signal);
    signal.throwIfAborted();
    if (!reply?.ok) return failure(reply?.error_code ?? 'transport_error', true);
    let parsed;
    try { parsed = JSON.parse(String(reply.content ?? '').trim()); }
    catch { return failure('strict_json_parse_failed', true); }
    if (parsed?.decision === 'new' && parsed.task_id == null) return newDecision(String(parsed.reason ?? ''), true);
    const task = tasks.find(task => task.id === parsed?.task_id);
    if (parsed?.decision === 'match' && task && (parsed.project_id ?? null) === (task.project_id ?? null)) {
      return match(task, pool, true, String(parsed.reason ?? ''));
    }
    if (parsed?.decision === 'ambiguous' && parsed.task_id == null && Array.isArray(parsed.candidates)) {
      const candidates = [...new Set(parsed.candidates)].sort((a, b) => a - b);
      if (candidates.length >= 2 && candidates.every(id => tasks.some(task => task.id === id))) {
        return { ...newDecision(String(parsed.reason ?? ''), true), decision: 'ambiguous', candidates };
      }
    }
    return failure('invalid_router_decision', true);
  } catch {
    return failure(signal.aborted ? signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted' : called ? 'transport_error' : 'preview_unreadable', called);
  }
}

export async function runHubColdRouter({
  hubRoot, userPrompt = '', cwdProjectHint = null, llmClient = null, signal,
  taskHeat = resolveTaskHeatPolicy(), nowMs = Date.now(), timeoutMs = 2500
} = {}) {
  if (signal?.aborted) return failure('aborted');
  const projects = new Map(readProjectsIndex(hubRoot).projects.map(project => [project.project_id, project.name]));
  const tasks = readHubTasksIndex(hubRoot).tasks.map(task => ({ ...task, project_name: projects.get(task.project_id) }));
  const { hot, dormant } = selectHubTaskPools(tasks, { policy: taskHeat, nowMs });
  const prompt = String(userPrompt).trim();
  const explicit = taskHeat.enabled ? START_EXACT.exec(prompt) : null;
  if (explicit && taskReferences(prompt).size === 1) {
    const task = tasks.find(task => task.id === Number(explicit[1]));
    if (!task) return failure('task_not_found');
    if (task.status !== 'active') return failure('task_not_active');
    return match(task, dormant.some(candidate => candidate.id === task.id) ? 'dormant' : 'hot', false, 'explicit_task_id');
  }
  if (!hot.length && !dormant.length) return newDecision('empty_task_catalog');
  const client = llmClient ?? createOpenAICompatibleClient();
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new DOMException('Routing deadline', 'TimeoutError')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, clock.signal]) : clock.signal;
  const request = { paths: resolveHubPaths(hubRoot), userPrompt: prompt, cwdProjectHint, client, signal: combined };
  try {
    const first = await routeCandidates(hot, { ...request, pool: 'hot' });
    if (!first.ok || first.decision !== 'new' || !dormant.length) return first;
    if (combined.aborted) return failure(clock.signal.aborted ? 'timeout' : 'aborted', first.llm_called);
    const shortlist = shortlistDormant({ userPrompt: prompt, tasks: dormant, limit: taskHeat.dormantMaxCandidates });
    const result = shortlist.length ? await routeCandidates(shortlist, { ...request, pool: 'dormant' }) : first;
    if (result.decision === 'new' && START_CONTINUE.test(prompt)) return failure('continuation_unresolved', result.llm_called);
    return result;
  } finally { clearTimeout(timer); }
}
