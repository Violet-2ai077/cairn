import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendHubTaskTurn,
  commitScopedStaged,
  dropScopedStaged,
  ensureScopedLedger,
  initHubStore,
  isHubInitialized,
  readHubTaskThread,
  readHubTasksIndex,
  readProjectsIndex,
  readScopedHead,
  replayScopedLedger,
  resolveHubPaths,
  stageScopedOperators,
  transitionHubTaskStatus,
  readSessionBinding,
  writeSessionBinding,
  clearSessionBinding,
  upsertHubTask
} from '../src/kernel/hub-store.mjs';
import { foldScopedLedger } from '../src/kernel/scoped-ledger.mjs';
import { buildScopedAuthorityContract } from '../src/kernel/contracts.mjs';
import * as hubStore from '../src/kernel/hub-store.mjs';
import { runHubDoctor } from '../src/workers/hub-doctor.mjs';
import { withHubWriteLock } from '../src/kernel/hub-write-lock.mjs';

const temporaryRoots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-test-'));
  temporaryRoots.push(root);
  return root;
}

const projectScope = { scope: 'project', projectId: 'p_alpha' };
const assertion = (key, option_code = 'a') => ({ op: 'ASSERT', key, option_code, summary: option_code });

const lockImport = 'import { withHubWriteLock as lock } from ' + JSON.stringify(new URL('../src/kernel/hub-write-lock.mjs', import.meta.url).href) + ';';
const lockChild = (hub, source) => spawnSync(process.execPath, ['--input-type=module', '-e', lockImport + source, hub],
  { encoding: 'utf8', timeout: 5000, windowsHide: true });

test('a new Hub writer can take over after an abrupt owner exit, including a legacy PID lock', () => {
  for (const legacy of [false, true]) {
    const hub = tempRoot();
    const result = lockChild(hub, legacy
      ? "import fs from 'node:fs'; fs.writeFileSync(process.argv[1] + '/.write.lock', String(process.pid), { flag: 'wx' }); process.exit(19)"
      : 'lock(process.argv[1], () => process.exit(19))');
    assert.equal(result.status, 19, result.stderr);
    assert.ok(fs.existsSync(path.join(hub, '.write.lock')));
    initHubStore(hub);
    assert.ok(isHubInitialized(hub));
    assert.equal(fs.existsSync(path.join(hub, '.write.lock')), false);
  }
});

test('a live owner is not evicted, even after a contender times out; nested writes remain valid', () => {
  const hub = tempRoot();
  const blocked = "try { lock(process.argv[1], () => console.log('entered')) } catch (error) { console.log(error.message) }";
  withHubWriteLock(hub, () => {
    const other = lockChild(hub, blocked);
    assert.equal(other.status, 0, other.stderr);
    assert.equal(other.stdout.trim(), 'hub_write_lock_busy');
    const legacy = lockChild(hub, "import fs from 'node:fs'; try { fs.closeSync(fs.openSync(process.argv[1]+'/.write.lock','wx')); console.log('entered') } catch(e) { console.log(e.code) }");
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stdout.trim(), /^(EEXIST|EISDIR|EACCES|EPERM)$/u);
    withHubWriteLock(hub, () => initHubStore(hub));
  });
  assert.ok(isHubInitialized(hub));
});

test('legacy live and ambiguous owners are not reclaimed based on age', async () => {
  const results = await Promise.allSettled([String(process.pid), '', 'not-a-pid'].map(async value => {
    const hub = tempRoot(), file = path.join(hub, '.write.lock');
    fs.writeFileSync(file, value);
    fs.utimesSync(file, new Date(0), new Date(0));
    const body = "try { lock(process.argv[1], () => console.log('entered')) } catch (error) { console.log(error.message) }";
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', lockImport + body, hub],
      { timeout: 5000, windowsHide: true });
    assert.equal(stdout.trim(), 'hub_write_lock_busy');
    assert.equal(fs.readFileSync(file, 'utf8'), value);
    assert.deepEqual(fs.readdirSync(hub), ['.write.lock']);
  }));
  for (const r of results) if (r.status === 'rejected') throw r.reason;
});

