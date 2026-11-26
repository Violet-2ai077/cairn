import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { archiveHubTurn, checkpointToolResult, dropScopedStaged, listArchiveJobs, readHubTasksIndex, readHubTaskThread,
  readScopedStaged, readSessionBinding, readTaskObservations, readTurnReceipts, recordTurnReceipt, resolveHubPaths,
  stageScopedOperators, upsertHubTask, writeSessionBinding } from '../src/kernel/hub-store.mjs';
import { createHubDshHost } from '../src/hosts/dsh/hub-host.mjs';
import { readConsistentHub } from '../src/kernel/hub-write-lock.mjs';
import { collectToolEvidence } from '../src/hosts/dsh/turn-journal.mjs';
import { redactToolOutput } from '../src/kernel/tool-evidence.mjs';
import { readToolTimeline } from '../src/kernel/tool-timeline.mjs';

const job = { sessionId: 'original', taskId: 1, projectId: null, turn: 7, user: 'Request', assistant: 'Completed.',
  authoredUser: 'Request', tools: [{ name: 'external_write', ok: true }], sourceStep: 'turn_source',
  expectedEpoch: null, bindingEpoch: 'bound', bindingSource: 'task_marker', midSession: true,
  receiptFields: { first_seq: 70, end_seq: 79 } };
const ops = [{ op: 'ASSERT', key: 'language', option_code: 'en', summary: 'English' }];

test('new dsh tool evidence masks labeled credentials before truncation without altering native events or ordinary diagnostics', () => {
  const benign = 'Screenshot: report-2026.png (1920x1080), sha256=' + '05'.repeat(32) + ', exit_code=17; key=42, tokens_used=100';
  assert.equal(redactToolOutput(benign), benign);
  const raw = ['Authorization: Bearer bearer_value', '{"Authorization":"Basic abcdef=="}',
    'OPENAI_API_KEY="key with spaces"', "clientSecret='swordfish'", 'ACCESS_TOKEN=attr-value&phase=green',
    '-----BEGIN RSA PRIVATE KEY-----', 'ERROR should_not_survive_distillation', '-----END RSA PRIVATE KEY-----', benign].join('\n');
  const masked = redactToolOutput(raw);
  assert.doesNotMatch(masked, /bearer_value|abcdef|key with spaces|swordfish|attr-value|should_not_survive/);
  assert.ok(masked.includes(benign) && masked.includes('&phase=green'));
  assert.equal(redactToolOutput(masked), masked);
  assert.equal(redactToolOutput('-----BEGIN OPENSSH PRIVATE KEY-----\npartial without terminator'), '<redacted>');
  const entry = { toolNames: new Map(), tools: [] };
  collectToolEvidence(entry, { type: 'tool/call', data: { callId: 'real-call-17', name: 'screenshot' } });
  const event = { type: 'tool/result', seq: 8, data: { message: { toolCallId: 'real-call-17', isError: true,
    content: [{ type: 'text', text: raw }, { type: 'image', data: 'untouched-image-bytes' }] } } };
  const original = structuredClone(event);
  const row = collectToolEvidence(entry, event);
  assert.equal(row.call_id, 'real-call-17');
  assert.equal(row.name, 'screenshot');
  assert.equal(row.ok, false);
  assert.doesNotMatch(JSON.stringify(row), /should_not_survive|untouched-image-bytes|swordfish|bearer_value/);
  assert.deepEqual(event, original);
  const noId = collectToolEvidence(entry, { type: 'tool/result', seq: 9, data: { message: { content: benign } } });
  assert.equal(Object.hasOwn(noId, 'call_id'), false);
  collectToolEvidence(entry, { type: 'tool/call', seq: 10, data: { callId: 'causal-call', name: 'read' } });
  const linked = collectToolEvidence(entry, { type: 'tool/result', seq: 11, sourceEventSeqs: [10], data: { message: { content: benign } } });
  assert.equal(linked.call_id, 'causal-call');
  assert.equal(linked.name, 'read');
});

