import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureFileWrite, verifyFileWrite } from '../src/kernel/file-writes.mjs';
import * as hub from '../src/kernel/hub-store.mjs';
import { readConsistentHub, withHubWriteLock } from '../src/kernel/hub-write-lock.mjs';
import { resolveTaskHeatPolicy } from '../src/kernel/task-heat.mjs';
import { createHubTurnRuntime } from '../src/hosts/dsh/hub-turn-runtime.mjs';
import { compileHubHandoff } from '../src/workers/hub-handoff.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  hub.upsertHubTask(root, { id: 1, project_id: 'p', title: 'Task' });
  hub.writeSessionBinding(root, 's', { task_id: 1, project_id: 'p' });
  return root;
}
const project = { scope: 'project', projectId: 'p' };
function commit(root, scope) {
  const r = hub.stageScopedOperators(root, { ...scope, ops: [{ op: 'ASSERT', key: 'format', option_code: 'csv', summary: scope.scope + ' chooses CSV' }] });
  assert.equal(hub.commitScopedStaged(root, { ...scope, proposal_id: r.proposal.proposal_id }).committed, true);
}
const runtime = hubRoot => createHubTurnRuntime({ hubRoot, policy: {}, taskHeat: resolveTaskHeatPolicy({ enabled: true }),
  stripReminders: s => s, onArchive() {} });
const step = (rt, turn) => rt.preStep('s', { turn, step: 1, messages: [{ content: 'Check progress.', source: { kind: 'user' } }] });
function finish(rt, turn) {
  rt.event('s', { type: 'assistant/message', surfaceOp: 'append', seq: 2, data: { turn, step: 1, content: 'Done\n<|task:1|>' } });
  rt.event('s', { type: 'turn/end', seq: 3, data: { turn, reason: { kind: 'completed' } } });
}
test('host retries a torn authority read instead of presenting a revision pair that never existed', async t => {
  const root = fixture(t), rt = runtime(root);
  const file = hub.resolveHubPaths(root).ledgerPaths(project).headFile;
  let fired = false;
  const read = fs.readFileSync;
  fs.readFileSync = function (name, ...args) {
    if (!fired && name === file) { fired = true; commit(root, { scope: 'user' }); commit(root, project); }
    return read.call(this, name, ...args);
  };
  try { await step(rt, 1); } finally { fs.readFileSync = read; }
  assert.equal(fired, true);
  const snapshot = rt.turns.get('s').scope.snapshot;
  assert.deepEqual([snapshot.userRevision, snapshot.projectRevision], [1, 1]);
  assert.match(rt.context('s'), /user chooses CSV/u);
  assert.match(rt.context('s'), /project chooses CSV/u);
});

test('republishing a summary at the same cursor invalidates only the next turn', async t => {
  const root = fixture(t), rt = runtime(root);
  hub.appendHubTaskTurn(root, { task_id: 1, project_id: 'p', role: 'assistant', content: 'Prior work' });
  hub.writeHubTaskCompaction(root, 1, 'SUMMARY_A', 1);
  await step(rt, 1);
  hub.writeHubTaskCompaction(root, 1, 'SUMMARY_B', 1);
  assert.match(rt.context('s'), /SUMMARY_A/u);
  finish(rt, 1);
  await step(rt, 2);
  assert.match(rt.context('s'), /SUMMARY_B/u);
  assert.doesNotMatch(rt.context('s'), /SUMMARY_A/u);
});

