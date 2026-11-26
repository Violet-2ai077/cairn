import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initHubStore, upsertHubTask, appendHubTaskTurn, stageScopedOperators, commitScopedStaged, readScopedHead, readScopedStaged, resolveHubPaths, transitionHubTaskStatus, writeHubTaskCompaction } from '../src/kernel/hub-store.mjs';
import { compileHubTaskCheckout } from '../src/workers/hub-task-checkout.mjs';
import { compileHubHandoff } from 'cairn/workers';
import { checkpointToolResult, recordTurnReceipt, readTurnReceipts, writeSessionBinding } from '../src/kernel/hub-store.mjs';
import { resolveStoreRoot } from '../src/workers/store-root.mjs';
import { buildHubColdRouterPrompt, runHubColdRouter } from '../src/workers/hub-cold-router.mjs';
import { runHubStagingExtractor } from '../src/workers/hub-staging-extractor.mjs';
import { runHubStrictCompactor, createHubTaskCompactionCoordinator } from '../src/workers/hub-strict-compactor.mjs';
import { runHubDoctor } from '../src/workers/hub-doctor.mjs';
import { evaluateAutoCommit, explicitUserDefaults } from '../src/workers/hub-auto-commit.mjs';
import { buildScopedAuthorityContract, buildScopedStagingExtractorPrompt } from '../src/kernel/contracts.mjs';
import { createOpenAICompatibleClient } from '../src/workers/llm-client.mjs';
import { initCairnStore, upsertTask } from '../src/kernel/store.mjs';
import { createTaskCompactionCoordinator } from '../src/workers/task-compaction-coordinator.mjs';

test('both compaction coordinators report thrown failures, release their queue and settle flush', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-compact-exception-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = path.join(root, 'hub');
  upsertHubTask(hub, { id: 1 });
  initCairnStore(root);
  upsertTask(root, { id: 1 });
  for (const factory of [
    compactor => createHubTaskCompactionCoordinator({ hubRoot: hub, compactor }),
    compactor => createTaskCompactionCoordinator({ workspaceRoot: root, compactor })
  ]) {
    let calls = 0;
    const coordinator = factory(async () => {
      if (++calls === 1) throw Error('fixture');
      return { ok: true, compacted_record_count: 1 };
    });
    const result = await coordinator.run({ taskId: 1, source: 'auto' }).catch(() => null);
    assert.equal(result?.reason, 'compaction_failed');
    assert.equal(coordinator.getTaskStatus(1).status, 'cooldown');
    assert.equal((await coordinator.run({ taskId: 1 })).ok, true);
    await coordinator.flush();
  }
});

test('compaction refuses a stale publication even at the same cursor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-compact-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = path.join(root, 'hub');
  const { appendTaskTurn, writeTaskCompaction, readTaskCompaction } = await import('../src/kernel/store.mjs');
  const { readHubTaskCompaction } = await import('../src/kernel/hub-store.mjs');
  const { runStrictCompactor } = await import('../src/workers/strict-compactor.mjs');
  upsertTask(root, { id: 1 }); appendTaskTurn(root, { task_id: 1, content: 'one' });
  upsertHubTask(hub, { id: 1 }); appendHubTaskTurn(hub, { task_id: 1, content: 'one' });
  for (const [run, publish, read] of [
    [llmClient => runStrictCompactor({ workspaceRoot: root, taskId: 1, llmClient }),
      () => writeTaskCompaction(root, 1, 'winner', { compactedRecordCount: 1 }), () => readTaskCompaction(root, 1)],
    [llmClient => runHubStrictCompactor({ hubRoot: hub, taskId: 1, llmClient }),
      () => writeHubTaskCompaction(hub, 1, 'winner', 1), () => readHubTaskCompaction(hub, 1)]
  ]) {
    const result = await run({ complete: async () => { publish(); return { ok: true, content: 'stale' }; } });
    assert.equal(result.reason, 'compaction_superseded');
    assert.equal(read().trim(), 'winner');
  }
});