test('checkpoint, archive job and thread mask new tool snippets while retaining real call IDs and status', t => {
  const root = fixture(t), epoch = 'bound';
  writeSessionBinding(root, job.sessionId, { task_id: 1, bindingEpoch: epoch });
  recordTurnReceipt(root, job.sessionId, job.turn, { status: 'in_progress' });
  const tool = { name: 'fetch', ok: false, output: 'ERROR password=unmasked-private-value', call_id: 'native-call', seq: 73 };
  checkpointToolResult(root, { taskId: 1, projectId: null, bindingEpoch: epoch, request: 'request', tool,
    source: { host: 'dsh', session_id: job.sessionId, turn: job.turn, step: 2, journal_seq: 73 } });
  const [observation] = readTaskObservations(root, 1);
  assert.equal(observation.last_tool.call_id, 'native-call');
  assert.equal(observation.tools[0].ok, false);
  assert.doesNotMatch(JSON.stringify(observation), /unmasked-private-value/);
  archiveHubTurn(root, { ...job, expectedEpoch: epoch, tools: [tool] });
  for (const row of [listArchiveJobs(root)[0].tools[0], readHubTaskThread(root, 1).at(-1).meta.tools[0]]) {
    assert.deepEqual(row, { ...tool, output: 'ERROR password=<redacted>' });
  }
});

function fixture(t) {
  const base = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'cairn-outbox-'));
  t.after(() => { if (path.dirname(root) === base && path.basename(root).startsWith('cairn-outbox-')) fs.rmSync(root, { recursive: true, force: true }); });
  upsertHubTask(root, { id: 1, title: 'Existing task' });
  return root;
}

async function restart(root) {
  let calls = 0;
  const host = await createHubDshHost({}, { storeRoot: root, llmClient: { complete: async () => {
    calls++; return { ok: true, content: JSON.stringify({ ops }) };
  } } });
  await host.dispose();
  return calls;
}

test('process exit after a durable native call and before its result remains unknown after cold restart', async t => {
  const root = fixture(t);
  writeSessionBinding(root, job.sessionId, { task_id: 1, bindingEpoch: 'bound' });
  recordTurnReceipt(root, job.sessionId, job.turn, { status: 'in_progress' });
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { recordToolFact } from ${JSON.stringify(new URL('../src/kernel/tool-timeline.mjs', import.meta.url).href)};
    const rename = fs.renameSync;
    fs.renameSync = (a, b) => { rename(a, b); if (path.basename(path.dirname(b)) === 'tool-timeline') process.exit(74); };
    recordToolFact(process.argv[1], { sessionId: 'original', turn: 7, step: 1, journalSeq: 75, kind: 'call',
      taskId: 1, projectId: null, bindingEpoch: 'bound', callId: 'native', name: 'external_write' });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 74, child.stderr);
  assert.equal(await restart(root), 0);
  const [call] = readToolTimeline(root, 1).turns[0].calls;
  assert.deepEqual(call, { journal_seq: 75, step: 1, name: 'external_write', call_id: 'native', result_status: 'unknown', results: [] });
  assert.equal(readHubTaskThread(root, 1).length, 0);
});

// Exit after the real filesystem operation, inside the lock holder. process.exit
// skips JS finally blocks; the parent must recover without test-only unlocks.
const crashWriter = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { archiveHubTurn, resolveHubPaths } from ${JSON.stringify(new URL('../src/kernel/hub-store.mjs', import.meta.url).href)};
  import { createHubDshHost } from ${JSON.stringify(new URL('../src/hosts/dsh/hub-host.mjs', import.meta.url).href)};
  const [root, phase] = process.argv.slice(1);
  const job = ${JSON.stringify(job)}, paths = resolveHubPaths(root);
  const binding = paths.sessionBindingFile(job.sessionId);
  const receipt = path.join(paths.sessionsDir, 'turns', path.basename(binding, '.json'), job.turn + '.json');
  const rename = fs.renameSync, rm = fs.rmSync, halt = () => process.exit(73);
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (phase === 'intent' && path.basename(path.dirname(to)) === 'archive-jobs') halt();
    if (to === ({ thread: paths.taskThreadFile(1), index: paths.tasksIndexFile, binding, proposal: paths.userStagedFile })[phase]) halt();
    if (to === receipt && JSON.parse(fs.readFileSync(to)).extraction.user === ({ archived: 'pending', settled: 'staged' })[phase]) halt();
  };
  fs.rmSync = (file, options) => {
    rm(file, options);
    if (phase === 'outbox_removed' && path.basename(path.dirname(file)) === 'archive-jobs') halt();
  };
  archiveHubTurn(root, job);
  const host = await createHubDshHost({}, { storeRoot: root, llmClient: { complete: async () => {
    if (phase === 'during_worker') halt();
    return { ok: true, content: JSON.stringify({ ops: ${JSON.stringify(ops)} }) };
  } } });
  await host.dispose();
  throw new Error('requested crash point was not reached: ' + phase);
