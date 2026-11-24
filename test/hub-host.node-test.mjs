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

test('Slice C keeps a turn-scoped checkout, does not route follow-ups, and only trusts the completed step marker', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scope-'));
  const ctx = mockCtx();
  let routeCalls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async req => {
    if (req.system.startsWith('Route the opening')) routeCalls++;
    return { ok: true, content: '{"ops":[]}' };
  } } });
  const s = { id: 'scope' };
  const pre = ctx.handlers.get('agent/pre-step');
  const emit = (type, data) => ctx.handlers.get('session/event')(s, { type, surfaceOp: 'append', data });
  const step = (turn, step, text) => pre({ session: s, turn, step, messages: text ? [{ source: { kind: 'user' }, content: text }] : [] }, async () => ({ kind: 'enter' }));
  const assistant = (turn, step, content) => emit('assistant/message', { turn, step, message: { content } });
  try {
    for (const id of [1, 2]) {
      upsertHubTask(hub, { id, project_id: 'p_same', title: `Task ${id}` });
      appendHubTaskTurn(hub, { task_id: id, project_id: 'p_same', content: `checkout sentinel ${id}`, timestamp: '2000-01-01T00:00:00Z' });
    }
    writeSessionBinding(hub, s.id, { task_id: 1, project_id: 'p_same', source: 'slash_checkout' });
    emit('turn/start', { turn: 1 });
    await step(1, 1, 'ordinary follow-up');
    const initial = ctx.contexts[1].text({ session: s });
    assert.match(initial, /checkout sentinel 1/u);
    emit('user/message', { source: { kind: 'runtime-context' }, content: 'synthetic echo' });
    assistant(1, 1, [{ type: 'text', text: 'intermediate\n<|task:2|>' }, { type: 'tool-call', id: 't' }]);
    await step(1, 2);
    assert.equal(ctx.contexts[1].text({ session: s }), initial);
    assistant(1, 2, 'done\n<|task:1|>');
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.deepEqual(readHubTaskThread(hub, 1).slice(-2).map(rec => rec.content), ['ordinary follow-up', 'done']);
    assert.equal(readHubTaskThread(hub, 2).length, 1);
    emit('turn/start', { turn: 2 });
    await step(2, 1, 'another follow-up');
    assert.equal(ctx.contexts[1].text({ session: s }), initial);
    assistant(2, 1, 'wrong\n<|task:2|>');
    emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
    assert.equal(readSessionBinding(hub, s.id).task_id, 1);
    assert.equal(readHubTaskThread(hub, 2).length, 1);
    assert.equal(host.sessions.get(s.id).pendingSwitch.taskId, 2);
    assert.equal(host.sessions.get(s.id).explicitPin, true);
    emit('turn/start', { turn: 3 });
    await step(3, 1, 'Continue task #2');
    assert.match(ctx.contexts[1].text({ session: s }), /checkout sentinel 2/u);
    assistant(3, 1, 'resumed\n<|task:2|>');
    emit('turn/end', { turn: 3, reason: { kind: 'completed' } });
    assert.equal(readSessionBinding(hub, s.id).task_id, 2);
    assert.equal(readSessionBinding(hub, s.id).explicit_pin, false);
    assert.equal(routeCalls, 0);
    await ctx.handlers.get('session/flush')(s);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

function scopedSession(ctx, id) {
  const session = { id };
  const emit = (type, data) => ctx.handlers.get('session/event')(session, { type, surfaceOp: 'append', data });
  return {
    session, emit,
    start(turn, input, opts = {}) {
      emit('turn/start', { turn });
      return ctx.handlers.get('agent/pre-step')({
        session, turn, step: 1, signal: opts.signal, modelSelection: { provider: 'probe', model: opts.model ?? 'test' },
        messages: [{ source: { kind: opts.source ?? 'user' }, content: input }]
      }, async () => ({ kind: opts.reject ? 'reject' : 'enter' }));
    },
    end(turn, text, kind = 'completed') {
      emit('assistant/message', { turn, step: 1, message: { content: text } });
      emit('turn/end', { turn, reason: { kind } });
    },
    view: () => ctx.contexts[1].text({ session }),
    slash: rawInput => ctx.registeredCommands[0].handler({ rawInput, agent: { session } })
  };
}

test('native compaction gets the scoped boundary without mutating history, even with stream stripping off', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-native-boundary-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, stripMarkerInStream: false });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  for (const projectId of ['alpha', 'beta']) {
    upsertHubTask(hub, { id: projectId === 'alpha' ? 1 : 2, project_id: projectId });
    const opts = { scope: 'project', projectId };
    stageScopedOperators(hub, { ...opts, ops: [{ op: 'ASSERT', key: projectId + '_rule', option_code: 'yes', summary: 'rule' }] });
    commitScopedStaged(hub, opts);
  }
  await scopedSession(ctx, 'native').slash('checkout 1');
  const history = Object.freeze({ role: 'assistant', content: 'previous text' });
  const tail = Object.freeze({ role: 'user', content: Object.freeze([{ type: 'text', text: 'summarize' }, { type: 'image' }]) });
  const req = Object.freeze({ purpose: 'compaction', sessionId: 'native', messages: Object.freeze([history, tail]) });
  const patched = await ctx.handlers.get('llm/stream')(req, r => r);
  assert.equal(patched.messages[0], history);
  assert.equal(tail.content.length, 2);
  assert.match(JSON.stringify(patched.messages[1]), /alpha_rule/u);
  assert.doesNotMatch(JSON.stringify(patched.messages[1]), /beta_rule/u);
  assert.match(JSON.stringify(patched.messages[1]), /task.local|任务局部/u);
  const native = { ...req };
  ctx.handlers.get('llm/stream')(native, () => native);
  assert.match(JSON.stringify(native.messages[1]), /alpha_rule/u);
});

