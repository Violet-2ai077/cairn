import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { shortlistDormant, runHubColdRouter } from '../src/workers/hub-cold-router.mjs';
import { createOpenAICompatibleClient } from '../src/workers/llm-client.mjs';
import { splitMemoryIntent, draftPreference } from '../src/workers/memory-intent.mjs';
import { appendHubTaskTurnPair, readScopedHead, upsertHubTask } from '../src/kernel/hub-store.mjs';
import { openMemoryReview, prepareMemoryReview, resolveMemoryReview } from '../src/kernel/memory-review.mjs';
import { resolveTaskHeatPolicy } from '../src/kernel/task-heat.mjs';
import { parseTaskMarker } from '../src/kernel/marker.mjs';
import { catalog, conflictMessages, preferences, queries, revision } from './fixtures/reliability-corpus.mjs';
import { evaluateAttribution } from './eval-attribution.mjs';

const modes = ['native', 'switch', 'ledger', 'separate-session', 'projected'];
const pct = (v, n) => [...v].sort((a,b) => a-b)[Math.ceil(v.length * n) - 1] ?? null;
const rate = (n, d) => d ? n / d : null;
export function evaluateRetrieval(size, expandConcepts) {
  const tasks = catalog(size), samples = [], rows = [];
  for (const [id, text, truth] of queries) {
    const t = performance.now();
    const ranked = shortlistDormant({ tasks, userPrompt: text, limit: 10, expandConcepts }).map(c => c.id);
    samples.push(performance.now() - t);
    rows.push({ id, truth, ranked });
  }
  const unique = rows.filter(r => r.truth.length === 1);
  const recall = k => rate(unique.filter(r => r.ranked.slice(0,k).includes(r.truth[0])).length, unique.length);
  return { size, expandConcepts, unique_queries: unique.length, recall_at_5: recall(5), recall_at_10: recall(10),
    ranking_top_1: recall(1), shortlist_p50_ms: pct(samples,.5), shortlist_p95_ms: pct(samples,.95),
    token_cost: 0, rows };
}

export function evaluatePreferences(hub) {
  const rows = preferences.map(([id, text, truth]) => ({
    id, truth, actual: splitMemoryIntent(text, 'alpha').cards.map(card => card.scopes.join('+'))
  }));
  const negatives = rows.filter(r => !r.truth.length), positives = rows.filter(r => r.truth.length);
  const count = fn => positives.reduce((n, r) => n + fn(r), 0);
  // The repeated and changed preferences use the real protected review store. Only
  // this synthetic human confirmation may commit; generation alone cannot.
  const decisions = ['zh', 'zh', 'en'].map((code, n) => {
    const id = (n + 1) + '.1', quote = code === 'zh' ? '所有项目默认中文' : '所有项目默认英文';
    openMemoryReview(hub, 'review', id, { quote, scopes: ['user'] }, null);
    prepareMemoryReview(hub, 'review', id, { op: 'ASSERT', key: 'reply_language', option_code: code, summary: quote });
    return resolveMemoryReview(hub, 'review', id, 'user').status;
  });
  const active = readScopedHead(hub).active;
  return { rows, negative_cases: negatives.length, false_positive_rate: rate(negatives.filter(r => r.actual.length).length, negatives.length),
    missed_preference_rate: rate(count(r => Math.max(0, r.truth.length-r.actual.length)), count(r => r.truth.length)),
    scope_accuracy: rate(count(r => r.truth.filter((scope,i) => r.actual[i] === scope).length), count(r => r.truth.length)),
    duplicate_commit_rate: Number(decisions[1] === 'committed'), conflict_handling_accuracy: Number(decisions[2] === 'conflict' && active.length === 1 && active[0].option_code === 'zh'),
    review_outcomes: decisions };
}

export function evaluateExposure() {
  return modes.map(mode => {
    const { messages, old, current } = conflictMessages(mode), body = messages.map(m => m.content).join('\n');
    return { mode, bytes: Buffer.byteLength(body), stale_facts_visible: old.filter(f => body.includes(f)).length,
      target_facts_visible: current.filter(f => body.includes(f)).length };
  });
}

