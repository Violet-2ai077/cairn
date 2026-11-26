import fs from 'node:fs';
import { readHubTasksIndex, readProjectsIndex, resolveHubPaths } from '../kernel/index.mjs';
import { buildHubRoutingCards, sanitizeHubRoutingText } from '../kernel/marker.mjs';
import { resolveTaskHeatPolicy, selectHubTaskPools } from '../kernel/task-heat.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';

const START_CONTINUE = /^(?:(?:please\s+)?(?:continue|resume|revisit|return to|pick up)\b|(?:请\s*)?(?:继续|接着|恢复|回到|跟进))/iu;
export const isHubContinuation = text => START_CONTINUE.test(text.trim());
const START_EXACT = /^(?:(?:please\s+)?(?:continue|resume|revisit|return to|pick up|switch to|open|work on)\s+|(?:请\s*)?(?:继续|接着|恢复|回到|跟进|切到|打开)\s*)?(?:task\b\s*|任务\s*|<\|task:)#?\s*([1-9]\d*)(?!\d)(?:\|>)?(?=$|[\s，。,.!！:：])/iu;

function taskReferences(text) {
  return new Set([...text.matchAll(/(?:\btask\b\s*|任务\s*|<\|task:)#?\s*([1-9]\d*)(?!\d)/giu)].map(match => Number(match[1])));
}

const STOP = new Set(['continue', 'resume', 'work', 'task', 'the', 'for', 'and', 'with', 'ing', '继续', '任务', '接着', '恢复', '回到', '跟进', '项目', '之前', '这个', '切到']);

// A small reviewable vocabulary expands candidate recall, not binding authority.
// Matching English words (not substrings) keeps e.g. "cachet" out of cache tasks.
const concepts = [
  /\b(?:invoices?|billing)\b|发票|账单/iu, /\b(?:reconcil(?:e|ing|iation)|matching)\b|对账|核对/iu,
  /\b(?:cache|caching)\b|缓存/iu, /\b(?:invalidat(?:e|ion)|eviction)\b|失效|淘汰/iu,
  /\b(?:databases?|db)\b|数据库/iu, /\b(?:migrat(?:e|ing|ions?))\b|迁移/iu,
  /\b(?:payments?|checkout)\b|支付|付款/iu, /\b(?:retries|retry|retrying)\b|重试/iu,
  /\b(?:notifications?|alerts?)\b|通知|告警/iu, /\b(?:queues?|queueing)\b|队列/iu,
  /\b(?:backups?|backing up)\b|备份/iu, /\b(?:restor(?:e|ing|ation)|recovery)\b|还原|灾备/iu
];

function terms(value, expandConcepts = true) {
  const tokens = new Set();
  const text = sanitizeHubRoutingText(value).normalize('NFKC').toLowerCase();
  for (const match of text.matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu)) {
    const word = [...match[0]];
    if (/^\p{Script=Han}/u.test(match[0])) {
      for (let i = 1; i < word.length; i++) tokens.add(word[i - 1] + word[i]);
    } else if (word.length >= 2 && /\p{L}/u.test(match[0])) tokens.add(match[0]);
  }
  for (const token of STOP) tokens.delete(token);
  if (expandConcepts) for (const [i, pattern] of concepts.entries()) if (pattern.test(text)) tokens.add('@' + i);
  return tokens;
}

export function shortlistDormant({ userPrompt, tasks, limit, expandConcepts = true }) {
  const ids = taskReferences(userPrompt);
  const query = terms(userPrompt, expandConcepts);
  const hits = text => [...terms(text, expandConcepts)].filter(token => query.has(token)).length;
  return tasks.map(task => ({
    task,
    score: (ids.has(task.id) ? 1000 : 0) + hits(task.title) * 3 + hits(task.project_name ?? task.project_id)
  })).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.task.id - b.task.id)
    .slice(0, limit).map(({ task }) => task);
}

// Metadata can trigger a route check, never a binding. Require two terms
// that are absent from the held task to avoid paying for ordinary follow-ups.
export function mentionsCompetingTopic(input, bound, tasks) {
  const query = terms(input);
  for (const token of terms(bound.title)) query.delete(token);
  if (query.size < 2) return false;
  return tasks.some(task => {
    if (task.id === bound.id || task.status !== 'active') return false;
    const shared = [...terms(task.title)].filter(token => query.has(token));
    return shared.filter(term => term.startsWith('@')).length >= 2 ||
      shared.filter(term => !term.startsWith('@')).length >= 2;
  });
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

function readRecentRecords(paths, id) {
  const { text, clipped } = readWindow(paths.taskThreadFile(id), true);
  if (clipped && !text.includes('\n')) return [];
  const lines = (clipped ? text.slice(text.indexOf('\n') + 1) : text).trim().split(/\r?\n/u);
  return lines.filter(Boolean).slice(-2).map(line => JSON.parse(line));
}

function readPreview(paths, id) {
  const compact = readWindow(paths.taskCompactFile(id)).text;
  return compact.trim() ? compact : readRecentRecords(paths, id).map(r => r.content ?? '').join(' | ');
}

// Menu labels enter native conversation history. Do not echo candidate transcripts or raw logs.
export function taskPickerHint(paths, task) {
  const evidence = readRecentRecords(paths, task.id).flatMap(r => r.meta?.tools ?? []);
  const last = evidence.at(-1);
  if (last) {
    const tool = /^[\w.-]{1,60}$/u.test(last.name) ? last.name : '工具';
    return `上次工具记录：${tool} ${last.ok === false ? '失败' : '已运行'}`;
  }
  return task.has_compact ? '有已保存的任务摘要' : task.turn_count ? '有已保存的任务记录' : '尚无归档记录';
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
  if (!hot.length && !dormant.length) return isHubContinuation(prompt) ? failure('continuation_unresolved') : newDecision('empty_task_catalog');
  const client = llmClient ?? createOpenAICompatibleClient();
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new DOMException('Routing deadline', 'TimeoutError')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, clock.signal]) : clock.signal;
  const request = { paths: resolveHubPaths(hubRoot), userPrompt: prompt, cwdProjectHint, client, signal: combined };
  try {
    const first = await routeCandidates(hot, { ...request, pool: 'hot' });
    if (!first.ok || first.decision !== 'new') return first;
    if (combined.aborted) return failure(clock.signal.aborted ? 'timeout' : 'aborted', first.llm_called);
    const shortlist = shortlistDormant({ userPrompt: prompt, tasks: dormant, limit: taskHeat.dormantMaxCandidates });
    const result = shortlist.length ? await routeCandidates(shortlist, { ...request, pool: 'dormant' }) : first;
    if (result.decision === 'new' && isHubContinuation(prompt)) return failure('continuation_unresolved', result.llm_called);
    return result;
  } finally { clearTimeout(timer); }
}