test('natural return routes before answering; unassigned, interrupted and failed extraction outcomes survive restart', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-resume-'));
  t.after(() => fs.rmSync(hub, { recursive: true, force: true }));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async req => ({ ok: true, content: req.system.startsWith('Route the opening')
      ? '{"decision":"match","task_id":2,"project_id":null}' : 'bad-json' }) } });
  try {
    upsertHubTask(hub, { id: 1, title: 'Login' });
    upsertHubTask(hub, { id: 2, title: 'CSV export' });
    const a = scopedSession(ctx, 'return');
    await a.slash('checkout 1');
    await a.start(1, 'Back to the CSV export issue from yesterday');
    assert.match(a.view(), /Required tail marker.*task:2/u);
    a.end(1, 'no marker');
    assert.equal(readSessionBinding(hub, 'return').task_id, 1);
    await a.start(2, '回到昨天的 CSV 导出问题');
    a.end(2, 'partial', 'interrupted');
    await a.start(3, '回到昨天的 CSV 导出问题');
    a.emit('tool/result', { turn: 3, message: { toolCallId: 'test', isError: true, content: 'FAIL csv-header' } });
    a.end(3, 'done\n<|task:2|>');
    await ctx.handlers.get('session/flush')(a.session);
    assert.equal(readHubTaskThread(hub, 2).length, 2);
    assert.match((await a.slash('checkout 2 --preview')).text, /FAIL csv-header/u);
  } finally { await host.dispose(); }
  const fresh = mockCtx();
  const restarted = await createHubDshHost(fresh, { storeRoot: hub, autopilot: { enabled: true } });
  try {
    const a = scopedSession(fresh, 'return');
    const report = async n => JSON.parse((await a.slash('turns ' + n)).text);
    assert.equal((await report(1)).reason, 'marker_missing');
    assert.equal((await report(2)).status, 'interrupted');
    assert.equal((await report(3)).extraction.user, 'strict_json_parse_failed');
    assert.doesNotMatch(JSON.stringify(await report(3)), /csv-header|bad-json/u);
  } finally { await restarted.dispose(); }
});

