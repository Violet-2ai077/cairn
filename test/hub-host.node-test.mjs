import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHubDshHost } from '../src/hosts/dsh/hub-host.mjs';
import { initHubStore, readProjectsIndex, upsertHubTask, appendHubTaskTurn, readHubTaskThread, writeSessionBinding, stageScopedOperators, commitScopedStaged, readScopedLedgerLog, readSessionBinding, readHubTasksIndex, transitionHubTaskStatus } from '../src/kernel/hub-store.mjs';

function mockCtx() {
  const contexts = [];
  const handlers = new Map();
  const registeredCommands = [];
  const tools = [];
  return {
    contexts, handlers, registeredCommands, tools,
    systemPrompt: { context(def) { contexts.push(def); return () => {}; } },
    on(name, handler) { handlers.set(name, handler); return () => {}; },
    commands: { register(def) { registeredCommands.push(def); return () => {}; } },
    tools: { register(def) { tools.push(def); assert.ok(def.output?.schema && typeof def.output.render === 'function'); return () => {}; } },
    llm: { async *stream() { yield { type: 'text-delta', text: '' }; } }
  };
}

test('Hub budgets its catalog and routes only the current authored input; dormant checkout mounts in the wake turn', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-heat-'));
  const ctx = mockCtx();
  const calls = [];
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true, taskHeat: { hotMaxTasks: 1 } },
    llmClient: { complete: async request => {
      calls.push(request);
      return { ok: true, content: calls.length === 1 ? '{"decision":"new","task_id":null}' : '{"decision":"match","task_id":2,"project_id":"p_old"}' };
    } }
  });
  try {
    upsertHubTask(hub, { id: 1, title: 'Hot only' });
    appendHubTaskTurn(hub, { task_id: 1, content: 'Hot body' });
    upsertHubTask(hub, { id: 2, project_id: 'p_old', title: 'Kafka ingest' });
    appendHubTaskTurn(hub, { task_id: 2, project_id: 'p_old', content: 'Kafka checkout detail', timestamp: '2000-01-01T00:00:00Z' });
    upsertHubTask(hub, { id: 3, title: 'Frozen' });
    transitionHubTaskStatus(hub, { taskId: 3, action: 'close' });
    const { proposal } = stageScopedOperators(hub, { scope: 'project', projectId: 'p_old', ops: [{ op: 'ASSERT', key: 'mode', option_code: 'safe', summary: 'Project policy sentinel' }] });
    commitScopedStaged(hub, { scope: 'project', projectId: 'p_old', proposal_id: proposal.proposal_id });
    const session = { id: 'wake' };
    const catalog = ctx.contexts[0].text({ session });
    assert.match(catalog, /Hot only/u);
    assert.doesNotMatch(catalog, /Kafka ingest|Frozen|last_activity_at/u);
    assert.equal(ctx.contexts[1].text({ session }), '');
    const messages = [
      { source: { kind: 'user' }, content: 'Historical input sentinel' },
      { source: { kind: 'user' }, content: 'Resume Kafka\n<system-reminder>Generated sentinel</system-reminder>' },
      { source: { kind: 'runtime-context' }, content: 'Synthetic sentinel' }
    ];
    await ctx.handlers.get('agent/pre-step')({ session, turn: 2, messages }, async () => ({ kind: 'enter' }));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.messages[0].content === 'Resume Kafka'));
    const checkout = ctx.contexts[1].text({ session });
    assert.match(checkout, /Kafka checkout detail/u);
    assert.match(checkout, /Project policy sentinel/u);
    assert.equal(readSessionBinding(hub, session.id).task_id, 2);
    assert.notEqual(readHubTasksIndex(hub).tasks[1].last_activity_at, '2000-01-01T00:00:00Z');
    const list = await ctx.registeredCommands[0].handler({ rawInput: 'tasks --all' });
    assert.deepEqual(JSON.parse(list.text).map(task => [task.id, task.status, task.pool]), [[1, 'active', 'dormant'], [2, 'active', 'hot'], [3, 'done', 'excluded']]);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Hub rechecks lifecycle when a dormant task closes between the router and wake write', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-wake-race-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, {
    storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => {
      transitionHubTaskStatus(hub, { taskId: 1, action: 'close' });
      return { ok: true, content: '{"decision":"match","task_id":1,"project_id":"p_old"}' };
    } }
  });
  try {
    upsertHubTask(hub, { id: 1, project_id: 'p_old', title: 'Kafka' });
    appendHubTaskTurn(hub, { task_id: 1, project_id: 'p_old', content: 'old task', timestamp: '2000-01-01T00:00:00Z' });
    const session = { id: 'lost-race' };
    await ctx.handlers.get('agent/pre-step')({ session, messages: [{ source: { kind: 'user' }, content: 'Resume Kafka' }] }, async () => ({ kind: 'enter' }));
    assert.equal(readSessionBinding(hub, session.id), null);
    assert.doesNotMatch(ctx.contexts[1].text({ session }), /Current Project Ledger|Task Checkout/u);
    assert.equal(readHubTasksIndex(hub).tasks[0].last_activity_at, '2000-01-01T00:00:00Z');
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Hub host withholds cwd project ledger until pre-step locks the project and keeps task ledgers isolated', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-host-'));
  const hub = path.join(temp, 'hub');
  const projectA = path.join(temp, 'project-a');
  const projectB = path.join(temp, 'project-b');
  for (const dir of [projectA, projectB]) { fs.mkdirSync(dir); execFileSync('git', ['init', '-q'], { cwd: dir }); }
  const hintA = (await import('../src/hosts/dsh/git-project.mjs')).resolveGitProjectHint(projectA);
  const hintB = (await import('../src/hosts/dsh/git-project.mjs')).resolveGitProjectHint(projectB);
  initHubStore(hub);
  upsertHubTask(hub, { id: 1, project_id: hintB.project_id, project: hintB, title: 'Beta service migration' });
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, llmClient: { complete: async () => ({ ok: true, content: JSON.stringify({ decision: 'match', task_id: 1, project_id: hintB.project_id, candidates: [1], reason: 'specific beta service' }) }) } });
  try {
    const base = ctx.contexts[0].text({ agent: { session: { id: 's1', header: { cwd: projectA } } } });
    assert.doesNotMatch(base, /Current Project Ledger[\s\S]*beta service/u);
    await ctx.handlers.get('agent/pre-step')({ agent: { session: { id: 's1', header: { cwd: projectA } } }, modelSelection: { provider: 'p', model: 'm' }, messages: [{ source: { kind: 'user' }, content: 'continue beta service migration' }] }, async () => ({ kind: 'enter' }));
    const locked = ctx.contexts[1].text({ agent: { session: { id: 's1' } } });
    assert.doesNotMatch(locked, /### User Ledger/u);
    assert.match(locked, new RegExp(hintB.project_id));
    assert.doesNotMatch(locked, new RegExp(hintA.project_id));
    const inspectResult = await ctx.registeredCommands[0].handler({ rawInput: 'inspect', agent: { session: { id: 's1' } } });
    const inspect = JSON.parse(inspectResult.text);
    assert.match(inspect.selected_project_fingerprint, /^ws_[0-9a-f]{8}$/u);
    assert.equal(inspect.binding_source, 'cold_router_match');
    assert.doesNotMatch(inspectResult.text, /[A-Z]:[\\/]|Continue beta|specific beta service/iu);
    const doctor = await ctx.registeredCommands[0].handler({ rawInput: 'doctor', agent: { session: { id: 's1' } } });
    assert.match(doctor.text, /task_thread_missing/u);
    assert.equal(fs.existsSync(path.join(projectA, '.cairn')), false);
    assert.equal(fs.existsSync(path.join(projectB, '.cairn')), false);
  } finally { await host.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('general bindings mount checkout and a redelivered half-written turn fills only the missing role', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-general-'));
  const ctx = mockCtx();
  let calls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, llmClient: { complete: async () => { calls++; return { ok: true, content: '{"ops":[]}' }; } } });
  try {
    upsertHubTask(hub, { id: 1, title: 'General' });
    const session = { id: 'general' };
    writeSessionBinding(hub, session.id, { task_id: 1 });
    const meta = { dsh_session_id: session.id };
    appendHubTaskTurn(hub, { task_id: 1, turn: 1, role: 'user', content: 'Saved half', meta });
    const pre = ctx.handlers.get('agent/pre-step');
    await pre({ session, turn: 1 }, async () => ({ kind: 'enter' }));
    const checkout = ctx.contexts[1].text({ session });
    assert.match(checkout, /Saved half/u);
    assert.doesNotMatch(checkout, /### Current Project Ledger/u);
    const event = ctx.handlers.get('session/event');
    for (let i = 0; i < 2; i++) {
      event(session, { type: 'turn/start', data: { turn: 1 } });
      event(session, { type: 'user/message', data: { message: { source: { kind: 'user' }, content: 'Saved half' } } });
      event(session, { type: 'assistant/message', data: { message: { content: 'Finished.\n<|task:1|>' } } });
      event(session, { type: 'turn/end', data: { turn: 1 } });
      await ctx.handlers.get('session/flush')(session);
    }
    assert.deepEqual(readHubTaskThread(hub, 1).map(record => record.role), ['user', 'assistant']);
    assert.equal(calls, 1);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('delayed Hub worker uses its turn model even after another session selects a different route', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-route-'));
  const ctx = mockCtx();
  const seen = [];
  ctx.llm.stream = async function* (request) {
    seen.push([request.sessionId, request.provider, request.model]);
    yield { type: 'text-delta', text: '{"ops":[]}' };
  };
  const host = await createHubDshHost(ctx, { storeRoot: hub });
  try {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const pre = ctx.handlers.get('agent/pre-step');
    const enter = async () => ({ kind: 'enter' });
    await pre({ session: a, turn: 1, modelSelection: { provider: 'p1', model: 'm1' } }, enter);
    await pre({ session: b, turn: 1, modelSelection: { provider: 'p2', model: 'm2' } }, enter);
    const event = ctx.handlers.get('session/event');
    event(a, { type: 'turn/start', data: { turn: 1 } });
    event(a, { type: 'user/message', data: { message: { source: { kind: 'user' }, content: 'Work' } } });
    event(a, { type: 'assistant/message', data: { message: { content: 'Done\n<|task:1|>' } } });
    event(a, { type: 'turn/end', data: { turn: 1 } });
    await ctx.handlers.get('session/flush')(a);
    assert.deepEqual(seen, [['a', 'p1', 'm1']]);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Hub slash undo accepts explicit scope and commit, and preview does not append', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-undo-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub });
  try {
    const { proposal } = stageScopedOperators(hub, { ops: [{ op: 'ASSERT', key: 'editor', option_code: 'vim', summary: 'Vim' }] });
    commitScopedStaged(hub, { proposal_id: proposal.proposal_id });
    const run = rawInput => ctx.registeredCommands[0].handler({ rawInput });
    assert.equal(JSON.parse((await run('undo user 1 --preview wrong decision')).text).status, 'preview');
    assert.equal(readScopedLedgerLog(hub).length, 1);
    assert.equal(JSON.parse((await run('undo user 1 wrong decision')).text).status, 'reverted');
    assert.equal(readScopedLedgerLog(hub).length, 2);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Hub passes only authored user evidence to enabled Project auto-commit', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-auto-'));
  const hub = path.join(temp, 'hub');
  const cwd = path.join(temp, 'project');
  const ctx = mockCtx();
  const proof = 'Use Redis';
  const result = { ops: [{ op: 'ASSERT', key: 'cache', option_code: 'redis', summary: 'Use Redis' }], evidence: [{ op_index: 0, user_quote: proof }] };
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => ({ ok: true, content: JSON.stringify(result) }) } });
  try {
    fs.mkdirSync(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    const session = { id: 'auto', header: { cwd } };
    await ctx.handlers.get('agent/pre-step')({ session, turn: 1 }, async () => ({ kind: 'enter' }));
    const event = ctx.handlers.get('session/event');
    const finish = async (turn, source) => {
      event(session, { type: 'turn/start', data: { turn } });
      event(session, { type: 'user/message', surfaceOp: 'append', data: { message: { source: { kind: source }, content: proof } } });
      event(session, { type: 'assistant/message', data: { message: { content: 'Done.\n<|task:1|>' } } });
      event(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
      await ctx.handlers.get('session/flush')(session);
    };
    await finish(1, 'runtime-context');
    const scope = { scope: 'project', projectId: readProjectsIndex(hub).projects[0].project_id };
    assert.equal(readScopedLedgerLog(hub, scope).length, 0);
    assert.equal(readHubTaskThread(hub, 1)[0].content, '');
    assert.equal(readHubTasksIndex(hub).tasks[0].last_activity_at, null);
    await finish(2, 'user');
    assert.equal(readScopedLedgerLog(hub, scope)[0].mode, 'auto');
    assert.notEqual(readHubTasksIndex(hub).tasks[0].last_activity_at, null);
  } finally { await host.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Hub session event persists marker-labelled turns centrally and session flush drains staging', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-event-'));
  const hub = path.join(temp, 'hub');
  const project = path.join(temp, 'project'); fs.mkdirSync(project); execFileSync('git', ['init', '-q'], { cwd: project });
  const ctx = mockCtx();
  let stagingCalls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, llmClient: { complete: async () => { stagingCalls++; await ctx.handlers.get('session/flush')?.({ id: 'new-session' }); return { ok: true, content: '{"ops":[]}' }; } } });
  try {
    await ctx.handlers.get('agent/pre-step')({ agent: { session: { id: 'new-session', header: { cwd: project } } }, messages: [{ source: { kind: 'user' }, content: 'Create a project task' }] }, async () => ({ kind: 'enter' }));
    const event = ctx.handlers.get('session/event');
    const session = { id: 'new-session', header: { cwd: project } };
    event(session, { type: 'turn/start', data: { turn: 1 } });
    event(session, { type: 'user/message', data: { message: { content: 'Build the alpha endpoint' } } });
    event(session, { type: 'assistant/message', data: { message: { content: 'I will create the endpoint.\n<|task:1|>' } } });
    event(session, { type: 'turn/end', data: { turn: 1 } });
    await ctx.handlers.get('session/flush')(session);
    const thread = JSON.parse(fs.readFileSync(path.join(hub, 'tasks', '1', 'thread.jsonl'), 'utf8').split(/\r?\n/u)[0]);
    assert.equal(thread.project_id.startsWith('p_'), true);
    const firstTurn = fs.readFileSync(path.join(hub, 'tasks', '1', 'thread.jsonl'), 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.deepEqual(firstTurn.map(record => record.role), ['user', 'assistant']);
    assert.ok(firstTurn.every(record => record.meta?.dsh_session_id === 'new-session' && record.turn === 1));
    assert.match(thread.content, /Build the alpha endpoint/);
    assert.doesNotMatch(thread.content, /<system-reminder>/);
    assert.equal(readProjectsIndex(hub).projects[0].name, 'project');
    event(session, { type: 'turn/start', data: { turn: 1 } });
    event(session, { type: 'user/message', data: { message: { content: 'Build the alpha endpoint' } } });
    event(session, { type: 'assistant/message', data: { message: { content: 'I will create the endpoint.\n<|task:1|>' } } });
    event(session, { type: 'turn/end', data: { turn: 1 } });
    await ctx.handlers.get('session/flush')(session);
    assert.equal(fs.readFileSync(path.join(hub, 'tasks', '1', 'thread.jsonl'), 'utf8').trim().split(/\r?\n/u).length, 2);
    assert.equal(stagingCalls, 1, 'duplicate session turn must not enqueue staging or auto-compaction');
    assert.equal(fs.existsSync(path.join(project, '.cairn')), false);
  } finally { await host.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
});
