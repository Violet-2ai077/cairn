import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evaluateAttribution } from '../scripts/eval-attribution.mjs';
import { evaluateExposure, evaluatePreferences, evaluateRetrieval } from '../scripts/eval-reliability.mjs';
import { catalog } from '../scripts/fixtures/reliability-corpus.mjs';
import { mentionsCompetingTopic, runHubColdRouter, shortlistDormant } from '../src/workers/hub-cold-router.mjs';
import { hasSingleTaskHistory } from '../src/hosts/dsh/single-task-session.mjs';
import { resolveMidSessionPolicy } from '../src/hosts/dsh/hub-turn-runtime.mjs';
import { recordTurnReceipt, upsertHubTask, readSessionBinding } from '../src/kernel/hub-store.mjs';
import { resolveTaskHeatPolicy } from '../src/kernel/task-heat.mjs';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-test-quality-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('bilingual terms improve ranking on the labelled ablation without binding a candidate', async t => {
  const tasks = catalog(20), prompt = '继续做账单核对';
  assert.deepEqual(shortlistDormant({ userPrompt: prompt, tasks, limit: 5, expandConcepts: false }), []);
  assert.equal(shortlistDormant({ userPrompt: prompt, tasks, limit: 5 })[0].id, 1);
  assert.equal(mentionsCompetingTopic('invoice', tasks[1], tasks), false, 'one word and its alias are not two cues');
  assert.equal(mentionsCompetingTopic(prompt, tasks[1], tasks), true);
  assert.ok(evaluateRetrieval(999,true).recall_at_5 > evaluateRetrieval(999,false).recall_at_5);
  const root = scratch(t);
  upsertHubTask(root, tasks[0]);
  let calls = 0;
  const result = await runHubColdRouter({ hubRoot: root, userPrompt: prompt, taskHeat: resolveTaskHeatPolicy({ enabled: true }),
    llmClient: { async complete({ system }) { calls++; assert.match(system,/Invoice reconciliation/u); return { ok: true, content: '{"decision":"new"}' }; } } });
  assert.equal(calls, 1);
  assert.equal(result.error_code, 'continuation_unresolved');
  assert.equal(readSessionBinding(root,'fixture'), null);
});

test('separate-session rejects unknown lineage, crossed, recovered, missing or interrupted history; default stays native', t => {
  const root = scratch(t), session = { id: 's', inheritedEventCount: 0 };
  assert.equal(resolveMidSessionPolicy({ enabled: true }).historyMode, 'native');
  assert.throws(() => resolveMidSessionPolicy({ midSessionSwitch: { historyMode: 'separate-session' } }), /invalid_history_mode/);
  const check = (turn, task = 1, obj = session) => hasSingleTaskHistory(root,obj,'s',turn,task);
  assert.equal(check(1),true);
  for (const obj of [{ id: 's' }, { ...session, id: 'other' }, { ...session, inheritedEventCount: 3 }]) assert.equal(check(1,1,obj),false);
  assert.equal(check(2),false);
  recordTurnReceipt(root,'s',1,{ status:'archived',reason:'confirmed_marker',task_id:1 });
  assert.equal(check(2),true);
  assert.equal(check(2,2),false);
  recordTurnReceipt(root,'s',2,{ status:'interrupted',reason:'not_completed' });
  assert.equal(check(3),false);
  recordTurnReceipt(root,'s',2,{ status:'archived',reason:'manual_recovery',task_id:1 });
  assert.equal(check(3),false);
});

test('marker shadow uses verified native text only; disagreement, unresolved, edited and incomplete remain unassigned', async t => {
  const x = await evaluateAttribution(scratch(t));
  for (const key of ['mismatch','malformed','unresolved','interrupted','edited-journal']) {
    assert.equal(x.rows.find(r => r.id === key).shadow,null,key);
  }
  const missing = x.rows.find(r => r.id === 'missing');
  assert.deepEqual([missing.strict, missing.shadow],[null,1]);
  const wrong = x.rows.find(r => r.id === 'wrong-scope-missing');
  assert.notEqual(wrong.shadow, wrong.truth);
  assert.equal(x.strict.observed_human_recovery_rate,null);
});

test('preference error rates distinguish missed natural language from unauthorized or duplicate memory', t => {
  const p = evaluatePreferences(scratch(t));
  assert.equal(p.false_positive_rate,0);
  assert.ok(p.missed_preference_rate > 0 && p.missed_preference_rate < 1);
  assert.deepEqual(p.review_outcomes,['committed','conflict','conflict']);
  assert.deepEqual(evaluateExposure().map(c => c.stale_facts_visible),[4,4,4,0,0]);
});

test('optional provider evaluation meters real HTTP calls independently of offline metrics (scripted loopback, not a model)', async t => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const sent = JSON.parse(Buffer.concat(parts));
    assert.equal(sent.model, 'loopback-fixture');
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"decision":"new","ops":[]}' } }], usage: { total_tokens: 12 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const script = fileURLToPath(new URL('../scripts/eval-reliability.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--live'], { env: { ...process.env,
    CAIRN_MODEL:'loopback-fixture', CAIRN_API_KEY:'fixture', CAIRN_API_BASE:'http://127.0.0.1:' + server.address().port } });
  const { live } = JSON.parse(stdout);
  assert.equal(live.calls, requests);
  assert.equal(live.total_tokens, 12 * requests);
  assert.equal(live.conflicts.length, 10);
  assert.ok(live.marker.every(r => !r.matched));
  assert.equal(live.expected_draft_option_accuracy, 0);
});