test('indirect competing-topic evidence asks the router; ambiguity never binds, creates or reuses the previous checkout', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-topic-'));
  const ctx = mockCtx();
  let calls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => {
    calls++; return { ok: true, content: '{"decision":"new","task_id":null}' };
  } } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'Login tokens' });
  upsertHubTask(hub, { id: 2, title: 'CSV export' });
  writeSessionBinding(hub, 'indirect', { task_id: 1, source: 'cold_router_match' });
  const a = scopedSession(ctx, 'indirect');
  await a.start(1, 'Where did we leave the CSV export work?');
  assert.equal(calls, 1);
  assert.match(a.view(), /UNRESOLVED/u);
  a.end(1, 'I guessed\n<|task:1|>');
  assert.equal(readHubTaskThread(hub, 1).length, 0);
  assert.equal(readHubTasksIndex(hub).tasks.length, 2);
});

test('an explicit cross-project preference inside a project is separately staged, without promoting project text', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-two-scopes-'));
  const ctx = mockCtx();
  const requests = [];
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async req => {
    const user = req.system.includes('User-scope extraction boundary');
    requests.push({ user, text: req.messages[0].content });
    return { ok: true, content: JSON.stringify({ ops: [{ op: 'ASSERT', key: user ? 'language' : 'test_runner', option_code: user ? 'zh' : 'pnpm', summary: 'rule' }] }) };
  } } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, project_id: 'alpha' });
  const a = scopedSession(ctx, 'scopes');
  await a.slash('checkout 1');
  await a.start(1, '以后所有项目都用中文汇报；这个仓库的测试用 pnpm。');
  a.end(1, '好的\n<|task:1|>');
  await ctx.handlers.get('session/flush')(a.session);
  const { readScopedStaged, readScopedHead } = await import('../src/kernel/hub-store.mjs');
  assert.deepEqual(readScopedStaged(hub).proposals.map(p => p.ops[0].key), ['language']);
  assert.equal(readScopedHead(hub).revision, 0);
  assert.doesNotMatch(requests.find(r => r.user).text, /pnpm/u);
  assert.deepEqual(readScopedStaged(hub, { scope: 'project', projectId: 'alpha' }).proposals.map(p => p.ops[0].key), ['test_runner']);
});

test('human recovery rereads only a verified completed markerless journal turn; no rebind or retroactive staging', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-claim-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: () => assert.fail('manual attribution must not call a model') } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  const a = scopedSession(ctx, 'lost-turn');
  for (const [id, project_id] of [[1,'a'], [2,'a'], [3,'b']]) upsertHubTask(hub, { id, project_id });
  await a.slash('checkout 1');
  await a.start(1, 'the original input');
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: 'the original input' } },
    { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: 'synthetic secret' } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: 'terminal answer' } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ].map((event, seq) => ({ seq, surfaceOp: 'append', ...event }));
  a.session.eventAt = n => events[n];
  for (const event of events) ctx.handlers.get('session/event')(a.session, event);
  assert.equal((await a.slash('recover 1 3')).kind, 'error');
  events[0].data.content = 'wrong journal';
  assert.equal((await a.slash('recover 1 2')).kind, 'error');
  events[0].data.content = 'the original input';
  assert.equal((await a.slash('recover 1 2')).kind, 'success');
  assert.equal((await a.slash('recover 1 2')).kind, 'success');
  assert.equal((await a.slash('recover 1 1')).kind, 'error');
  assert.deepEqual(readHubTaskThread(hub, 2).map(r => r.content), ['the original input', 'terminal answer']);
  assert.equal(readSessionBinding(hub, 'lost-turn').task_id, 1);
  assert.equal(JSON.parse((await a.slash('turns 1')).text).reason, 'manual_recovery');
});

