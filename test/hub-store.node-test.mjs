import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
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

const temporaryRoots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-test-'));
  temporaryRoots.push(root);
  return root;
}

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