async function evaluateLive(hub) {
  const model = process.env.CAIRN_MODEL;
  if (!model || !(process.env.CAIRN_API_KEY || process.env.DEEPSEEK_API_KEY)) throw new Error('--live requires CAIRN_MODEL and a configured worker API key');
  const client = createOpenAICompatibleClient({ model, maxTransportRetries: 0 });
  let tokens = 0, calls = 0, measured = 0, failures = 0;
  const reportedModels = new Set();
  const metered = { async complete(req) {
    ++calls;
    const r = await client.complete(req);
    if (!r.ok) failures++;
    else if (r.model) reportedModels.add(r.model);
    if (Number.isFinite(r.usage?.total_tokens)) { tokens += r.usage.total_tokens; measured++; }
    return r;
  } };
  for (const task of catalog(20)) upsertHubTask(hub, task);
  for (const [taskId, projectId, assistant, activity] of [[9, 'docs', 'We chose Ghostscript.', false], [20, 'satellite-8', 'Telemetry checked.', true]])
    appendHubTaskTurnPair(hub, { taskId, projectId, assistant, activity, user: 'Record the decision.', sessionId: 'fixture', turn: 1 });
  const routeRows = [];
  for (const [id, text, truth] of queries) {
    const started = performance.now(), before = tokens, c = calls, m = measured;
    const r = await runHubColdRouter({ hubRoot: hub, userPrompt: text, taskHeat: resolveTaskHeatPolicy({ enabled: true }),
      llmClient: metered, timeoutMs: 60000 });
    routeRows.push({ id, truth, decision: r.decision, task: r.task_id, error: r.error_code ?? null,
      elapsed_ms: performance.now()-started, calls: calls-c, tokens: measured-m === calls-c ? tokens-before : null });
  }
  const conflicts = [];
  for (const mode of modes) for (const reverse of [false,true]) {
    const { messages, old, current } = conflictMessages(mode, reverse);
    const r = await metered.complete({ messages, temperature: 0, maxTokens: 128 });
    // Score intended choices by words/paths, not tool execution; no tools are connected.
    const words = String(r.content ?? '').toLowerCase().match(/[\w./-]+/gu) ?? [];
    conflicts.push({ mode, reverse, error: r.error_code ?? null, wrong_db_file_tool_test: r.ok ? old.map(f => words.includes(f)) : null,
      recovered_db_file_tool_test: r.ok ? current.map(f => words.includes(f)) : null, tokens: r.usage?.total_tokens ?? null });
  }
  const marker = [];
  for (const language of ['en', 'zh']) for (const id of [9, 672]) {
    const r = await metered.complete({ system: 'Required tail marker for this request: <|task:' + id + '|>.',
      messages: [{ role: 'user', content: language === 'zh' ? '用一个词说出水的固态。' : 'Name the solid form of water in one word.' }], maxTokens: 128 });
    const parsed = parseTaskMarker(r.content ?? '');
    marker.push({ language, id, matched: r.ok ? parsed.task_number === id : null, marker_valid: r.ok ? parsed.valid : null, error: r.error_code ?? null });
  }
  const drafts = [];
  const expectedOptions = { explicit:['zh'], two:['zh','en'], 'unclear-scope':['zh'], change:['en'],
    repeat:['zh'], 'mixed-language':['zh'], indirect:['concise'] };
  for (const [id, text] of preferences) {
    const cards = splitMemoryIntent(text, 'alpha').cards, expected = expectedOptions[id] ?? [];
    for (let i = 0; i < Math.max(cards.length, expected.length); i++) {
      try {
        const op = cards[i] ? await draftPreference(metered, cards[i]) : null;
        drafts.push({ id, expected: expected[i] ?? null, proposed: op !== null, key: op?.key ?? null, option: op?.option_code ?? null });
      } catch (err) { drafts.push({ id, expected: expected[i] ?? null, error: err.message }); }
    }
  }
  const bound = routeRows.filter(r => r.decision === 'match'), unique = routeRows.filter(r => r.truth.length === 1);
  const elapsed = routeRows.map(r => r.elapsed_ms);
  return { model, reported_models: [...reportedModels], calls, failed_calls: failures, metered_calls: measured,
    total_tokens: calls === measured ? tokens : null, reported_tokens: tokens,
    route: { rows: routeRows, top1: rate(unique.filter(r => r.truth[0] === r.task).length, unique.length),
      false_binding_per_match: rate(bound.filter(r => r.truth.length !== 1 || r.task !== r.truth[0]).length,bound.length),
      clarify_per_query: rate(routeRows.filter(r => r.decision === 'ambiguous' || r.error === 'continuation_unresolved').length,routeRows.length),
      p50_ms: pct(elapsed,.5), p95_ms: pct(elapsed,.95) }, conflicts, marker, drafts,
    expected_draft_option_accuracy: rate(drafts.filter(d => d.expected && d.option === d.expected).length, drafts.filter(d => d.expected).length) };
}

export async function evaluateReliability({ live = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-quality-'));
  try {
    return { revision, evidence: 'deterministic synthetic fixtures; no live model unless live is populated',
      retrieval: [20,50,100,500,1000].flatMap(size => [false,true].map(flag => evaluateRetrieval(size,flag))),
      attribution: await evaluateAttribution(path.join(root,'markers')),
      preferences: evaluatePreferences(path.join(root,'prefs')), conflict_prompt_exposure: evaluateExposure(),
      live: live ? await evaluateLive(path.join(root,'live')) : null };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(a => a !== '--live')) throw new Error('Usage: node scripts/eval-reliability.mjs [--live]');
    console.log(JSON.stringify(await evaluateReliability({ live: process.argv.includes('--live') }), null, 2));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