test('Slice C dormant cross-project switch is opt-in, binds after confirmation, and old workers keep their scoped ledger', async () => {
  for (const crossProject of [false, true]) {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scope-cross-'));
    const ctx = mockCtx();
    const a = scopedSession(ctx, 'cross');
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    let oldStarted;
    const started = new Promise(resolve => { oldStarted = resolve; });
    let routes = 0;
    const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true, midSessionSwitch: { crossProject } }, llmClient: { complete: async request => {
      const text = request.messages[0].content;
      if (request.system.startsWith('Route the opening')) {
        routes++;
        return { ok: true, content: routes === 1 ? '{"decision":"new","task_id":null}' : '{"decision":"match","task_id":2,"project_id":"p_beta"}' };
      }
      const old = text.includes('older project input');
      if (old) { oldStarted(); await wait; }
      await ctx.handlers.get('session/flush')(a.session);
      return { ok: true, content: JSON.stringify({ ops: [{ op: 'ASSERT', key: old ? 'alpha' : 'beta', option_code: 'keep', summary: 'Test' }] }) };
    } } });
    try {
      upsertHubTask(hub, { id: 1, project_id: 'p_alpha', title: 'Alpha work' });
      appendHubTaskTurn(hub, { task_id: 1, project_id: 'p_alpha', content: 'Alpha private checkout' });
      upsertHubTask(hub, { id: 2, project_id: 'p_beta', title: 'Kafka migration' });
      appendHubTaskTurn(hub, { task_id: 2, project_id: 'p_beta', content: 'Beta private checkout', timestamp: '2000-01-01T00:00:00Z' });
      await a.slash('checkout 1');
      await a.start(1, 'older project input');
      a.end(1, 'first\n<|task:1|>');
      await started;
      await a.start(2, 'Switch to Kafka migration');
      assert.equal(routes, 2);
      assert.doesNotMatch(a.view(), /Alpha private checkout/u);
      assert.equal(readSessionBinding(hub, 'cross').task_id, 1);
      if (crossProject) assert.match(a.view(), /Beta private checkout/u);
      else assert.doesNotMatch(a.view(), /Beta private checkout/u);
      a.end(2, 'switch answer\n<|task:2|>');
      release();
      await ctx.handlers.get('session/flush')(a.session);
      assert.equal(readSessionBinding(hub, 'cross').task_id, crossProject ? 2 : 1);
      assert.equal(readHubTaskThread(hub, 2).length, crossProject ? 3 : 1);
      assert.equal(readHubTasksIndex(hub).tasks[1].last_activity_at !== '2000-01-01T00:00:00Z', crossProject);
      const { readScopedStaged } = await import('../src/kernel/hub-store.mjs');
      assert.deepEqual(readScopedStaged(hub, { scope: 'project', projectId: 'p_alpha' }).proposals.map(p => p.ops[0].key), ['alpha']);
      assert.deepEqual(readScopedStaged(hub, { scope: 'project', projectId: 'p_beta' }).proposals.map(p => p.ops[0].key), crossProject ? ['beta'] : []);
    } finally { release(); await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
  }
});