test('simultaneous contenders recover a dead writer without overlapping their critical sections', async () => {
  const hub = tempRoot();
  assert.equal(lockChild(hub, 'lock(process.argv[1], () => process.exit(19))').status, 19);
  const barrier = tempRoot(), go = path.join(barrier, 'go');
  const ready = Array.from({ length: 5 }, (_, i) => path.join(barrier, String(i)));
  const script = lockImport + [
    "import fs from 'node:fs'; const root = process.argv[1], probe = root + '/exclusive-probe';",
    'const wait = new Int32Array(new SharedArrayBuffer(4));',
    "fs.writeFileSync(process.argv[2], '');",
    'while (!fs.existsSync(process.argv[3])) Atomics.wait(wait, 0, 0, 5);',
    'for (let i = 0; i < 4; i++) lock(root, () => {',
    "  fs.closeSync(fs.openSync(probe, 'wx'));",
    '  Atomics.wait(wait, 0, 0, 8);',
    '  fs.unlinkSync(probe);',
    '});'
  ].join('\n');
  const children = Promise.allSettled(ready.map(file =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, hub, file, go], { timeout: 8000, windowsHide: true })));
  const deadline = Date.now() + 5000;
  while (!ready.every(file => fs.existsSync(file)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const synchronized = ready.every(file => fs.existsSync(file));
  fs.writeFileSync(go, '');
  const results = await children;
  for (const r of results) assert.equal(r.status, 'fulfilled', r.reason?.message);
  assert.ok(synchronized);
  assert.deepEqual(fs.readdirSync(hub), []);
});

test('task heat derives capacity, idle and frozen pools, with a deterministic ID tie-break', async () => {
  const { resolveTaskHeatPolicy, selectHubTaskPools } = await import('../src/kernel/task-heat.mjs');
  const nowMs = Date.parse('2026-02-01T00:00:00Z');
  const recent = '2026-01-31T00:00:00Z';
  const old = '2025-12-01T00:00:00Z';
  const tasks = [
    { id: 5, status: 'active', last_activity_at: recent },
    { id: 4, status: 'archived', last_activity_at: recent },
    { id: 3, status: 'active', last_activity_at: old },
    { id: 2, status: 'active', last_activity_at: recent },
    { id: 1, status: 'active', last_activity_at: recent }
  ];
  const run = autopilot => selectHubTaskPools(tasks, { policy: resolveTaskHeatPolicy(autopilot), nowMs });
  const active = { enabled: true, taskHeat: { hotMaxTasks: 2 } };
  assert.deepEqual(run(active).hot.map(task => task.id), [1, 2]);
  assert.deepEqual(run(active).dormant.map(task => task.id), [3, 5]);
  assert.deepEqual(run(active).excluded.map(task => task.id), [4]);
  assert.deepEqual(run({ ...active, enabled: false }).hot.map(task => task.id), [1, 2, 3, 5]);
  assert.deepEqual(run({ ...active, taskHeat: { enabled: false } }).hot.map(task => task.id), [1, 2, 3, 5]);
  assert.deepEqual(resolveTaskHeatPolicy({ enabled: true }), { enabled: true, hotMaxTasks: 24, idleDays: 14, dormantMaxCandidates: 5 });
});

