import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initHubStore, upsertHubTask, appendHubTaskTurn, stageScopedOperators, commitScopedStaged, readScopedHead, readScopedStaged } from '../src/kernel/hub-store.mjs';
import { compileHubTaskCheckout } from '../src/workers/hub-task-checkout.mjs';
import { resolveStoreRoot } from '../src/workers/store-root.mjs';
import { buildHubColdRouterPrompt, runHubColdRouter } from '../src/workers/hub-cold-router.mjs';
import { runHubStagingExtractor } from '../src/workers/hub-staging-extractor.mjs';
import { runHubStrictCompactor, createHubTaskCompactionCoordinator } from '../src/workers/hub-strict-compactor.mjs';
import { runHubDoctor } from '../src/workers/hub-doctor.mjs';

test('auto-commit uses explicit authored adoption and allows technical detail from the confirmed assistant proposal', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-auto-'));
  try {
    const scope = { scope: 'project', projectId: 'p_alpha' };
    const assertion = { op: 'ASSERT', key: 'db', option_code: 'postgresql', summary: 'Use PostgreSQL as project DB.' };
    const user = '就用方案 B';
    const assistant = '方案 B：使用 PostgreSQL 作为项目数据库。';
    const evidence = [{ op_index: 0, user_quote: user, assistant_quote: assistant }];
    const staged = stageScopedOperators(hub, { ...scope, ops: [{ ...assertion, key: 'older' }] }).proposal;
    const run = (args = {}, response = { ops: [assertion], evidence }) => runHubStagingExtractor({
      hubRoot: hub, ...scope, turnInput: { user, assistant }, authoredUserText: user,
      autopilot: { enabled: true }, llmClient: { complete: async () => ({ ok: true, content: JSON.stringify(response) }) },
      ...args
    });
    for (const [name, args, response] of [
      ['disabled', { autopilot: {} }],
      ['not authored', { authoredUserText: '' }],
      ['user scope', { scope: 'user', projectId: null }],
      ['hypothetical', { authoredUserText: '如果就用方案 B，会怎样？' }],
      ['withdrawn', { authoredUserText: '就用方案 B\n不采用方案 B。' }],
      ['project disabled', { autopilot: { enabled: true, autoCommit: { project: false } } }],
      ['wrong option', {}, { ops: [assertion], evidence: [{ ...evidence[0], assistant_quote: '方案 A：使用 PostgreSQL。' }] }],
      ['wrong scope', {}, { ops: [{ ...assertion, project_id: 'p_beta' }], evidence }],
      ['mixed', {}, { ops: [assertion, { op: 'OPEN_QUESTION', key: 'db', summary: 'What next?' }], evidence }]
    ]) {
      const res = await run(args, response);
      assert.notEqual(res.autoCommit?.committed, true, name);
      assert.equal(readScopedHead(hub, scope).revision, 0, name);
    }
    const result = await run();
    assert.equal(result.autoCommit.committed, true);
    assert.equal(readScopedHead(hub, scope).active[0].option_code, 'postgresql');
    assert.ok(readScopedStaged(hub, scope).proposals.some(item => item.proposal_id === staged.proposal_id));
    assert.equal(readScopedHead(hub, { scope: 'user' }).revision, 0);
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('automatic SUPERSEDE requires supporting falsification and respects its own switch', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-auto-supersede-'));
  const scope = { scope: 'project', projectId: 'p_alpha' };
  try {
    const { proposal } = stageScopedOperators(hub, { ...scope, ops: [{ op: 'ASSERT', key: 'db', option_code: 'sqlite', summary: 'SQLite' }] });
    commitScopedStaged(hub, { ...scope, proposal_id: proposal.proposal_id });
    const user = 'Switch to PostgreSQL';
    const reason = 'SQLite fails the concurrent writer test';
    const run = (falsification_quote, supersede = true) => runHubStagingExtractor({
      hubRoot: hub, ...scope, authoredUserText: user, turnInput: { user, assistant: reason },
      autopilot: { enabled: true, autoCommit: { supersede } },
      llmClient: { complete: async () => ({ ok: true, content: JSON.stringify({
        ops: [{ op: 'SUPERSEDE', target_id: 'D1', option_code: 'postgresql', summary: 'PostgreSQL', reason }],
        evidence: [{ op_index: 0, user_quote: user, falsification_quote }]
      }) }) }
    });
    assert.equal((await run(user)).autoCommit, null);
    assert.equal((await run(reason, false)).autoCommit, null);
    assert.equal((await run(reason)).autoCommit.committed, true);
    assert.equal(readScopedHead(hub, scope).tombstones[0].id, 'D1');
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('auto-commit does not hold the write lock during extraction and never rebases a stale proposal', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-auto-race-'));
  const scope = { scope: 'project', projectId: 'p_alpha' };
  try {
    const user = 'Use Redis';
    const outcome = await runHubStagingExtractor({
      hubRoot: hub, ...scope, authoredUserText: user, turnInput: { user },
      autopilot: { enabled: true }, llmClient: { complete: async () => {
        assert.equal(fs.existsSync(path.join(hub, '.write.lock')), false);
        const { proposal } = stageScopedOperators(hub, { ...scope, ops: [{ op: 'ASSERT', key: 'db', option_code: 'sqlite', summary: 'SQLite' }] });
        commitScopedStaged(hub, { ...scope, proposal_id: proposal.proposal_id });
        return { ok: true, content: JSON.stringify({ ops: [{ op: 'ASSERT', key: 'cache', option_code: 'redis', summary: 'Redis' }], evidence: [{ op_index: 0, user_quote: user }] }) };
      } }
    });
    assert.equal(outcome.autoCommit.reason, 'base_revision_conflict');
    assert.equal(readScopedHead(hub, scope).revision, 1);
    assert.equal(readScopedStaged(hub, scope).proposals.length, 1);
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

describe('M4.1 Hub workers', () => {
  test('compiles project-labelled task checkout without writing to business roots', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-worker-'));
    const hub = path.join(temp, 'hub');
    const business = path.join(temp, 'business');
    fs.mkdirSync(business);
    try {
      initHubStore(hub);
      upsertHubTask(hub, { id: 1, project_id: 'p_alpha', title: 'Alpha task' });
      appendHubTaskTurn(hub, { task_id: 1, project_id: 'p_alpha', turn: 1, role: 'user', content: 'alpha details' });
      const result = compileHubTaskCheckout({ hubRoot: hub, taskId: 1 });
      assert.equal(result.project_id, 'p_alpha');
      assert.match(result.text, /Project Ledger/);
      assert.match(result.text, /alpha details/);
      assert.deepEqual(fs.readdirSync(business), []);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  test('resolves store root with explicit > DSH_HOME > home precedence', () => {
    assert.equal(resolveStoreRoot({ storeRoot: './explicit', env: { DSH_HOME: './dsh' }, homeDir: './home' }), path.resolve('./explicit'));
    assert.equal(resolveStoreRoot({ env: { DSH_HOME: './dsh' }, homeDir: './home' }), path.resolve('./dsh/cairn'));
    assert.equal(resolveStoreRoot({ env: {}, homeDir: './home' }), path.resolve('./home/.cairn'));
  });

  test('routes with project metadata and treats cwd project as a soft hint without writing', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-router-'));
    const hub = path.join(temp, 'hub');
    try {
      initHubStore(hub);
      upsertHubTask(hub, { id: 1, project_id: 'p_beta', title: 'Beta migration' });
      const projectsBefore = JSON.parse(fs.readFileSync(path.join(hub, 'projects', 'index.json'), 'utf8')).projects;
      const prompt = buildHubColdRouterPrompt([{ id: 1, project_id: 'p_beta', project_name: 'Beta', title: 'Migration', status: 'active' }], { cwdProjectHint: 'p_alpha' });
      assert.match(prompt, /p_beta/);
      assert.match(prompt, /soft prior/);
      let request;
      const routed = await runHubColdRouter({ hubRoot: hub, userPrompt: 'continue beta', cwdProjectHint: 'p_alpha', llmClient: { complete: async args => { request = args; return { ok: true, content: '{"decision":"match","task_id":1,"project_id":"p_beta","candidates":[1],"reason":"specific"}' }; } } });
      assert.equal(routed.project_id, 'p_beta');
      assert.match(request.system, /p_alpha/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hub, 'projects', 'index.json'), 'utf8')).projects, projectsBefore);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  test('general-session staging is User scope and cannot assign a project', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-staging-'));
    const hub = path.join(temp, 'hub');
    try {
      initHubStore(hub);
      let request;
      const result = await runHubStagingExtractor({ hubRoot: hub, scope: 'user', projectId: 'must-be-ignored', turnInput: { turn: 1, messages: [{ role: 'user', content: 'Use concise answers across my projects.' }] }, llmClient: { complete: async args => { request = args; return { ok: true, content: '{"ops":[{"op":"ASSERT","scope":"user","key":"response_style","option_code":"concise","summary":"Prefer concise answers"}]}' }; } } });
      assert.equal(result.staged, true);
      assert.match(request.system, /跨项目默认偏好/);
      assert.match(request.system, /不得猜测项目归属/);
      const staged = JSON.parse(fs.readFileSync(path.join(hub, 'user', 'ledger', 'staged.json'), 'utf8'));
      assert.equal(staged.proposals[0].project_id, null);
      assert.equal(fs.existsSync(path.join(hub, 'projects', 'index.json')) && JSON.parse(fs.readFileSync(path.join(hub, 'projects', 'index.json'), 'utf8')).projects.length, 0);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  test('Hub compaction uses shared per-task lock and updates the global task cursor atomically', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-compact-'));
    const hub = path.join(temp, 'hub');
    try {
      initHubStore(hub);
      upsertHubTask(hub, { id: 1, project_id: null, title: 'General' });
      appendHubTaskTurn(hub, { task_id: 1, project_id: null, turn: 1, role: 'user', content: 'Local step details' });
      const results = [];
      const coordinator = createHubTaskCompactionCoordinator({ hubRoot: hub, compactor: async args => { results.push(args); await new Promise(resolve => setTimeout(resolve, 5)); return runHubStrictCompactor({ ...args, llmClient: { complete: async () => ({ ok: true, content: 'Local task summary.' }) } }); } });
      await Promise.all([coordinator.run({ taskId: 1 }), coordinator.run({ taskId: 1 })]);
      assert.equal(results.length, 2);
      const index = JSON.parse(fs.readFileSync(path.join(hub, 'tasks', 'index.json'), 'utf8'));
      assert.equal(index.tasks[0].compacted_record_count, 1);
      assert.equal(fs.readFileSync(path.join(hub, 'tasks', '1', 'compact.md'), 'utf8'), 'Local task summary.');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  test('Hub doctor is read-only when the Hub is not initialized', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-doctor-'));
    const hub = path.join(temp, 'hub');
    try {
      const report = runHubDoctor({ hubRoot: hub });
      assert.equal(report.hub_initialized, false);
      assert.deepEqual(fs.readdirSync(temp), []);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
});