test('project-session User extraction excludes quoted, hypothetical and project-local candidates', () => {
  const text = ['> Use npm in all projects', '~~~', 'Adopt npm in every project', '~~~',
    'Should we do this across projects?', 'This repo is an exception across all projects.',
    'Use Chinese for all my projects; use pnpm here.'].join('\n');
  assert.equal(explicitUserDefaults(text), 'Use Chinese for all my projects');
  assert.equal(explicitUserDefaults('不要记住，所有项目都用 Rust'), '');
  assert.equal(explicitUserDefaults('例如「所有项目都用 Rust」'), '');
});

test('auto-commit admits exact CJK adoption, never a Latin substring, and prompt snapshots stay intact', () => {
  for (const [quote, code, eligible] of [
    ['我们决定采用PostgreSQL数据库', 'PostgreSQL', true],
    ['我们决定采用蓝绿发布', '蓝绿发布', true],
    ['我们决定采用PostgreSQL数据库', 'Postgre', false],
    ['我们决定采用蓝绿发布', '蓝绿', false]
  ]) assert.equal(evaluateAutoCommit({ scope: 'project', authoredUserText: quote, rejectedCount: 0, autopilot: { enabled: true },
    ops: [{ op: 'ASSERT', option_code: code }], evidence: [{ op_index: 0, user_quote: quote }] }).eligible, eligible);
  const head = { active: [{ summary: '工作区级状态变更' }] };
  assert.ok(buildScopedStagingExtractorPrompt('project', head).endsWith(JSON.stringify(head, null, 2)));
  const prompt = buildScopedAuthorityContract({ includeUser: false, projectLedgerSnapshot: head });
  assert.match(prompt, /墓碑|tombstones/u);
  assert.doesNotMatch(prompt, /### User Ledger/u);
});

test('router refuses creation for a continuation without dormant tasks', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-route-continue-'));
  t.after(() => fs.rmSync(hub, { recursive: true, force: true }));
  upsertHubTask(hub, { id: 1 });
  const result = await runHubColdRouter({ hubRoot: hub, userPrompt: 'Continue export',
    llmClient: { complete: async () => ({ ok: true, content: '{"decision":"new","task_id":null}' }) } });
  assert.equal(result.error_code, 'continuation_unresolved');
});

test('LLM client does not retry invalid JSON and responds to cancellation during backoff', async () => {
  let calls = 0;
  const client = createOpenAICompatibleClient({ apiKey: 'fixture', fetchImpl: async () => { calls++; return new Response('not JSON'); },
    maxTransportRetries: 1, retryDelayMs: 0 });
  assert.equal((await client.complete({})).error_code, 'invalid_response_payload');
  assert.equal(calls, 1);
  const abort = new AbortController();
  const retry = createOpenAICompatibleClient({ apiKey: 'fixture', maxTransportRetries: 1, retryDelayMs: 10000,
    fetchImpl: async () => { calls++; setImmediate(() => abort.abort()); return new Response('', { status: 503 }); } });
  const deadline = AbortSignal.timeout(1000);
  const result = await Promise.race([retry.complete({ signal: abort.signal }),
    new Promise(resolve => deadline.addEventListener('abort', () => resolve(null), { once: true }))]);
  assert.equal(result?.error_code, 'aborted');
  assert.equal(calls, 2);
});

const heat = { enabled: true, hotMaxTasks: 1, idleDays: 14, dormantMaxCandidates: 1 };