`;

for (const phase of ['intent', 'thread', 'index', 'binding', 'archived', 'during_worker', 'proposal', 'settled', 'outbox_removed']) {
  test('dead writer: cold host repairs ' + phase + ' without replaying external tools', async t => {
    const root = fixture(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashWriter, root, phase], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 73, child.error?.message ?? child.stderr);
    const guard = path.join(root, '.write.lock.guard');
    const fence = path.join(root, '.write.lock');
    if (phase !== 'during_worker') {
      assert.ok(fs.existsSync(guard) && fs.existsSync(fence), 'crash must leave real writer locks');
      const started = performance.now();
      assert.throws(() => readConsistentHub(root, () => readHubTaskThread(root, 1)), /hub_snapshot_busy/);
      assert.ok(performance.now() - started < 5000, 'preview must not hang on a dead writer');
      assert.ok(fs.existsSync(guard), 'read-only preview must not reap locks');
    }
    assert.equal(await restart(root), ['proposal', 'settled', 'outbox_removed'].includes(phase) ? 0 : 1);
    assert.ok(!fs.existsSync(guard) && !fs.existsSync(fence));
    assert.deepEqual(readConsistentHub(root, () => readHubTaskThread(root, 1).map(row => row.role)), ['user', 'assistant']);
    assert.equal(readTurnReceipts(root, job.sessionId, job.turn).extraction.user, 'staged');
    assert.equal(readHubTasksIndex(root).tasks[0].turn_count, 2);
    assert.equal(readScopedStaged(root).proposals.length, 1);
    assert.equal(listArchiveJobs(root).length, 0);
    assert.equal(await restart(root), 0);
  });
}

for (const boundary of ['thread', 'index', 'binding', 'receipt', 'before_worker']) {
  test('restart drains confirmed archive after interruption at ' + boundary, async t => {
    const root = fixture(t), paths = resolveHubPaths(root);
    const binding = paths.sessionBindingFile(job.sessionId);
    const file = { thread: paths.taskThreadFile(1), index: paths.tasksIndexFile, binding,
      receipt: path.join(paths.sessionsDir, 'turns', path.basename(binding, '.json'), '7.json') }[boundary];
    if (file) {
      const rename = fs.renameSync;
      const fault = t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === file) throw new Error('injected_writer_exit');
        return rename(from, to);
      });
      assert.throws(() => archiveHubTurn(root, job), /injected_writer_exit/);
      fault.mock.restore();
    } else archiveHubTurn(root, job);
    assert.equal(listArchiveJobs(root).length, 1);
    assert.ok([0, 2].includes(readHubTaskThread(root, 1).length));
    assert.equal(await restart(root), 1);
    assert.deepEqual(readHubTaskThread(root, 1).map(r => r.role), ['user', 'assistant']);
    assert.equal(readHubTasksIndex(root).tasks[0].turn_count, 2);
    assert.equal(readSessionBinding(root, job.sessionId).binding_epoch, 'bound');
    const receipt = readTurnReceipts(root, job.sessionId, 7);
    assert.equal(receipt.end_seq, 79);
    assert.equal(receipt.extraction.user, 'staged');
    assert.equal(listArchiveJobs(root).length, 0);
    assert.equal(archiveHubTurn(root, job).job, null);
    assert.equal(await restart(root), 0);
    assert.equal(readScopedStaged(root).proposals.length, 1);
  });
}

for (const dropped of [false, true]) {
  test('retry does not stage a durable proposal twice; dropped=' + dropped, async t => {
    const root = fixture(t);
    archiveHubTurn(root, job);
    const extraction = { sessionId: job.sessionId, turn: job.turn };
    const result = stageScopedOperators(root, { ops, extraction });
    assert.equal(stageScopedOperators(root, { ops, extraction }).proposal.proposal_id, result.proposal.proposal_id);
    if (dropped) dropScopedStaged(root);
    assert.equal(await restart(root), 0);
    assert.equal(readTurnReceipts(root, job.sessionId, job.turn).extraction.user, 'staged');
    assert.equal(readScopedStaged(root).proposals.length, dropped ? 0 : 1);
    assert.equal(listArchiveJobs(root).length, 0);
  });
}

test('first archive persists a new-task ticket before publishing its index and respects a later explicit checkout', async t => {
  const root = fixture(t), paths = resolveHubPaths(root);
  const input = { ...job, taskId: 2, createTask: { id: 2, project_id: null, title: 'New task', creation_turn_key: 'ticket' } };
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === paths.tasksIndexFile) throw new Error('injected_before_creation');
    return rename(from, to);
  });
  assert.throws(() => archiveHubTurn(root, input), /injected_before_creation/);
  fault.mock.restore();
  writeSessionBinding(root, job.sessionId, { task_id: 1, bindingEpoch: 'newer-checkout' });
  assert.equal(await restart(root), 1);
  assert.deepEqual(readHubTaskThread(root, 2).map(r => r.role), ['user', 'assistant']);
  assert.equal(readSessionBinding(root, job.sessionId).binding_epoch, 'newer-checkout');
  assert.equal(readTurnReceipts(root, job.sessionId, job.turn).task_id, 2);
});

test('legacy single-tool checkpoint upgrades to an ordered bounded sequence; receipts contain no output', t => {
  const root = fixture(t);
  writeSessionBinding(root, job.sessionId, { task_id: 1, bindingEpoch: 'bound' });
  recordTurnReceipt(root, job.sessionId, 7, { status: 'in_progress' });
  const checkpoint = n => checkpointToolResult(root, { taskId: 1, projectId: null, bindingEpoch: 'bound',
    source: { host: 'dsh', session_id: job.sessionId, turn: 7, step: n, journal_seq: n },
    request: 'Request', tool: { name: 'tool' + n, ok: n % 2 === 0, output: 'private output ' + n } });
  assert.ok(checkpoint(1));
  const dir = path.join(resolveHubPaths(root).taskDir(1), 'observations');
  const file = path.join(dir, fs.readdirSync(dir)[0]), legacy = JSON.parse(fs.readFileSync(file));
  delete legacy.tools;
  delete legacy.omitted_tools;
  fs.writeFileSync(file, JSON.stringify(legacy));
  for (const n of [2, 3]) assert.ok(checkpoint(n));
  assert.equal(checkpoint(3), false);
  assert.deepEqual(readTaskObservations(root, 1)[0].tools.map(r => r.journal_seq), [1, 2, 3]);
  for (let n = 4; n <= 35; n++) assert.ok(checkpoint(n));
  recordTurnReceipt(root, job.sessionId, 7, { status: 'interrupted' });
  const [observation] = readTaskObservations(root, 1);
  assert.equal(observation.tools.length, 32);
  assert.equal(observation.tools[0].name, 'tool1');
  assert.equal(observation.tools.at(-1).name, 'tool35');
  assert.equal(observation.omitted_tools, 3);
  assert.deepEqual(observation.omitted_journal_seq, { first: 2, last: 4 });
  assert.equal(observation.disposition, 'verify_before_retry');
  assert.doesNotMatch(JSON.stringify(readTurnReceipts(root, job.sessionId)), /private output/);
});