test('Hub task activity survives compaction and is refreshed only by turn, reopen or verified wake', () => {
  const hub = tempRoot();
  const at = '2026-01-02T00:00:00.000Z';
  const resumed = '2026-01-05T00:00:00.000Z';
  upsertHubTask(hub, { id: 1, project_id: 'p_alpha', updated_at: at });
  const get = () => readHubTasksIndex(hub).tasks[0];
  assert.equal(get().last_activity_at, null);
  appendHubTaskTurn(hub, { task_id: 1, project_id: 'p_alpha', content: 'turn', timestamp: at });
  assert.equal(get().last_activity_at, at);
  const indexFile = resolveHubPaths(hub).tasksIndexFile;
  const old = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  delete old.tasks[0].last_activity_at;
  fs.writeFileSync(indexFile, JSON.stringify(old));
  assert.equal(get().last_activity_at, at);
  hubStore.writeHubTaskCompaction(hub, 1, 'compact', 1);
  assert.equal(get().last_activity_at, at);
  const legacyCompacted = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  delete legacyCompacted.tasks[0].last_activity_at;
  fs.writeFileSync(indexFile, JSON.stringify(legacyCompacted));
  assert.equal(get().last_activity_at, null, 'a compacted legacy updated_at is not evidence of a turn');
  legacyCompacted.tasks[0].last_activity_at = at;
  fs.writeFileSync(indexFile, JSON.stringify(legacyCompacted));
  transitionHubTaskStatus(hub, { taskId: 1, action: 'close' });
  assert.throws(() => hubStore.bindHubRoutedTask(hub, { sessionId: 's', taskId: 1, projectId: 'p_alpha', wake: true }), /task_not_active/u);
  assert.equal(readSessionBinding(hub, 's'), null);
  transitionHubTaskStatus(hub, { taskId: 1, action: 'archive' });
  assert.equal(get().last_activity_at, at);
  transitionHubTaskStatus(hub, { taskId: 1, action: 'reopen', updatedAt: resumed });
  assert.equal(get().last_activity_at, resumed);
  assert.throws(() => hubStore.bindHubRoutedTask(hub, { sessionId: 's', taskId: 1, projectId: 'p_wrong', wake: true }), /task_project_mismatch/u);
  hubStore.bindHubRoutedTask(hub, { sessionId: 's', taskId: 1, projectId: 'p_alpha', wake: true, at: '2026-02-01T00:00:00.000Z' });
  assert.equal(get().last_activity_at, '2026-02-01T00:00:00.000Z');
  assert.equal(readSessionBinding(hub, 's').task_id, 1);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(indexFile, 'utf8')).tasks[0], 'pool'), false);
});

function stage(hub, ops) {
  return stageScopedOperators(hub, { ...projectScope, ops }).proposal.proposal_id;
}

function commit(hub, ops) {
  return commitScopedStaged(hub, { ...projectScope, proposal_id: stage(hub, ops) });
}

test('strict replay identifies a materialization gap, cleans the consumed staged ID and refuses a corrupt tail', () => {
  const hub = tempRoot();
  const id = stage(hub, [assertion('build')]);
  const files = resolveHubPaths(hub).ledgerPaths(projectScope);
  const oldHead = fs.readFileSync(files.headFile);
  const oldStaged = fs.readFileSync(files.stagedFile);
  assert.equal(commitScopedStaged(hub, { ...projectScope, proposal_id: id }).committed, true);
  const log = fs.readFileSync(files.ledgerFile, 'utf8');
  fs.writeFileSync(files.headFile, oldHead);
  fs.writeFileSync(files.stagedFile, oldStaged);
  assert.equal(replayScopedLedger(hub, projectScope).mismatch_reason, 'materialization_pending');
  assert.ok(runHubDoctor({ hubRoot: hub }).issues.some(issue => issue.reason === 'materialization_pending'));
  assert.deepEqual(fs.readFileSync(files.headFile), oldHead);
  assert.equal(hubStore.syncScopedLedger(hub, projectScope).valid, true);
  assert.equal(fs.readFileSync(files.ledgerFile, 'utf8'), log);
  assert.equal(hubStore.readScopedStaged(hub, projectScope).proposals.length, 0);
  fs.writeFileSync(files.stagedFile, oldStaged);
  const stagedOnly = replayScopedLedger(hub, projectScope);
  assert.equal(stagedOnly.mismatch_reason, 'materialization_pending');
  assert.equal(stagedOnly.head_matches, true);
  assert.equal(commitScopedStaged(hub, { ...projectScope, proposal_id: id }).reason, 'proposal_not_found');
  assert.equal(replayScopedLedger(hub, projectScope).valid, true);
  fs.appendFileSync(files.ledgerFile, '{"commit_seq":');
  assert.equal(replayScopedLedger(hub, projectScope).valid, false);
  assert.equal(runHubDoctor({ hubRoot: hub }).ok, false);
  assert.throws(() => commitScopedStaged(hub, projectScope), /ledger_integrity/u);
  assert.equal(fs.readFileSync(files.ledgerFile, 'utf8'), log + '{"commit_seq":');
});

test('strict replay checks persisted sequence, scope, revisions and complete fold effects', () => {
  const hub = tempRoot();
  commit(hub, [assertion('build')]);
  const files = resolveHubPaths(hub).ledgerPaths(projectScope);
  const original = JSON.parse(fs.readFileSync(files.ledgerFile, 'utf8'));
  for (const [key, value] of Object.entries({ commit_seq: 9, project_id: 'p_beta', base_revision: 3, new_revision: 7, accepted_ops: [], rejected_ops: [{}] })) {
    fs.writeFileSync(files.ledgerFile, JSON.stringify({ ...original, [key]: value }) + '\n');
    assert.equal(replayScopedLedger(hub, projectScope).valid, false, key);
  }
});