test('incomplete compaction and sustained contention cannot publish authority', t => {
  const root = fixture(t), file = hub.resolveHubPaths(root).taskCompactFile(1);
  hub.appendHubTaskTurn(root, { task_id: 1, project_id: 'p', content: 'start' });
  hub.writeHubTaskCompaction(root, 1, 'published digest', 1);
  fs.writeFileSync(file, 'unpublished replacement');
  const result = compileHubHandoff({ hubRoot: root, taskId: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.work_state.authority, undefined);
  assert.doesNotMatch(result.text, /unpublished replacement/u);
  let attempts = 0;
  assert.throws(() => readConsistentHub(root, () => { attempts++; withHubWriteLock(root, () => {}); }), /hub_snapshot_busy/u);
  assert.equal(attempts, 5);
});

test('checkout cannot pair earlier history with later observations and verified file bytes', t => {
  const root = fixture(t), scope = { scope: 'project', projectId: 'p' };
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-project-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  hub.registerProject(root, { project_id: 'p', canonical_root: repo });
  const target = path.join(repo, 'fact.txt'), bytes = 'fixture';
  fs.writeFileSync(target, bytes);
  const key = { taskId: 1, projectId: 'p', bindingEpoch: hub.readSessionBinding(root, 's').binding_epoch,
    source: { host: 'dsh', session_id: 's', turn: 1, step: 1, call_id: 'call', journal_seq: 1 } };
  hub.recordTurnReceipt(root, 's', 1, { status: 'in_progress' });
  const write = captureFileWrite(root, { ...key, target, sha256: createHash('sha256').update(bytes).digest('hex') });
  const file = hub.resolveHubPaths(root).ledgerPaths(scope).headFile, read = fs.readFileSync;
  let fired = false;
  fs.readFileSync = function (name, ...args) {
    if (!fired && name === file) {
      fired = true;
      hub.appendHubTaskTurn(root, { task_id: 1, project_id: 'p', content: 'peer result' });
      hub.writeHubTaskCompaction(root, 1, 'new compact', 1);
      hub.checkpointToolResult(root, { ...key, request: 'verify', tool: { name: 'check', ok: true, output: 'observed' } });
      assert.equal(verifyFileWrite(root, 1, write).status, 'matches');
    }
    return read.call(this, name, ...args);
  };
  let view;
  try { view = compileHubHandoff({ hubRoot: root, taskId: 1 }); } finally { fs.readFileSync = read; }
  assert.equal(fired, true);
  assert.match(view.text, /new compact/u);
  assert.equal(view.work_state.version.compacted_record_count, 1);
  assert.equal(view.work_state.pending_turns[0].last_tool.name, 'check');
  assert.equal(view.work_state.file_writes[0].last_check.status, 'matches');
});

test('first overwrite of a legacy compact pins the old bytes before publishing new markdown', t => {
  const root = fixture(t), paths = hub.resolveHubPaths(root);
  hub.appendHubTaskTurn(root, { task_id: 1, project_id: 'p', content: 'first' });
  hub.writeHubTaskCompaction(root, 1, 'legacy A', 1);
  const index = JSON.parse(fs.readFileSync(paths.tasksIndexFile));
  delete index.tasks[0].compact_sha256;
  fs.writeFileSync(paths.tasksIndexFile, JSON.stringify(index));
  let indexWrites = 0;
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === paths.tasksIndexFile && ++indexWrites === 2) throw new Error('injected_index_failure');
    return rename(from, to);
  };
  try { assert.throws(() => hub.writeHubTaskCompaction(root, 1, 'unpublished B', 1), /injected_index_failure/u); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(paths.taskCompactFile(1), 'utf8'), 'unpublished B');
  assert.equal(compileHubHandoff({ hubRoot: root, taskId: 1 }).ok, false);
});

test('a binding switch during capture invalidates the plan rather than filing on the new binding', async t => {
  const root = fixture(t), rt = runtime(root);
  hub.upsertHubTask(root, { id: 2, project_id: 'p', title: 'Second task' });
  const file = hub.resolveHubPaths(root).ledgerPaths(project).headFile, read = fs.readFileSync;
  let fired = false;
  fs.readFileSync = function (name, ...args) {
    if (!fired && name === file) { fired = true; hub.writeSessionBinding(root, 's', { task_id: 2, project_id: 'p' }); }
    return read.call(this, name, ...args);
  };
  try { await step(rt, 1); } finally { fs.readFileSync = read; }
  assert.equal(fired, true);
  assert.equal(rt.turns.get('s').scope.route.result, 'clarify');
  assert.doesNotMatch(rt.context('s'), /Task Checkout 1/u);
});