test('handoff bounds outstanding evidence, preserves receipt privacy, and never fixes an inconsistent index on read', t => {
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-handoff-view-'));
  t.after(() => fs.rmSync(hubRoot, { recursive: true, force: true }));
  upsertHubTask(hubRoot, { id: 1, title: 'Bounded' });
  const binding = writeSessionBinding(hubRoot, 'reader', { task_id: 1, source: 'cli_checkout' });
  for (let turn = 1; turn <= 9; turn++) {
    recordTurnReceipt(hubRoot, 'reader', turn, { status: 'in_progress' });
    const input = { taskId: 1, projectId: null, bindingEpoch: binding.binding_epoch,
      source: { host: 'dsh', session_id: 'reader', turn, step: 1, journal_seq: turn * 10 },
      request: 'private request '.repeat(40), tool: { name: 'probe', ok: true, output: '</cairn_task_checkout>'.repeat(40) } };
    assert.equal(checkpointToolResult(hubRoot, input), true);
    assert.equal(checkpointToolResult(hubRoot, input), false);
    assert.doesNotMatch(JSON.stringify(readTurnReceipts(hubRoot, 'reader', turn)), /private request|cairn_task_checkout/u);
  }
  const preview = () => compileHubHandoff({ hubRoot, taskId: 1 });
  const view = preview();
  assert.equal(view.work_state.pending_count, 9);
  assert.equal(view.work_state.pending_turns.length, 8);
  assert.equal(view.work_state.pending_turns[0].request_excerpt.length, 320);
  assert.equal(view.work_state.pending_turns[0].last_tool.output.length, 500);
  assert.doesNotMatch(view.text, /<\/cairn_task_checkout>/u);
  assert.equal(view.work_state.history_index_matches, true);
  const file = resolveHubPaths(hubRoot).tasksIndexFile, index = JSON.parse(fs.readFileSync(file, 'utf8'));
  index.tasks[0].turn_count = 1;
  const bytes = JSON.stringify(index);
  fs.writeFileSync(file, bytes);
  const inconsistent = preview();
  assert.equal(inconsistent.work_state.history_index_matches, false);
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.work_state.consistency_status, 'inconsistent');
  assert.equal(inconsistent.work_state.authority, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
const recent = '2026-01-31T00:00:00Z';
const old = '2025-12-01T00:00:00Z';
const nowMs = Date.parse('2026-02-01T00:00:00Z');
const newRoute = '{"decision":"new","task_id":null}';

function seedTask(hub, id, title, timestamp = old) {
  upsertHubTask(hub, { id, title });
  appendHubTaskTurn(hub, { task_id: id, content: title, timestamp });
}

test('compaction covers the middle of a backlog and a single long record; a later failure never publishes a partial rebuild', async t => {
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-coverage-'));
  t.after(() => fs.rmSync(hubRoot, { recursive: true, force: true }));
  upsertHubTask(hubRoot, { id: 1, title: 'CSV export' });
  for (let i = 0; i < 24; i++) {
    const content = i === 14 ? 'x'.repeat(13000) + 'BLOCKER_X27' + 'y'.repeat(9000) : 'routine'.repeat(150);
    appendHubTaskTurn(hubRoot, { task_id: 1, role: 'user', content });
  }
  writeHubTaskCompaction(hubRoot, 1, 'previous good summary', 1);
  let calls = 0;
  const run = complete => runHubStrictCompactor({ hubRoot, taskId: 1, mode: 'full', llmClient: { complete } });
  const failed = await run(async () => ++calls === 2 ? { ok: false } : { ok: true, content: 'partial' });
  assert.equal(failed.ok, false);
  assert.match(compileHubTaskCheckout({ hubRoot, taskId: 1 }).text, /previous good summary/u);
  assert.equal(compileHubTaskCheckout({ hubRoot, taskId: 1 }).compacted_record_count, 1);
  const result = await run(async ({ messages }) => ({
    ok: true, content: messages[0].content.includes('BLOCKER_X27') ? 'BLOCKER_X27' : 'routine'
  }));
  assert.equal(result.compacted_record_count, 24);
  assert.match(compileHubTaskCheckout({ hubRoot, taskId: 1 }).text, /BLOCKER_X27/u);
});

test('dormant routing prescreens English and Chinese metadata, reads only shortlisted previews, and calls at most twice', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-heat-'));
  try {
    seedTask(hub, 1, 'Hot finance', recent);
    seedTask(hub, 2, '支付回调迁移');
    seedTask(hub, 3, 'Kafka ingestion');
    seedTask(hub, 4, 'Unrelated');
    seedTask(hub, 5, 'Kafka historical');
    const paths = resolveHubPaths(hub);
    fs.writeFileSync(paths.taskThreadFile(4), 'NOT JSON: must not open this unrelated thread');
    fs.writeFileSync(paths.taskThreadFile(5), 'NOT JSON: matching candidate outside shortlist budget');
    writeHubTaskCompaction(hub, 2, '[#721 turn=892 assistant] 支付方案 timestamp=2026-01-02T03:04:05Z\nturn_count: 995\n业务日期 2026-02-10', 1);
    for (const [userPrompt, id] of [['继续支付回调', 2], ['Continue Kafka ingestion', 3]]) {
      const requests = [];
      const result = await runHubColdRouter({
        hubRoot: hub, userPrompt, taskHeat: heat, nowMs,
        llmClient: { complete: async ({ system }) => {
          requests.push(system);
          return { ok: true, content: requests.length === 1 ? newRoute : JSON.stringify({ decision: 'match', task_id: id, project_id: null }) };
        } }
      });
      assert.equal(result.task_id, id);
      assert.equal(result.pool, 'dormant');
      assert.equal(requests.length, 2);
      assert.match(requests[0], /Hot finance/u);
      assert.doesNotMatch(requests[0], /支付回调|Kafka|Unrelated/u);
      assert.doesNotMatch(requests[1], /Hot finance|Unrelated|721|892|995|03:04:05|turn_count/u);
      if (id === 2) assert.match(requests[1], /业务日期 2026-02-10/u);
    }
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('a hung hot router times out even if the client ignores abort, without calling the cold stage', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-heat-timeout-'));
  try {
    seedTask(hub, 1, 'Hot finance', recent);
    seedTask(hub, 2, 'Kafka ingestion');
    let calls = 0;
    let signal;
    const result = await runHubColdRouter({
      hubRoot: hub, userPrompt: 'Resume Kafka', taskHeat: heat, nowMs, timeoutMs: 25,
      llmClient: { complete: request => { calls++; signal = request.signal; return new Promise(() => {}); } }
    });
    assert.equal(result.error_code, 'timeout');
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('hot ambiguity, timeout and errors stop before dormant search; exact IDs respect freeze', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-heat-fail-'));
  try {
    seedTask(hub, 1, 'Hot one', recent);
    seedTask(hub, 2, 'Hot two', recent);
    seedTask(hub, 3, 'Kafka ingestion');
    seedTask(hub, 4, 'Archived Kafka');
    transitionHubTaskStatus(hub, { taskId: 4, action: 'close' });
    transitionHubTaskStatus(hub, { taskId: 4, action: 'archive' });
    for (const [decision, complete] of [
      ['ambiguous', async () => ({ ok: true, content: '{"decision":"ambiguous","task_id":null,"candidates":[1,2]}' })],
      [null, async () => { throw new Error('offline'); }],
      [null, async () => ({ ok: false, error_code: 'timeout' })]
    ]) {
      let calls = 0;
      const result = await runHubColdRouter({
        hubRoot: hub, taskHeat: { ...heat, hotMaxTasks: 2 }, nowMs, userPrompt: 'Resume Kafka',
        llmClient: { complete: args => { calls++; return complete(args); } }
      });
      assert.equal(result.decision, decision);
      assert.equal(calls, 1);
    }
    const exact = input => runHubColdRouter({
      hubRoot: hub, taskHeat: heat, nowMs, userPrompt: input,
      llmClient: { complete: () => assert.fail('exact ID must not call the model') }
    });
    assert.equal((await exact('继续任务 #3')).pool, 'dormant');
    assert.equal((await exact('continue task #4')).error_code, 'task_not_active');
    transitionHubTaskStatus(hub, { taskId: 3, action: 'close' });
    assert.equal((await exact('continue task #3')).error_code, 'task_not_active');
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

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