test('a non-prefix head is not a recoverable lag', () => {
  const hub = tempRoot();
  commit(hub, [assertion('build')]);
  const { headFile } = resolveHubPaths(hub).ledgerPaths(projectScope);
  const head = { ...readScopedHead(hub, projectScope), revision: 0 };
  fs.writeFileSync(headFile, JSON.stringify(head));
  assert.equal(replayScopedLedger(hub, projectScope).mismatch_reason, 'head_mismatch');
  assert.throws(() => hubStore.syncScopedLedger(hub, projectScope), /ledger_integrity:head_mismatch/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(headFile, 'utf8')), head);
});

test('revert compensates a multi-op same-key change and rejects a question batch', () => {
  const hub = tempRoot();
  commit(hub, [assertion('a'), { op: 'SUPERSEDE', target_id: 'D1', option_code: 'b', summary: 'B', reason: 'A failed' }]);
  commit(hub, [assertion('b'), { op: 'OPEN_QUESTION', key: 'q', summary: 'What now?' }]);
  const undo = { ...projectScope, reason: 'Wrong' };
  assert.equal(hubStore.revertScopedCommit(hub, { ...undo, commitSeq: 2 }).status, 'unsupported_commit');
  const result = hubStore.revertScopedCommit(hub, { ...undo, commitSeq: 1 });
  assert.equal(result.commit.ops.length, 1);
  assert.deepEqual(result.head.active.map(item => item.id), ['D3']);
  assert.deepEqual(result.head.tombstones.map(item => item.id), ['D1', 'D2']);
  assert.equal(replayScopedLedger(hub, projectScope).valid, true);
});

test('revert previews without writes, preserves history, restores a new D ID and refuses a later same-key change', () => {
  const hub = tempRoot();
  commit(hub, [assertion('build')]);
  commit(hub, [{ op: 'SUPERSEDE', target_id: 'D1', option_code: 'b', summary: 'new compiler', reason: 'old compiler fails' }]);
  commit(hub, [assertion('deploy')]);
  const files = resolveHubPaths(hub).ledgerPaths(projectScope);
  const log = fs.readFileSync(files.ledgerFile, 'utf8');
  const undo = { ...projectScope, commitSeq: 2, reason: 'incorrect proposal' };
  assert.equal(hubStore.revertScopedCommit(hub, { ...undo, preview: true }).status, 'preview');
  assert.equal(fs.readFileSync(files.ledgerFile, 'utf8'), log);
  const result = hubStore.revertScopedCommit(hub, undo);
  assert.equal(result.status, 'reverted');
  assert.deepEqual(result.head.active.map(({ id, option_code }) => [id, option_code]), [['D3', 'a'], ['D4', 'a']]);
  assert.deepEqual(result.head.tombstones.map(({ id, superseded_by }) => [id, superseded_by]), [['D1', 'D2'], ['D2', 'D4']]);
  assert.equal(hubStore.revertScopedCommit(hub, undo).status, 'already_reverted');
  assert.equal(hubStore.revertScopedCommit(hub, { ...undo, commitSeq: 1 }).status, 'key_changed');
  assert.equal(hubStore.revertScopedCommit(hub, { ...undo, commitSeq: 3 }).status, 'reverted');
  assert.equal(readScopedHead(hub, projectScope).tombstones.at(-1).superseded_by, null);
  assert.ok(fs.readFileSync(files.ledgerFile, 'utf8').startsWith(log));
  assert.equal(replayScopedLedger(hub, projectScope).valid, true);
});

