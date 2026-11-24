import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { appendHubTaskTurn, checkpointToolResult, commitScopedStaged, readSessionBinding, readScopedStaged, readTurnReceipts,
  recordTurnReceipt, resolveHubPaths, stageScopedOperators, upsertHubTask, writeHubTaskCompaction, writeSessionBinding } from '../src/kernel/hub-store.mjs';
import { captureFileWrite } from '../src/kernel/file-writes.mjs';
import { withHubWriteLock } from '../src/kernel/hub-write-lock.mjs';

const bin = fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url));
function cli(args, status = 0, json = true) {
  const result = spawnSync(process.execPath, [bin, ...args, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr + result.stdout);
  return json && result.stdout.trim() ? JSON.parse(result.stdout) : result.stdout + result.stderr;
}
function fixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const tmp = fs.mkdtempSync(path.join(parent, 'cairn-recovery-'));
  t.after(() => { if (path.dirname(tmp) === parent && path.basename(tmp).startsWith('cairn-recovery-')) fs.rmSync(tmp, { recursive: true, force: true }); });
  const hub = path.join(tmp, 'source'), bundle = path.join(tmp, 'backup'), restored = path.join(tmp, 'restored');
  upsertHubTask(hub, { id: 1, title: 'Filed task' });
  appendHubTaskTurn(hub, { task_id: 1, role: 'user', content: 'One record' });
  return { tmp, hub, bundle, restored, paths: resolveHubPaths(hub) };
}

test('doctor agrees with checkout about index drift, above and below history, and never repairs it', t => {
  const { hub, paths } = fixture(t);
  assert.equal(cli(['doctor', '--store', hub]).ok, true);
  const index = JSON.parse(fs.readFileSync(paths.tasksIndexFile, 'utf8'));
  for (const indexed of [2, 0]) {
    index.tasks[0].turn_count = indexed;
    const original = JSON.stringify(index);
    fs.writeFileSync(paths.tasksIndexFile, original);
    const report = cli(['doctor', '--store', hub], 1);
    assert.deepEqual(report.issues.find(i => i.code === 'task_record_count_mismatch'),
      { code: 'task_record_count_mismatch', task_id: 1, indexed_count: indexed, record_count: 1 });
    assert.equal(cli(['checkout', '1', '--preview', '--store', hub]).work_state.history_index_matches, false);
    assert.match(cli(['doctor', '--store', hub], 1, false), /task_record_count_mismatch/u);
    assert.equal(fs.readFileSync(paths.tasksIndexFile, 'utf8'), original);
  }
});

test('doctor distinguishes an empty task from lost history and isolates unreadable evidence and malformed threads', t => {
  const { hub, paths } = fixture(t);
  upsertHubTask(hub, { id: 2, title: 'Empty' });
  assert.equal(cli(['doctor', '--store', hub]).ok, true);
  fs.rmSync(paths.taskThreadFile(1));
  assert.ok(cli(['doctor', '--store', hub], 1).issues.some(i => i.code === 'task_thread_missing' && i.task_id === 1));
  fs.writeFileSync(paths.taskThreadFile(1), '{"partial":');
  const dir = path.join(paths.taskDir(2), 'file-writes');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a'.repeat(64) + '.json'), 'invalid private text');
  const report = cli(['doctor', '--store', hub], 1);
  assert.ok(report.issues.some(i => i.code === 'task_thread_unreadable' && i.task_id === 1));
  assert.ok(report.issues.some(i => i.code === 'task_file_writes_unreadable' && i.task_id === 2));
  assert.doesNotMatch(JSON.stringify(report), /private text|partial/u);
});

