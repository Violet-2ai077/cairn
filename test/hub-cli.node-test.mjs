import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCairnCli, runCairnCliAsync } from '../bin/cairn.mjs';
import { upsertHubTask, appendHubTaskTurn, stageScopedOperators, commitScopedStaged, readScopedLedgerLog } from '../src/kernel/hub-store.mjs';

test('Hub commit reports rejected or missing proposals and compact handles missing cwd', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cli-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = [], io = { stdout: s => out.push(s), stderr: s => out.push(s) };
  const run = (...args) => runCairnCli([...args, '--store', root], io);
  assert.equal(run('init'), 0);
  assert.equal(JSON.parse(out.at(-1)).initialized, true);
  assert.equal(run('commit', 'stg_999'), 1);
  assert.equal(JSON.parse(out.at(-1)).reason, 'proposal_not_found');
  const { proposal } = stageScopedOperators(root, { ops: [{ op: 'ASSERT' }] });
  assert.equal(run('commit', proposal.proposal_id), 1);
  assert.equal(JSON.parse(out.at(-1)).reason, 'all_operators_rejected');
  assert.equal(await runCairnCliAsync(['compact', '1', '--cwd'], io), 1);
  assert.match(out.at(-1), /Use compact/u);
});

test('Hub CLI revert requires explicit scope, supports read-only preview, and appends a revert event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cli-revert-'));
  try {
    const { proposal } = stageScopedOperators(root, { ops: [{ op: 'ASSERT', key: 'editor', option_code: 'vim', summary: 'Vim' }] });
    commitScopedStaged(root, { proposal_id: proposal.proposal_id });
    const out = [];
    const run = (...args) => runCairnCli([...args, '--store', root, '--json'], { stdout: msg => out.push(msg), stderr: msg => out.push(msg) });
    assert.equal(run('revert', '1', '--reason', 'mistake'), 1);
    assert.equal(run('revert', '1', '--scope', 'user', '--reason', 'mistake', '--preview'), 0);
    assert.equal(JSON.parse(out.at(-1)).status, 'preview');
    assert.equal(readScopedLedgerLog(root).length, 1);
    assert.equal(run('revert', '1', '--scope', 'user', '--reason', 'mistake'), 0);
    assert.equal(readScopedLedgerLog(root).at(-1).kind, 'revert');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hub tasks CLI reports derived pool and unchanged lifecycle in text and JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cli-task-heat-'));
  try {
    upsertHubTask(root, { id: 1, title: 'Old' });
    appendHubTaskTurn(root, { task_id: 1, content: 'old turn', timestamp: '2000-01-01T00:00:00Z' });
    upsertHubTask(root, { id: 2, title: 'Closed' });
    const out = [];
    const run = (...args) => runCairnCli([...args, '--store', root], { stdout: msg => out.push(msg), stderr: msg => out.push(msg) });
    assert.equal(run('close', '2'), 0);
    assert.equal(run('tasks', '--task-heat', '--all', '--json'), 0);
    assert.deepEqual(JSON.parse(out.at(-1)).tasks.map(task => [task.status, task.pool]), [['active', 'dormant'], ['done', 'excluded']]);
    assert.equal(run('tasks', '--all'), 0);
    assert.match(out.at(-1), /active.*hot.*Old/u);
    assert.match(out.at(-1), /done.*excluded.*Closed/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hub CLI keeps task checkout preview read-only and requires session for binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-cli-'));
  const output = [];
  const io = { stdout: value => output.push(value), stderr: value => output.push(value) };
  try {
    assert.equal(runCairnCli(['init', '--store', root, '--json'], io), 0);
    upsertHubTask(root, { id: 1, project_id: null, title: 'General task' });
    appendHubTaskTurn(root, { task_id: 1, project_id: null, turn: 1, role: 'user', content: 'hello' });
    assert.equal(runCairnCli(['checkout', '1', '--store', root, '--preview'], io), 0);
    assert.equal(runCairnCli(['checkout', '1', '--store', root], io), 1);
    assert.equal(runCairnCli(['checkout', '1', '--store', root, '--session', 's1', '--json'], io), 0);
    const binding = JSON.parse(output.at(-1)).binding;
    assert.equal(binding.session_id, 's1');
    assert.ok(fs.existsSync(path.join(root, 'sessions')));
    assert.equal(fs.existsSync(path.join(root, '.cairn')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hub CLI compact dispatch is async and accepts incremental/full modes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-cli-compact-'));
  const output = [];
  try {
    runCairnCli(['init', '--store', root], { stdout: value => output.push(value), stderr: value => output.push(value) });
    upsertHubTask(root, { id: 1, project_id: null, title: 'General task' });
    appendHubTaskTurn(root, { task_id: 1, project_id: null, turn: 1, role: 'user', content: 'some work' });
    const llmClient = { complete: async () => ({ ok: true, content: 'Compact note.' }) };
    assert.equal(await runCairnCliAsync(['compact', '1', '--store', root], { stdout: value => output.push(value), stderr: value => output.push(value), llmClient }), 0);
    assert.equal(await runCairnCliAsync(['compact', '1', '--full', '--store', root], { stdout: value => output.push(value), stderr: value => output.push(value), llmClient }), 0);
    assert.equal(fs.readFileSync(path.join(root, 'tasks', '1', 'compact.md'), 'utf8'), 'Compact note.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI defaults to DSH_HOME Hub storage when no --cwd override is supplied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-cli-default-'));
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    assert.equal(runCairnCli(['init'], { cwd: process.cwd(), stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(fs.existsSync(path.join(root, 'cairn', 'hub.json')), true);
    assert.equal(fs.existsSync(path.join(process.cwd(), '.cairn')), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hub CLI lifecycle transitions preserve the active/done/archived/reopened state machine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-cli-life-'));
  const out = [];
  try {
    runCairnCli(['init', '--store', root], { stdout: () => {}, stderr: () => {} });
    upsertHubTask(root, { id: 1, project_id: null, title: 'Lifecycle task' });
    assert.equal(runCairnCli(['close', '1', '--store', root, '--json'], { stdout: value => out.push(value), stderr: value => out.push(value) }), 0);
    assert.equal(JSON.parse(out.at(-1)).task.status, 'done');
    assert.equal(runCairnCli(['archive', '1', '--store', root], { stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(runCairnCli(['reopen', '1', '--store', root], { stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'tasks', 'index.json'), 'utf8')).tasks[0].status, 'active');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
