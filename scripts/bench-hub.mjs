import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { appendHubTaskTurn, upsertHubTask, readScopedHead, stageScopedOperators, commitScopedStaged, initHubStore } from '../src/kernel/hub-store.mjs';
import { compileHubHandoff } from '../src/workers/hub-handoff.mjs';
import { backupHub, restoreHub } from '../src/workers/hub-recovery.mjs';
import { shortlistDormant } from '../src/workers/hub-cold-router.mjs';
import { runHubStagingExtractor } from '../src/workers/hub-staging-extractor.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['tasks', 'records', 'samples', 'output', 'tokenizer']
  .map(key => [key, { type: 'string' }])) });
function bounded(key, fallback, limit) {
  const n = Number(values[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > limit) throw Error('invalid_' + key);
  return n;
}
const tasks = bounded('tasks', 20, 1000), records = bounded('records', 20, 10000), samples = bounded('samples', 20, 1000);
function measure(fn) {
  fn(); // warm caches; do not mix setup or a disk-cold claim into these quantiles
  const observations = Array.from({ length: samples }, () => {
    const start = performance.now(); fn(); return performance.now() - start;
  }).sort((a, b) => a - b);
  const q = p => Number(observations[Math.ceil(p * samples) - 1].toFixed(3));
  return { p50_ms: q(.5), p95_ms: q(.95) };
}
function treeBytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, e) => {
    const child = path.join(dir, e.name);
    return total + (e.isDirectory() ? treeBytes(child) : fs.statSync(child).size);
  }, 0);
}
const parent = fs.realpathSync.native(os.tmpdir()), tmp = fs.mkdtempSync(path.join(parent, 'cairn-bench-'));
try {
  const root = path.join(tmp, 'hub'), scope = { scope: 'project', projectId: 'bench' };
  initHubStore(root, { extendedTaskIds: tasks > 999 });
  const cards = Array.from({ length: tasks }, (_, i) => ({ id: i + 1, title: 'Invoice reconciliation batch ' + i, project_id: 'bench' }));
  for (const card of cards) upsertHubTask(root, card);
  const startingBytes = treeBytes(root);
  for (let i = 0; i < records; i++) appendHubTaskTurn(root, { task_id: 1, project_id: 'bench', turn: i + 1,
    role: 'assistant', content: 'Reconciled fixture invoice batch ' + i + '; rerun the deterministic check before delivery.' });
  const proposal = stageScopedOperators(root, { ...scope, ops: [{ op: 'ASSERT', key: 'format', option_code: 'csv', summary: 'Use CSV.' }] });
  commitScopedStaged(root, { ...scope, proposal_id: proposal.proposal.proposal_id });
  const view = () => compileHubHandoff({ hubRoot: root, taskId: 1 });
  const text = view().text;
  const countTokens = values.tokenizer ? (await import(pathToFileURL(path.resolve(values.tokenizer)).href)).countTokens : null;
  let workerCalls = 0;
  const worker = await runHubStagingExtractor({ hubRoot: root, ...scope, turnInput: { user: 'Check one invoice.', assistant: 'Checked.' },
    llmClient: { complete: async () => { workerCalls++; return { ok: true, content: '{"ops":[]}' }; } } });
  if (!worker.ok) throw Error('benchmark_worker_failed');
  const bundle = path.join(tmp, 'backup'), restored = path.join(tmp, 'restored');
  const started = performance.now(); backupHub(root, bundle); const backed = performance.now();
  restoreHub(bundle, restored); const ended = performance.now();
  const report = { schema_version: 1, platform: process.platform, node: process.version, tasks, records, samples,
    context_snapshot: measure(view), scoped_ledger_read: measure(() => readScopedHead(root, scope)),
    dormant_shortlist: measure(() => shortlistDormant({ userPrompt: 'invoice reconciliation', tasks: cards, limit: 5 })),
    context_utf8_bytes: Buffer.byteLength(text), context_tokens: countTokens ? await countTokens(text) : null,
    tokenizer: values.tokenizer ? path.basename(values.tokenizer) : null,
    worker: { provider: 'offline_fixture', calls: workerCalls, billed_cost: 0 },
    hub_bytes: treeBytes(root), growth_bytes_since_catalog: treeBytes(root) - startingBytes,
    cold_backup_ms: +(backed - started).toFixed(3), cold_restore_ms: +(ended - backed).toFixed(3) };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) fs.writeFileSync(values.output, json);
  process.stdout.write(json);
} finally {
  if (path.dirname(tmp) === parent && path.basename(tmp).startsWith('cairn-bench-')) fs.rmSync(tmp, { recursive: true, force: true });
}