test('cold recovery drill: restore the stopped Hub into a new store and independently checkout the same work state', t => {
  const { tmp, hub, bundle, restored } = fixture(t);
  const project = path.join(tmp, 'business');
  fs.mkdirSync(project);
  const scope = { scope: 'project', projectId: 'p' };
  upsertHubTask(hub, { id: 2, project_id: 'p', project: { canonical_root: project }, title: 'Delivery' });
  for (const [opts, op] of [
    [{}, { op: 'ASSERT', key: 'language', option_code: 'zh', summary: 'Chinese replies' }],
    [scope, { op: 'ASSERT', key: 'runner', option_code: 'npm', summary: 'Use npm' }],
    [scope, { op: 'SUPERSEDE', target_id: 'D1', option_code: 'pnpm', summary: 'Use pnpm', reason: 'npm failed to install' }]
  ]) {
    const { proposal } = stageScopedOperators(hub, { ...opts, ops: [op] });
    assert.equal(commitScopedStaged(hub, { ...opts, proposal_id: proposal.proposal_id }).committed, true);
  }
  stageScopedOperators(hub, { ...scope, ops: [{ op: 'OPEN_QUESTION', key: 'deployment', summary: 'Which environment?' }] });
  appendHubTaskTurn(hub, { task_id: 2, project_id: 'p', role: 'user', content: 'Prepare release' });
  writeHubTaskCompaction(hub, 2, 'Release preparation', 1);
  appendHubTaskTurn(hub, { task_id: 2, project_id: 'p', role: 'assistant', content: 'Release note drafted' });
  const binding = writeSessionBinding(hub, 's', { task_id: 2, project_id: 'p' });
  const turn = { taskId: 2, projectId: 'p', bindingEpoch: binding.binding_epoch,
    source: { host: 'dsh', session_id: 's', turn: 3, step: 1, journal_seq: 70 } };
  recordTurnReceipt(hub, 's', 3, { status: 'in_progress' });
  assert.ok(checkpointToolResult(hub, { ...turn, request: 'Check release', tool: { name: 'test', ok: false, output: 'FAIL csv-header' } }));
  const target = path.join(project, 'release.txt'), content = 'draft';
  assert.ok(captureFileWrite(hub, { ...turn, source: { ...turn.source, journal_seq: 71, call_id: 'write-note' },
    target, sha256: createHash('sha256').update(content).digest('hex') }));
  fs.writeFileSync(target, 'A later edit must survive');
  const checkout = root => cli(['checkout', '2', '--preview', '--store', root]);
  const before = checkout(hub), staged = readScopedStaged(hub, scope), receipt = readTurnReceipts(hub, 's', 3);
  assert.equal(before.work_state.pending_count, 1);
  assert.equal(before.work_state.file_writes[0].last_check, null);
  assert.equal(before.work_state.authority.project.tombstones.length, 1);
  assert.equal(staged.proposals.length, 1);
  assert.equal(cli(['backup', bundle, '--store', hub]).ok, true);
  // Take the source offline; recovery has only the bundle, not a live source or session.
  fs.renameSync(hub, path.join(tmp, 'source-offline'));
  assert.equal(cli(['restore', bundle, '--store', restored]).ok, true);
  assert.equal(cli(['doctor', '--store', restored]).ok, true);
  assert.deepEqual(checkout(restored), before);
  assert.deepEqual(readSessionBinding(restored, 's'), readSessionBinding(path.join(tmp, 'source-offline'), 's'));
  assert.deepEqual(readScopedStaged(restored, scope), staged);
  assert.deepEqual(readTurnReceipts(restored, 's', 3), receipt);
  assert.equal(fs.readFileSync(target, 'utf8'), 'A later edit must survive');
  assert.equal(fs.existsSync(hub), false);
  assert.equal(fs.existsSync(path.join(restored, '.write.lock')), false);
});

test('cold recovery refuses overwritten destinations, overlaps, links and altered or omitted payloads', t => {
  const { tmp, hub, bundle, restored, paths } = fixture(t);
  assert.match(cli(['backup', path.join(hub, 'nested'), '--store', hub], 1, false), /overlap/u);
  fs.symlinkSync(tmp, path.join(hub, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(cli(['backup', path.join(tmp, 'unsafe'), '--store', hub], 1, false), /link|unsupported_entry/u);
  fs.unlinkSync(path.join(hub, 'external'));
  cli(['backup', bundle, '--store', hub]);
  assert.match(cli(['backup', bundle, '--store', hub], 1, false), /exists/u);
  assert.match(cli(['restore', bundle, '--store', hub], 1, false), /exists/u);
  assert.match(cli(['restore', bundle, '--store', path.join(bundle, 'nested')], 1, false), /overlap/u);
  const backedThread = path.join(bundle, 'data', path.relative(hub, paths.taskThreadFile(1)));
  fs.appendFileSync(backedThread, '\n');
  assert.match(cli(['restore', bundle, '--store', restored], 1, false), /integrity/u);
  fs.unlinkSync(backedThread);
  assert.match(cli(['restore', bundle, '--store', path.join(tmp, 'second')], 1, false), /integrity/u);
  assert.equal(fs.existsSync(path.join(restored, 'hub.json')), false);
  assert.equal(cli(['doctor', '--store', hub]).ok, true);
});

test('an interrupted publication with a receipt but no task observation is not reported healthy', t => {
  const { hub, bundle } = fixture(t);
  recordTurnReceipt(hub, 'a-session', 3, { status: 'in_progress', observation_task_id: 1 });
  const issue = cli(['doctor', '--store', hub], 1).issues.find(i => i.code === 'receipt_observation_missing');
  assert.equal(issue.task_id, 1);
  assert.equal(issue.turn, 3);
  assert.match(cli(['backup', bundle, '--store', hub], 1, false), /receipt_observation_missing/u);
  assert.equal(fs.existsSync(path.join(bundle, 'manifest.json')), false);
});

test('parseable thread without a final newline and malformed indexes cannot produce green JSON reports', t => {
  const { hub, paths } = fixture(t);
  const thread = paths.taskThreadFile(1);
  fs.writeFileSync(thread, fs.readFileSync(thread, 'utf8').trimEnd());
  assert.ok(cli(['doctor', '--store', hub], 1).issues.some(i => i.code === 'task_thread_unreadable'));
  fs.writeFileSync(paths.tasksIndexFile, '{}');
  fs.writeFileSync(paths.projectsIndexFile, 'private invalid data');
  const report = cli(['doctor', '--store', hub], 1);
  assert.ok(report.issues.some(i => i.code === 'tasks_index_unreadable'));
  assert.ok(report.issues.some(i => i.code === 'projects_index_unreadable'));
  assert.doesNotMatch(JSON.stringify(report), /private invalid/u);
});

test('backup respects an active write lock and never publishes a snapshot from that writer', t => {
  const { hub, bundle } = fixture(t);
  withHubWriteLock(hub, () => assert.match(cli(['backup', bundle, '--store', hub], 1, false), /hub_write_lock_busy/u));
  assert.equal(fs.existsSync(bundle), false);
  assert.equal(cli(['backup', bundle, '--store', hub]).ok, true);
});