test('two real processes race proposals at the same scoped revision; only one commits', async () => {
  const hub = tempRoot();
  const ids = [stage(hub, [assertion('alpha')]), stage(hub, [assertion('beta')])];
  const script = `
    import { commitScopedStaged } from ${JSON.stringify(new URL('../src/kernel/hub-store.mjs', import.meta.url).href)};
    import fs from 'node:fs';
    const [hub, id, ready, go] = process.argv.slice(1);
    fs.writeFileSync(ready, '');
    const start = Date.now();
    while (!fs.existsSync(go)) {
      if (Date.now() - start > 5000) throw Error('barrier timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    console.log(JSON.stringify(commitScopedStaged(hub, { scope: 'project', projectId: 'p_alpha', proposal_id: id })));
  `;
  const go = path.join(hub, 'go');
  const ready = ids.map(id => path.join(hub, id));
  const children = Promise.all(ids.map((id, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, hub, id, ready[i], go], { timeout: 7000 })));
  children.catch(() => {});
  const start = Date.now();
  while (!ready.every(file => fs.existsSync(file)) && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 5));
  fs.writeFileSync(go, '');
  const results = (await children).map(child => JSON.parse(child.stdout));
  assert.equal(results.filter(result => result.committed).length, 1);
  assert.equal(results.filter(result => result.reason === 'base_revision_conflict').length, 1);
  assert.equal(replayScopedLedger(hub, projectScope).commit_count, 1);
  assert.equal(replayScopedLedger(hub, projectScope).valid, true);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Cairn M4.1 centralized Hub store', () => {
  test('read-only checks do not initialize Hub or write into a business directory', () => {
    const business = tempRoot();
    const hub = path.join(tempRoot(), 'hub');
    assert.equal(isHubInitialized(hub), false);
    assert.equal(fs.existsSync(hub), false);
    assert.equal(fs.existsSync(path.join(business, '.cairn')), false);
  });

  test('initializes the central layout and lazily creates project ledgers', () => {
    const hub = tempRoot();
    const business = tempRoot();
    initHubStore(hub);
    assert.equal(isHubInitialized(hub), true);
    assert.equal(fs.existsSync(path.join(business, '.cairn')), false);
    assert.equal(fs.existsSync(resolveHubPaths(hub).userLedgerDir), true);
    assert.equal(fs.existsSync(resolveHubPaths(hub).projectsIndexFile), true);
    assert.equal(fs.existsSync(resolveHubPaths(hub).tasksIndexFile), true);
    assert.equal(fs.existsSync(resolveHubPaths(hub).projectLedgerDir('p_alpha')), false);
    ensureScopedLedger(hub, { scope: 'project', projectId: 'p_alpha' });
    assert.equal(fs.existsSync(resolveHubPaths(hub).projectLedgerDir('p_alpha')), true);
    assert.equal(fs.existsSync(path.join(business, '.cairn')), false);
  });

  test('keeps User and Project decisions and tombstones in isolated scoped ledgers', () => {
    const hub = tempRoot();
    initHubStore(hub);
    const userProposal = stageScopedOperators(hub, {
      scope: 'user',
      source_step: 'user-1',
      ops: [{ op: 'ASSERT', scope: 'user', key: 'editor', option_code: 'vim', summary: 'User default' }]
    });
    const projectProposal = stageScopedOperators(hub, {
      scope: 'project',
      projectId: 'p_alpha',
      source_step: 'project-1',
      ops: [{ op: 'ASSERT', scope: 'project', project_id: 'p_alpha', key: 'editor', option_code: 'code', summary: 'Project rule' }]
    });
    assert.equal(userProposal.proposal.scope, 'user');
    assert.equal(projectProposal.proposal.project_id, 'p_alpha');
    assert.equal(readScopedHead(hub, { scope: 'user' }).revision, 0);
    assert.equal(readScopedHead(hub, { scope: 'project', projectId: 'p_alpha' }).revision, 0);
  });

  test('commits and replays proposals only in their explicit scope and project', () => {
    const hub = tempRoot();
    initHubStore(hub);
    const a = stageScopedOperators(hub, {
      scope: 'project', projectId: 'p_alpha', source_step: 'a-1',
      ops: [{ op: 'ASSERT', scope: 'project', project_id: 'p_alpha', key: 'build', option_code: 'vite', summary: 'Project A' }]
    });
    const wrongTarget = commitScopedStaged(hub, { scope: 'project', projectId: 'p_beta', proposal_id: a.proposal.proposal_id });
    assert.equal(wrongTarget.committed, false);
    const committed = commitScopedStaged(hub, { scope: 'project', projectId: 'p_alpha', proposal_id: a.proposal.proposal_id });
    assert.equal(committed.head.active[0].scope, 'project');
    assert.equal(committed.head.active[0].project_id, 'p_alpha');
    assert.equal(replayScopedLedger(hub, { scope: 'project', projectId: 'p_alpha' }).valid, true);
    const userHead = readScopedHead(hub, { scope: 'user' });
    assert.equal(userHead.revision, 0);

    const pending = stageScopedOperators(hub, { scope: 'user', source_step: 'u-1', ops: [{ op: 'ASSERT', scope: 'user', key: 'editor', option_code: 'vim', summary: 'Default' }] });
    const dropped = dropScopedStaged(hub, { scope: 'user', proposal_id: pending.proposal.proposal_id });
    assert.equal(dropped.dropped, true);
    assert.equal(dropScopedStaged(hub, { scope: 'project', projectId: 'p_alpha' }).next_proposal_seq, 2);
  });

  test('uses one global task ID index and stamps every task turn with its project', () => {
    const hub = tempRoot();
    initHubStore(hub);
    upsertHubTask(hub, { id: 1, project_id: 'p_alpha', title: 'Alpha task' });
    assert.equal(fs.existsSync(path.join(hub, 'projects', 'p_alpha', 'ledger', 'head.json')), true);
    upsertHubTask(hub, { id: 2, project_id: null, title: 'General task' });
    assert.equal(readProjectsIndex(hub).projects.some(project => project.project_id === 'p_alpha'), true);
    appendHubTaskTurn(hub, { task_id: 1, project_id: 'p_alpha', turn: 1, role: 'user', content: 'A' });
    const index = readHubTasksIndex(hub);
    assert.deepEqual(index.tasks.map(task => [task.id, task.project_id]), [[1, 'p_alpha'], [2, null]]);
    assert.equal(readHubTaskThread(hub, 1)[0].project_id, 'p_alpha');
    assert.equal(fs.existsSync(path.join(hub, '.cairn')), false);
  });

  test('stores checkout binding per session and lifecycle remains independent of shared tasks', () => {
    const hub = tempRoot();
    initHubStore(hub);
    upsertHubTask(hub, { id: 1, project_id: 'p_alpha', title: 'Alpha' });
    upsertHubTask(hub, { id: 2, project_id: 'p_beta', title: 'Beta' });
    writeSessionBinding(hub, 'session-a', { project_id: 'p_alpha', task_id: 1, source: 'explicit_checkout' });
    writeSessionBinding(hub, 'session-b', { project_id: 'p_beta', task_id: 2, source: 'explicit_checkout' });
    assert.equal(readSessionBinding(hub, 'session-a').task_id, 1);
    assert.equal(readSessionBinding(hub, 'session-b').task_id, 2);
    clearSessionBinding(hub, 'session-a');
    assert.equal(readSessionBinding(hub, 'session-a'), null);
    assert.equal(readSessionBinding(hub, 'session-b').task_id, 2);
    assert.equal(transitionHubTaskStatus(hub, { taskId: 2, action: 'close' }).task.status, 'done');
  });

  test('scoped fold rejects cross-scope supersedes and preserves local IDs', () => {
    const userLedger = foldScopedLedger(null, [
      { op: 'ASSERT', scope: 'user', key: 'editor', option_code: 'vim', summary: 'User default' }
    ], { scope: 'user' });
    const projectLedger = foldScopedLedger(null, [
      { op: 'ASSERT', scope: 'project', project_id: 'p_alpha', key: 'editor', option_code: 'code', summary: 'Project override' }
    ], { scope: 'project', project_id: 'p_alpha' });
    assert.equal(userLedger.ledger.active[0].id, 'D1');
    assert.equal(projectLedger.ledger.active[0].id, 'D1');
    const rejected = foldScopedLedger(projectLedger.ledger, [
      { op: 'SUPERSEDE', scope: 'project', project_id: 'p_alpha', target_id: 'D1', option_code: 'other', summary: 'cross', reason: 'test' }
    ], { scope: 'project', project_id: 'p_beta' });
    assert.equal(rejected.accepted_ops.length, 0);
    assert.equal(rejected.rejected_ops.length, 1);
  });

  test('scoped authority contract gives project decisions precedence over User defaults and both over task history', () => {
    const contract = buildScopedAuthorityContract({ projectName: 'Alpha' });
    assert.match(contract, /Project Ledger 中明确的项目决策优先于通用 User 默认偏好/);
    assert.match(contract, /高于并覆盖 Task/);
  });
});