test('Slice C rejects a competing new-task ticket, wrong new marker, aborted/rejected turns, and synthetic-only inputs', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scope-ticket-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
  try {
    const a = scopedSession(ctx, 'ticket-a');
    const b = scopedSession(ctx, 'ticket-b');
    const c = scopedSession(ctx, 'ticket-c');
    await c.start(1, 'synthetic', { source: 'runtime-context' }); c.end(1, 'fake\n<|task:1|>');
    await c.start(2, 'rejected', { reject: true }); c.end(2, 'fake\n<|task:1|>');
    const ctl = new AbortController();
    await c.start(3, 'cancelled', { signal: ctl.signal }); ctl.abort(); c.end(3, 'fake\n<|task:1|>', 'aborted');
    await c.start(4, 'wrong ticket'); c.end(4, 'fake\n<|task:7|>');
    assert.equal(readHubTasksIndex(hub).tasks.length, 0);
    assert.equal(readSessionBinding(hub, 'ticket-c'), null);
    await Promise.all([a.start(1, 'winner'), b.start(1, 'loser')]);
    assert.match(a.view(), /Required tail marker.*<\|task:1\|>/u);
    assert.match(b.view(), /Required tail marker.*<\|task:1\|>/u);
    a.end(1, 'won\n<|task:1|>');
    b.end(1, 'lost\n<|task:1|>');
    assert.equal(readSessionBinding(hub, 'ticket-b'), null);
    assert.deepEqual(readHubTaskThread(hub, 1).map(rec => rec.content), ['winner', 'won']);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Slice C refreshes ledger revisions without recompiling checkout, rejects ABA epoch, and repairs a half-written confirmed turn', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scope-epoch-'));
  const ctx = mockCtx();
  let calls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => { calls++; return { ok: true, content: '{"ops":[]}' }; } } });
  try {
    const a = scopedSession(ctx, 'epoch');
    const b = scopedSession(ctx, 'aba');
    upsertHubTask(hub, { id: 1, title: 'General task' });
    appendHubTaskTurn(hub, { task_id: 1, turn: 1, role: 'user', content: 'half', meta: { dsh_session_id: 'epoch' } });
    await a.slash('checkout 1');
    await a.start(1, 'half');
    a.end(1, 'finished\n<|task:1|>');
    await ctx.handlers.get('session/flush')(a.session);
    assert.equal(calls, 1);
    assert.deepEqual(readHubTaskThread(hub, 1).map(rec => rec.content), ['half', 'finished']);
    const { proposal } = stageScopedOperators(hub, { ops: [{ op: 'ASSERT', key: 'policy', option_code: 'new', summary: 'Authority revision sentinel' }] });
    commitScopedStaged(hub, { proposal_id: proposal.proposal_id });
    await a.start(2, 'follow-up');
    assert.match(a.view(), /Authority revision sentinel/u);
    assert.doesNotMatch(a.view(), /finished|Current Project Ledger/u);
    await b.start(1, 'Continue task #1');
    await b.slash('checkout 1');
    await b.slash('checkout --clear');
    b.end(1, 'intervened\n<|task:1|>');
    assert.equal(readSessionBinding(hub, 'aba'), null);
    assert.equal(readHubTaskThread(hub, 1).length, 2);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Slice C hides a split stream marker, scopes it to its turn/step, and never touches worker chunks', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scope-stream-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
  try {
    const a = scopedSession(ctx, 'stream');
    const ctl = new AbortController();
    await a.start(1, 'authored\n<system-reminder>do not archive</system-reminder>', { signal: ctl.signal });
    const next = async function* () {
      yield { type: 'text-delta', index: 0, text: 'Done\n<|ta' };
      yield { type: 'text-delta', index: 0, text: 'sk:1|>' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done\n<|task:1|>' } };
    };
    const collect = async purpose => {
      const chunks = [];
      for await (const chunk of ctx.handlers.get('llm/stream')({ sessionId: 'stream', purpose, signal: ctl.signal }, next)) chunks.push(chunk);
      return chunks;
    };
    assert.match((await collect('cairn-worker')).at(-1).block.text, /<\|task:1\|>/u);
    assert.equal((await collect(undefined)).at(-1).block.text, 'Done');
    a.end(1, 'Done');
    assert.deepEqual(readHubTaskThread(hub, 1).map(rec => rec.content), ['authored', 'Done']);
    await a.start(2, 'marker absent', { signal: ctl.signal });
    a.end(2, 'Done');
    assert.equal(readHubTaskThread(hub, 1).length, 2);
  } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
});

test('Slice C honors both off switches even with crossProject enabled', async () => {
  for (const autopilot of [{ enabled: false, midSessionSwitch: { crossProject: true } },
    { enabled: true, midSessionSwitch: { enabled: false, crossProject: true } }]) {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scope-disabled-'));
    const ctx = mockCtx();
    const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot, llmClient: { complete: async () => assert.fail('off must not route bound session') } });
    try {
      upsertHubTask(hub, { id: 1, project_id: 'p_a' });
      upsertHubTask(hub, { id: 2, project_id: 'p_b' });
      const a = scopedSession(ctx, 'disabled');
      await a.slash('checkout 1');
      await a.start(1, 'Continue task #2');
      assert.doesNotMatch(a.view(), /project_id="p_b"/u);
      assert.equal(readSessionBinding(hub, 'disabled').task_id, 1);
      const request = { sessionId: 'disabled', messages: [] };
      assert.equal(ctx.handlers.get('llm/stream')(request, r => r), request, 'no answer-stream interception when switching is off');
    } finally { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); }
  }
});

test('Hub budgets its catalog and routes only the current authored input; dormant checkout mounts in the wake turn', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-heat-'));
  const ctx = mockCtx();
  const calls = [];
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true, taskHeat: { hotMaxTasks: 1 }, midSessionSwitch: { enabled: false } },
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
    storeRoot: hub, autopilot: { enabled: true, midSessionSwitch: { enabled: false } },
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
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true, midSessionSwitch: { enabled: false } }, llmClient: { complete: async () => ({ ok: true, content: JSON.stringify(result) }) } });
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
