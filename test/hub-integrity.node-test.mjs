import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  commitScopedStaged, ensureScopedLedger, initHubStore, readHubTasksIndex, readProjectsIndex,
  readScopedHead, readScopedLedgerLog, readScopedStaged, resolveHubPaths, stageScopedOperators, upsertHubTask
} from '../src/kernel/hub-store.mjs';

const project = { scope: 'project', projectId: 'alpha' };
const op = { op: 'ASSERT', key: 'build', option_code: 'node', summary: 'Use Node' };
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-read-integrity-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, 'hub');
}

test('verified readers expose replay, not a stale materialization; no reads repair or create files', t => {
  const hub = fixture(t);
  assert.equal(readScopedHead(hub).revision, 0);
  assert.deepEqual(readHubTasksIndex(hub).tasks, []);
  assert.equal(fs.existsSync(hub), false);
  initHubStore(hub);
  assert.equal(readScopedHead(hub, project).revision, 0);
  const paths = resolveHubPaths(hub).ledgerPaths(project);
  assert.equal(fs.existsSync(paths.ledgerDir), false);
  stageScopedOperators(hub, { ...project, ops: [op] });
  const old = [paths.headFile, paths.stagedFile].map(f => fs.readFileSync(f));
  commitScopedStaged(hub, project);
  fs.writeFileSync(paths.headFile, old[0]);
  fs.writeFileSync(paths.stagedFile, old[1]);
  assert.equal(readScopedHead(hub, project).active[0].summary, op.summary);
  assert.deepEqual(readScopedStaged(hub, project).proposals, []);
  assert.deepEqual([paths.headFile, paths.stagedFile].map(f => fs.readFileSync(f)), old);
  fs.appendFileSync(paths.ledgerFile, '{}');
  for (const read of [readScopedHead, readScopedLedgerLog, readScopedStaged]) {
    assert.throws(() => read(hub, project), /ledger_integrity/);
  }
});

test('missing committed layout cannot masquerade as a new hub or a new project', t => {
  const hub = fixture(t);
  ensureScopedLedger(hub, project);
  const paths = resolveHubPaths(hub), p = paths.ledgerPaths(project);
  fs.rmSync(p.ledgerDir, { recursive: true });
  assert.throws(() => readScopedHead(hub, project), /integrity/);
  assert.throws(() => ensureScopedLedger(hub, project), /integrity/);
  assert.equal(fs.existsSync(p.ledgerDir), false);
  fs.unlinkSync(paths.tasksIndexFile);
  assert.throws(() => readHubTasksIndex(hub), /integrity/);
  assert.throws(() => initHubStore(hub), /integrity/);
  assert.equal(fs.existsSync(paths.tasksIndexFile), false);
});

test('strict index reads reject ambiguous identities, invalid counters, and invented status', t => {
  const hub = fixture(t);
  upsertHubTask(hub, { project_id: project.projectId });
  const paths = resolveHubPaths(hub);
  for (const [file, read, mutations] of [
    [paths.tasksIndexFile, readHubTasksIndex, [
      r => r.tasks.push(r.tasks[0]), r => r.next_task_id = 1, r => r.tasks[0].status = 'maybe',
      r => r.tasks[0].compacted_record_count = 1, r => r.tasks[0].turn_count = -1,
      r => r.tasks = null, r => r.schema_version = 2, r => r.tasks[0].project_id = 'unknown'
    ]],
    [paths.projectsIndexFile, readProjectsIndex, [
      r => r.projects.push(r.projects[0]), r => r.next_project_seq = -1, r => r.projects[0].project_id = 'general',
      r => r.projects = {}, r => r.schema_version = 2
    ]]
  ]) {
    const pristine = fs.readFileSync(file);
    for (const mutate of mutations) {
      const raw = JSON.parse(pristine); mutate(raw);
      const corrupt = JSON.stringify(raw); fs.writeFileSync(file, corrupt);
      assert.throws(() => read(hub));
      assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
    }
    fs.writeFileSync(file, pristine);
  }
});

test('exhausted task IDs cannot wrap, reuse a hole, or create a project as a side effect', t => {
  const hub = fixture(t);
  upsertHubTask(hub, { id: 999 });
  assert.equal(readHubTasksIndex(hub).next_task_id, 1000);
  assert.throws(() => upsertHubTask(hub, { project_id: 'new' }), /task_ids_exhausted/);
  assert.throws(() => upsertHubTask(hub, { id: 1 }), /task_id/);
  assert.deepEqual(readProjectsIndex(hub).projects, []);
  assert.equal(upsertHubTask(hub, { id: 999, title: 'Updated' }).task.title, 'Updated');
});
