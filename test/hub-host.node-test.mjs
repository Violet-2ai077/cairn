import '../scripts/fixtures/zh-test-locale.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('Hub slash rejects ambiguous writes and invalid lifecycle input without mutation', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-slash-'));
  const ctx = mockCtx(), host = await createHubDshHost(ctx, { storeRoot: hub });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  const s = scopedSession(ctx, 'slash');
  upsertHubTask(hub, { id: 1 });
  stageScopedOperators(hub, { ops: [{ op: 'ASSERT', key: 'tool', option_code: 'one', summary: 'Use one' }] });
  for (const command of ['commit proj', 'drop proj', 'close abc', 'archive 1', 'close 1 extra', 'unknown', 'commit user stg_999']) {
    assert.equal((await s.slash(command)).kind, 'error', command);
  }
  assert.equal(readScopedLedgerLog(hub).length, 0);
  assert.equal(readHubTasksIndex(hub).tasks[0].status, 'active');
  assert.equal((await s.slash('commit user')).kind, 'success');
  assert.equal(readScopedLedgerLog(hub).length, 1);
});

test('Hub marker stripping keeps full-answer provenance and identical deltas in both runtimes', async t => {
  for (const autopilot of [undefined, { enabled: true }]) {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-marker-'));
    const ctx = mockCtx();
    const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot, llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
    t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
    const s = scopedSession(ctx, 'marker'), signal = new AbortController().signal;
    await s.start(1, 'Write an answer', { signal });
    s.emit('user/message', { turn: 1, message: { source: { kind: 'user' }, content: 'Write an answer' } });
    async function* reply() {
      for (const [index, text] of ['Wrap code in ``` fences.', '  ' + 'x'.repeat(80) + ' '.repeat(90) + '\n<|task:1|>' + ' '.repeat(65)].entries()) {
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text };
        yield { type: 'block-end', index, block: { type: 'text', text } };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const chunks = await Array.fromAsync(ctx.handlers.get('llm/stream')({ sessionId: 'marker', signal }, reply));
    const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block);
    assert.equal(blocks[1].text, '  ' + 'x'.repeat(80));
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), blocks.map(b => b.text).join(''));
    s.end(1, blocks);
    assert.equal(readHubTaskThread(hub, 1).at(-1)?.content, 'Wrap code in ``` fences.\n  ' + 'x'.repeat(80));
  }
});

test('selection can leave a full menu without taking action on the old request', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-exit-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => ({ ok: true, content: '{"decision":"new","task_id":null}' }) } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'Old task' });
  const s = scopedSession(ctx, 'exit');
  await s.start(1, '继续'); s.end(1, '请选择');
  await s.start(2, '都不是'); s.end(2, '请描述其他任务');
  assert.equal(readSessionBinding(hub, 'exit'), null);
  await s.start(3, '另开一个任务：整理发布记录');
  assert.match(s.view(), /Required tail marker.*<\|task:2\|>/u);
});

test('a compatibility Hub cannot create a task on an unresolved continuation', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-continue-compat-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub,
    llmClient: { complete: async () => ({ ok: true, content: '{"decision":"new","task_id":null}' }) } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  initHubStore(hub);
  const s = scopedSession(ctx, 'continuation');
  for (const turn of [1, 2]) {
    if (turn === 2) upsertHubTask(hub, { id: 1, title: 'Something unrelated' });
    await s.start(turn, 'Continue the export');
    assert.match(s.view(), /路由尚未确认/u);
    s.emit('user/message', { turn, message: { source: { kind: 'user' }, content: 'Continue the export' } });
    s.end(turn, 'Wrong creation\n<|task:2|>');
    assert.ok(!readHubTasksIndex(hub).tasks.some(task => task.id === 2));
  }
});

test('an independent checkout distinguishes observed results from accepted turns before and after interruption', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-handoff-'));
  const ctx = mockCtx(), s = scopedSession(ctx, 'writer');
  let workerCalls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => { workerCalls++; return { ok: true, content: '{"ops":[]}' }; } } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'Export', project_id: 'p' });
  upsertHubTask(hub, { id: 2, title: 'Other' });
  for (const opts of [{}, { scope: 'project', projectId: 'p' }]) {
    const { proposal } = stageScopedOperators(hub, { ...opts, ops: [{ op: 'ASSERT', key: 'runner', option_code: opts.scope ? 'project_rule' : 'user_rule', summary: 'Runner choice' }] });
    assert.equal(commitScopedStaged(hub, { ...opts, proposal_id: proposal.proposal_id }).committed, true);
  }
  const cli = (id = 1, json = true) => execFileSync(process.execPath, [
    fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url)), 'checkout', String(id), '--store', hub, '--preview', ...(json ? ['--json'] : [])
  ], { encoding: 'utf8' });
  const view = () => JSON.parse(cli()).work_state;
  const send = (type, seq, data) => ctx.handlers.get('session/event')(s.session, { type, seq, surfaceOp: 'append', data });
  const result = (turn, seq, content) => send('tool/result', seq, { turn, step: 1, message: { toolCallId: 'c', content, isError: true } });
  await s.slash('checkout 1');
  await s.start(1, 'check the export');
  send('tool/call', 10, { turn: 1, step: 1, callId: 'c', toolName: 'probe_csv' });
  result(1, 12, 'HEADER_MISSING');
  result(1, 11, 'older');
  result(1, 12, 'conflicting replay');
  const live = view();
  assert.deepEqual(view(), live);
  assert.equal(live.pending_turns.length, 1);
  const pending = live.pending_turns[0];
  assert.equal(pending.turn_status, 'in_progress');
  assert.equal(pending.disposition, 'verify_before_retry');
  assert.equal(pending.request_excerpt, 'check the export');
  assert.deepEqual(pending.last_tool, { name: 'probe_csv', ok: false, output: 'HEADER_MISSING', call_id: 'c' });
  assert.deepEqual(pending.source, { host: 'dsh', session_id: 'writer', turn: 1, step: 1, journal_seq: 12 });
  assert.equal(live.authority.user.active[0].option_code, 'user_rule');
  assert.equal(live.authority.project.active[0].option_code, 'project_rule');
  assert.equal(live.last_filed_tool, null);
  assert.doesNotMatch(cli(2), /HEADER_MISSING|project_rule/u);
  s.end(1, 'incomplete', 'interrupted');
  assert.equal(view().pending_turns[0].turn_status, 'interrupted');
  assert.equal(view().task.status, 'active');
  assert.equal(readHubTaskThread(hub, 1).length, 0);
  assert.equal(workerCalls, 0);
  assert.match(cli(1, false), /HEADER_MISSING/u);
  await s.start(2, 'inspect only');
  assert.match(s.view(), /HEADER_MISSING/u);
  result(2, 17, 'verified separately');
  s.end(2, 'checked\n<|task:1|>');
  assert.deepEqual(view().pending_turns.map(row => row.source.turn), [1]);
  assert.equal(view().last_filed_tool.journal_seq, 17);
  assert.equal(view().last_filed_tool.output, 'verified separately');
  assert.equal(readHubTaskThread(hub, 1).at(-1).meta.tools[0].output, 'verified separately');
  await s.start(3, 'another check');
  await s.slash('checkout 2');
  result(3, 25, 'late result after rebind');
  assert.doesNotMatch(cli(1) + cli(2), /late result after rebind/u);
});

test('operator tool timeline survives a lost result, excerpt eviction, restart and archive without persisting output or arguments', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-call-facts-'));
  const config = { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } };
  let ctx = mockCtx(), host = await createHubDshHost(ctx, config), s = scopedSession(ctx, 'timeline');
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'Bound' });
  upsertHubTask(hub, { id: 2, title: 'Other' });
  await s.slash('checkout 1');
  const cli = id => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url)),
    'tool-calls', String(id), '--store', hub, '--json'], { encoding: 'utf8' }));
  const send = (type, seq, data, surfaceOp, extra) => ctx.handlers.get('session/event')(s.session, { type, seq, surfaceOp, data, ...extra });
  const call = (turn, seq, id, surfaceOp) => send('tool/call', seq, { turn, step: 1, callId: id, name: 'probe', args: { password: 'argument-sentinel' } }, surfaceOp);
  const result = (turn, seq, id, ok, linked) => send('tool/result', seq, { turn, step: 1, message: { toolCallId: id,
    isError: !ok, content: 'API_KEY=output-sentinel' } }, 'append', { sourceEventSeqs: [linked] });
  await s.start(1, 'inspect');
  for (let i = 0; i < 36; i++) {
    call(1, 10 + 2 * i, 'call-' + i);
    if (i !== 1) result(1, 11 + 2 * i, 'call-' + i, i !== 2, 10 + 2 * i);
  }
  call(1, 90, 'replacement', 'replace');
  const before = cli(1);
  assert.equal(before.turns[0].calls.length, 36);
  assert.equal(before.turns[0].calls[1].result_status, 'unknown');
  assert.equal(before.turns[0].calls[2].results[0].ok, false);
  assert.equal(before.turns[0].calls[35].results[0].ok, true);
  assert.equal(before.turns[0].unmatched_results.length, 0);
  assert.doesNotMatch(JSON.stringify(before), /argument-sentinel|output-sentinel|replacement/);
  const pages = path.join(hub, 'tasks', '1', 'tool-timeline');
  for (const file of fs.readdirSync(pages)) assert.doesNotMatch(fs.readFileSync(path.join(pages, file), 'utf8'), /argument-sentinel|output-sentinel|API_KEY|password/);
  s.end(1, 'unfinished', 'interrupted');
  await host.dispose();
  ctx = mockCtx(); host = await createHubDshHost(ctx, config); s = scopedSession(ctx, 'timeline');
  assert.deepEqual(cli(1), before);
  await s.start(2, 'check again');
  call(2, 96, 'final');
  result(2, 97, undefined, true, 96);
  s.end(2, 'filed\n<|task:1|>');
  assert.equal(cli(1).turns[1].calls[0].results[0].journal_seq, 97);
  await s.start(3, 'check');
  await s.slash('checkout 2');
  call(3, 101, 'late-after-checkout');
  assert.equal(cli(1).turns.length, 2);
  assert.equal(cli(2).turns.length, 0);
});

test('peer writes during a frozen turn are visible at the next authored turn', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-peer-')), ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'Shared' });
  const a = scopedSession(ctx, 'a'), b = scopedSession(ctx, 'b');
  await a.slash('checkout 1'); await b.slash('checkout 1');
  await a.start(1, 'look'); const frozen = a.view();
  await b.start(1, 'peer request'); b.end(1, 'external sentinel\n<|task:1|>');
  assert.equal(a.view(), frozen);
  a.end(1, 'mine\n<|task:1|>');
  await a.start(2, 'next');
  assert.match(a.view(), /external sentinel/u);
});

test('provisional routing and replacement events cannot file evidence; a peer sees only an appended bound result', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-observation-scope-')), ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'Shared' });
  const writer = scopedSession(ctx, 'writer'), peer = scopedSession(ctx, 'peer');
  const observe = (turn, seq, content, surfaceOp = 'append') => ctx.handlers.get('session/event')(writer.session,
    { type: 'tool/result', seq, surfaceOp, data: { turn, step: 1, message: { name: 'probe', content } } });
  await writer.start(1, 'Continue task #1');
  observe(1, 4, 'unbound result');
  writer.end(1, 'unconfirmed', 'interrupted');
  await peer.slash('checkout 1');
  await peer.start(1, 'inspect');
  const frozen = peer.view();
  assert.doesNotMatch(frozen, /unbound result/u);
  await writer.slash('checkout 1');
  await writer.start(2, 'inspect');
  observe(2, 7, 'bound result');
  observe(2, 8, 'replacement text', { op: 'replace', startSeq: 7, endSeq: 7 });
  assert.equal(peer.view(), frozen);
  writer.end(2, 'wrong target\n<|task:2|>');
  peer.end(1, 'read\n<|task:1|>');
  await peer.start(2, 'inspect again');
  assert.match(peer.view(), /"turn_status":"unassigned"/u);
  assert.match(peer.view(), /"output":"bound result"/u);
  assert.doesNotMatch(peer.view(), /unbound result|replacement text/u);
  assert.equal(readHubTaskThread(hub, 1).length, 2);
});

test('native task picker pauses an unbound generic continue and mounts the human choice in the same request', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-'));
  const ctx = mockCtx();
  let resolveAnswer;
  const asked = Promise.withResolvers();
  ctx.get = key => key === 'userQuestions' ? { ask(req) {
    asked.resolve(req);
    return new Promise(resolve => { resolveAnswer = resolve; });
  } } : ctx[key];
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 4, title: 'Login tokens' });
  upsertHubTask(hub, { id: 9, title: 'CSV export' });
  appendHubTaskTurn(hub, { task_id: 9, content: 'private transcript',
    meta: { tools: [{ name: 'csv_header_test', ok: false, output: 'private error log' }] } });
  const session = { id: 'native-picker' }, agent = { session };
  const input = '继续，把失败的测试修掉';
  const step = ctx.handlers.get('agent/pre-step')({ agent, turn: 1, step: 1,
    messages: [{ source: { kind: 'user' }, content: input }] }, async () => ({ kind: 'enter' }));
  const req = await Promise.race([asked.promise, step.then(() => null)]);
  assert.ok(req, 'must wait for the human before entering the first answer step');
  assert.equal(req.agent, agent);
  assert.equal(readSessionBinding(hub, session.id), null);
  const q = req.questions[0];
  const option = q.options.find(o => o.label.includes('CSV export'));
  assert.match(option.description, /csv_header_test 失败/u);
  assert.doesNotMatch(JSON.stringify(q), /private/u);
  resolveAnswer({ answers: [{ id: q.id, selected: [option.label] }] });
  await step;
  assert.match(ctx.contexts[1].text({ session }), /Required tail marker.*task:9/u);
  const s = scopedSession(ctx, session.id);
  s.end(1, 'verified\n<|task:9|>');
  assert.equal(readHubTaskThread(hub, 9).at(-2).content, input);
});

test('text picker skips provider and business tools, survives restart, and archives the original request, not the menu reply', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-text-'));
  t.after(() => fs.rmSync(hub, { recursive: true, force: true }));
  upsertHubTask(hub, { id: 4, title: 'Login tokens' });
  upsertHubTask(hub, { id: 9, title: 'CSV export' });
  const config = { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } };
  const ctx = mockCtx(), s = scopedSession(ctx, 'picker');
  const host = await createHubDshHost(ctx, config);
  const input = '继续，把失败的测试修掉';
  try {
    await s.start(1, input);
    const stream = ctx.handlers.get('llm/stream')({ sessionId: 'picker' }, () => assert.fail('not a provider request'));
    const chunks = await Array.fromAsync(stream);
    const menu = chunks.find(c => c.type === 'block-end').block.text;
    assert.match(menu, /CSV export/u);
    assert.match(menu, /Login tokens/u);
    s.end(1, menu);
    assert.equal(readHubTaskThread(hub, 9).length, 0);
  } finally { await host.dispose(); }
  const fresh = mockCtx(), r = scopedSession(fresh, 'picker');
  const restarted = await createHubDshHost(fresh, config);
  try {
    await r.start(2, 'CSV 那个');
    assert.match(r.view(), /Required tail marker.*task:9/u);
    assert.ok(r.view().includes(input));
    r.end(2, 'regression fixed\n<|task:9|>');
    assert.deepEqual(readHubTaskThread(hub, 9).map(x => x.content), [input, 'regression fixed']);
    await r.start(3, 'what next?');
    assert.doesNotMatch(r.view(), /cairn_resume_request/u);
  } finally { await restarted.dispose(); }
});

test('selector never renumbers a withdrawn option; invalid, cancelled and empty menus cannot create a task', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-stale-'));
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true },
    llmClient: { complete: async () => assert.fail('generic continue and menu controls are deterministic') } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  const s = scopedSession(ctx, 'stale');
  async function reply(turn, input) {
    await s.start(turn, input);
    const stream = ctx.handlers.get('llm/stream')({ sessionId: 'stale' }, () => assert.fail('no answer model'));
    const text = (await Array.fromAsync(stream)).find(c => c.type === 'block-end').block.text;
    s.end(turn, text);
    return text;
  }
  assert.match(await reply(1, '继续'), /没有可继续/u);
  upsertHubTask(hub, { id: 12, title: 'Only task' });
  assert.match(await reply(2, '继续上次的任务？'), /Only task/u);
  upsertHubTask(hub, { id: 13, title: 'Later task' });
  transitionHubTaskStatus(hub, { taskId: 12, action: 'close' });
  assert.match(await reply(3, '1'), /已不可选/u);
  assert.doesNotMatch(await reply(4, '#13'), /Later task/u);
  assert.match(await reply(5, '取消'), /已取消/u);
  assert.equal(readSessionBinding(hub, 'stale'), null);
  assert.equal(readHubTasksIndex(hub).tasks.length, 2);
  assert.equal(readHubTaskThread(hub, 13).length, 0);
});

test('interrupting the original text menu drops the outstanding request', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-stop-'));
  const ctx = mockCtx(), s = scopedSession(ctx, 'stop');
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, title: 'CSV' });
  await s.start(1, '继续');
  s.end(1, 'partial menu', 'interrupted');
  await s.start(2, '继续');
  const stream = ctx.handlers.get('llm/stream')({ sessionId: 'stop' }, () => assert.fail('no model'));
  const menu = (await Array.fromAsync(stream)).find(c => c.type === 'block-end').block.text;
  assert.match(menu, /CSV/u);
  assert.doesNotMatch(menu, /未能唯一/u);
});

test('native picker ignores a late answer after abort even if the answerer ignores the signal', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-abort-'));
  const ctx = mockCtx(), opened = Promise.withResolvers(), answer = Promise.withResolvers();
  ctx.get = k => k === 'userQuestions' ? { ask(q) { opened.resolve(q); return answer.promise; } } : ctx[k];
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 7, title: 'CSV' });
  const ctl = new AbortController(), session = { id: 'cancel-native' };
  const pending = ctx.handlers.get('agent/pre-step')({ turn: 1, step: 1, signal: ctl.signal, agent: { session },
    messages: [{ source: { kind: 'user' }, content: '继续' }] }, async () => ({ kind: 'enter' }));
  const { questions: [q] } = await opened.promise;
  ctl.abort();
  const outcome = await Promise.race([pending.then(() => 'entered', () => 'aborted'), new Promise(resolve => setImmediate(() => resolve('still waiting')))]);
  answer.resolve({ answers: [{ id: q.id, selected: [q.options[0].label] }] });
  assert.equal(outcome, 'aborted');
  assert.equal(readSessionBinding(hub, session.id), null);
});

test('router ambiguity offers validated candidates only; more pages, project restrictions and duplicate names stay deterministic', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-pages-'));
  const ctx = mockCtx(), s = scopedSession(ctx, 'pages');
  let routes = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true, taskHeat: { enabled: false } },
    llmClient: { complete: async req => {
      if (!req.system.startsWith('Route the opening')) return { ok: true, content: '{"ops":[]}' };
      routes++;
      return { ok: true, content: '{"decision":"ambiguous","task_id":null,"candidates":[2,3,8]}' };
    } } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  for (let id = 1; id <= 8; id++) upsertHubTask(hub, { id, project_id: id === 8 ? 'other' : 'here',
    title: id === 8 ? 'Foreign topic' : id === 2 || id === 3 ? 'CSV export' : 'Task ' + id });
  await s.slash('checkout 1');
  async function menu(turn, input) {
    await s.start(turn, input);
    const chunks = await Array.fromAsync(ctx.handlers.get('llm/stream')({ sessionId: 'pages' }, () => assert.fail('picker leaked to provider')));
    const text = chunks.find(c => c.type === 'block-end').block.text;
    s.end(turn, text);
    return text;
  }
  const initial = await menu(1, '切换到导出工作，核实失败的测试');
  assert.doesNotMatch(initial, /Foreign topic|Task 1/u);
  assert.match(initial, /CSV export \(#2\)/u);
  assert.match(await menu(2, 'CSV 那个'), /未能唯一/u);
  assert.doesNotMatch(await menu(3, '都不是'), /Foreign topic/u);
  assert.match(await menu(4, '更多'), /Task 7/u);
  await s.start(5, '#7');
  assert.match(s.view(), /Required tail marker.*task:7/u);
  transitionHubTaskStatus(hub, { taskId: 7, action: 'close' });
  const refused = await Array.fromAsync(ctx.handlers.get('llm/stream')({ sessionId: 'pages' }, () => assert.fail('withdrawn choice')));
  s.end(5, refused.find(c => c.type === 'block-end').block.text);
  assert.equal(JSON.parse((await s.slash('turns 5')).text).reason, 'choice_stale');
  assert.equal(readSessionBinding(hub, 'pages').task_id, 1);
  assert.equal(routes, 1);
});

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

test('memory intake separates temporary, ambiguous and mixed scopes without extracting examples', async () => {
  const { splitMemoryIntent } = await import('../src/workers/memory-intent.mjs');
  const parse = text => splitMemoryIntent(text, 'alpha');
  assert.deepEqual(parse('这次用英文。'), { cards: [], remaining: '', filtered: true });
  assert.deepEqual(parse('以后默认用中文。').cards, [{ quote: '以后默认用中文', scopes: ['user', 'project'] }]);
  assert.deepEqual(parse('所有项目默认中文，但这个项目用英文。').cards, [
    { quote: '所有项目默认中文', scopes: ['user'] }, { quote: '这个项目用英文', scopes: ['project'] }
  ]);
  assert.equal(parse('所有项目默认中文，这次用英文。').cards.length, 1);
  assert.deepEqual(parse('For all projects, reply in Chinese, but for this project, reply in English.').cards.map(c => c.scopes),
    [['user'], ['project']]);
  assert.deepEqual(parse('查一下所有项目的测试状态。修完以后跑测试。').cards, []);
  assert.deepEqual(parse('这次，回复用英文。'), { cards: [], remaining: '', filtered: true });
  for (const hypothetical of ['如果以后默认中文，会怎样？', '例如：“所有项目默认中文”。', '> 所有项目默认中文']) {
    assert.deepEqual(parse(hypothetical).cards, []);
  }
});

test('the preference worker cannot invent an option, write multiple facts, choose a scope or supersede a rule', async () => {
  const { draftPreference } = await import('../src/workers/memory-intent.mjs');
  const clause = { quote: '以后默认用中文' };
  const draft = ops => draftPreference({ complete: async () => ({ ok: true, content: JSON.stringify({ ops }) }) }, clause);
  const op = { op: 'ASSERT', key: 'reply_language', option_code: 'zh' };
  for (const ops of [[{ ...op, option_code: 'en' }], [op, op], [{ ...op, id: 'D9' }],
    [{ ...op, scope: 'user' }], [{ ...op, op: 'SUPERSEDE' }]]) assert.equal(await draft(ops), null);
  assert.deepEqual(await draft([{ ...op, summary: 'untrusted paraphrase' }]), { ...op, summary: clause.quote });
});

test('an ambiguous preference never enters either ledger before its scoped human reply, including skip, failure and stale revision', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-memory-ask-'));
  const ctx = mockCtx(), s = scopedSession(ctx, 'scope-question');
  const { readScopedHead, readScopedStaged } = await import('../src/kernel/hub-store.mjs');
  let fail = false;
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async () =>
    fail ? { ok: false } : { ok: true, content: '{"ops":[{"op":"ASSERT","key":"reply_language","option_code":"zh"}]}' } } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 1, project_id: 'alpha' });
  upsertHubTask(hub, { id: 2, project_id: 'beta' });
  await s.slash('checkout 1');
  const project = { scope: 'project', projectId: 'alpha' };
  const offer = async turn => {
    await s.start(turn, '以后默认用中文。');
    s.end(turn, 'current answer\n<|task:1|>');
    await ctx.handlers.get('session/flush')(s.session);
  };
  await offer(1);
  assert.match((await s.slash('memory 1.1')).text, /仅本项目 \/ 所有项目；待确认/u);
  assert.equal(readScopedStaged(hub).proposals.length + readScopedStaged(hub, project).proposals.length, 0);
  await s.slash('checkout 2');
  assert.equal((await s.slash('memory 1.1 project')).kind, 'error');
  assert.match((await s.slash('memory 1.1 skip')).text, /已跳过/u);
  await s.slash('checkout 1');
  await offer(2);
  await s.start(3, '仅本项目');
  const stream = ctx.handlers.get('llm/stream')({ sessionId: s.session.id }, () => assert.fail('do not ask again'));
  const reply = (await Array.fromAsync(stream)).find(c => c.type === 'block-end').block.text;
  assert.match(reply, /已生效/u);
  s.end(3, reply);
  assert.equal(readScopedHead(hub, project).active[0].option_code, 'zh');
  assert.equal(readScopedHead(hub).revision, 0);
  await offer(4);
  stageScopedOperators(hub, { ops: [{ op:'ASSERT', key:'format', option_code:'plain', summary:'plain' }] });
  commitScopedStaged(hub);
  assert.match((await s.slash('memory 4.1 user')).text, /未覆盖/u);
  assert.equal(readScopedHead(hub).revision, 1);
  fail = true;
  await offer(5);
  assert.match((await s.slash('memory 5.1 user')).text, /提取失败，未保存/u);
  assert.equal(readScopedHead(hub).revision, 1);
});

test('an explicit cross-project preference inside a project is separately staged, without promoting project text', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-two-scopes-'));
  const ctx = mockCtx();
  const requests = [];
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async req => {
    const user = req.system.startsWith('Prepare one non-authoritative preference');
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

test('memory feedback follows the business answer; project exception and user default require distinct human receipts', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-memory-'));
  const { readScopedHead } = await import('../src/kernel/hub-store.mjs');
  const { readMemoryReview } = await import('../src/kernel/memory-review.mjs');
  t.after(() => fs.rmSync(hub, { recursive: true, force: true }));
  const requests = [];
  const config = { storeRoot: hub, autopilot: { enabled: true }, llmClient: { complete: async req => {
    requests.push(req.messages[0].content);
    return { ok: true, content: JSON.stringify({ ops: [{ op: 'ASSERT', key: 'reply_language',
      option_code: req.messages[0].content.includes('英文') ? 'en' : 'zh', summary: 'not authoritative' }] }) };
  } } };
  const ctx = mockCtx(), s = scopedSession(ctx, 'remember');
  const host = await createHubDshHost(ctx, config);
  const project = { scope: 'project', projectId: 'alpha' };
  const answer = async (turn, input) => {
    await s.start(turn, input);
    const text = 'business completed\n<|task:1|>';
    const stream = ctx.handlers.get('llm/stream')({ sessionId: s.session.id }, async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const display = (await Array.fromAsync(stream)).find(c => c.type === 'block-end').block.text;
    s.end(turn, display);
    await ctx.handlers.get('session/flush')(s.session);
    return display;
  };
  try {
    upsertHubTask(hub, { id: 1, project_id: 'alpha' });
    upsertHubTask(hub, { id: 2, project_id: 'beta' });
    await s.slash('checkout 1');
    assert.equal(await answer(1, '这次用英文。'), 'business completed');
    assert.equal(requests.length, 0);
    const notice = await answer(2, '所有项目默认中文，但这个项目用英文。');
    assert.match(notice, /^business completed[\s\S]*2\.1「所有项目默认中文」：所有项目[\s\S]*2\.2「这个项目用英文」：仅本项目/u);
    assert.deepEqual(requests.map(x => JSON.parse(x)), ['所有项目默认中文', '这个项目用英文']);
    assert.equal(readHubTaskThread(hub, 1).at(-1).content, 'business completed');
    assert.equal(readScopedHead(hub).revision, 0);
    assert.equal(readScopedHead(hub, project).revision, 0);
    await s.slash('commit user');
    assert.equal(readScopedHead(hub).revision, 0, 'bulk commit must not bypass an item-specific review');
    assert.equal((await s.slash('memory 2.1 project')).kind, 'error');
  } finally { await host.dispose(); }
  const fresh = mockCtx(), r = scopedSession(fresh, 'remember');
  const restarted = await createHubDshHost(fresh, config);
  try {
    assert.match((await r.slash('memory')).text, /reply_language=zh/u);
    assert.equal((await scopedSession(fresh, 'different').slash('memory 2.1 user')).kind, 'error');
    await r.start(3, '记忆 2.1 所有项目');
    const stream = fresh.handlers.get('llm/stream')({ sessionId: r.session.id }, () => assert.fail('no model for a memory reply'));
    const display = (await Array.fromAsync(stream)).find(c => c.type === 'block-end').block.text;
    assert.match(display, /已生效/u);
    r.end(3, display);
    assert.equal(readScopedHead(hub).active[0].summary, '所有项目默认中文');
    assert.equal(readScopedHead(hub, project).revision, 0);
    assert.match((await r.slash('memory 2.1 user')).text, /已生效/u);
    assert.equal(readScopedHead(hub).revision, 1);
    assert.match((await r.slash('memory 2.2 project')).text, /已生效/u);
    assert.equal(readScopedHead(hub, project).active[0].option_code, 'en');
    await r.slash('checkout 2');
    await r.start(4, 'do work');
    assert.match(r.view(), /所有项目默认中文/u);
    assert.doesNotMatch(r.view(), /这个项目用英文/u);
    r.end(4, 'done\n<|task:2|>');
    assert.equal(readMemoryReview(hub, r.session.id, '2.2').status, 'committed');
  } finally { await restarted.dispose(); }
});

test('the memory notice waits for a terminal stop, preserves usage and the archived multi-block answer with visible markers', async () => {
  const { hideHubStreamMarker } = await import('../src/hosts/dsh/hub-turn-runtime.mjs');
  for (const reason of ['stop', 'tool-calls', 'error']) {
    const footer = '\n\nmemory notice';
    const entry = { step: 1, streamMarkers: new Map(), scope: { taskId: 7 } };
    async function* reply() {
      for (const [index, text] of ['first', 'last\n<|task:7|>'].entries()) {
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text };
        yield { type: 'block-end', index, block: { type: 'text', text } };
      }
      yield { type: 'usage', usage: { outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: reason } };
    }
    const chunks = await Array.fromAsync(hideHubStreamMarker(reply(), entry, { strip: false, footer }));
    const visible = chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('\n');
    assert.equal(visible.includes(footer), reason === 'stop');
    assert.deepEqual(chunks.slice(-3).map(c => c.type), ['block-end', 'usage', 'finish']);
    assert.ok(visible.endsWith('<|task:7|>'));
    assert.equal(entry.streamMarkers.get(1).display_text, visible);
    assert.equal(entry.streamMarkers.get(1).answer, 'first\nlast');
  }
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

test('manual recovery after a text choice uses the original request plus later authored steering', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-picker-recover-'));
  const ctx = mockCtx(), s = scopedSession(ctx, 'recover-choice');
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled: true } });
  t.after(async () => { await host.dispose(); fs.rmSync(hub, { recursive: true, force: true }); });
  upsertHubTask(hub, { id: 9, title: 'CSV export' });
  const events = [];
  s.session.eventAt = i => events[i];
  const append = (type, data) => {
    const event = { seq: events.length, surfaceOp: 'append', type, data };
    events.push(event);
    ctx.handlers.get('session/event')(s.session, event);
  };
  const user = content => append('user/message', { source: { kind: 'user' }, content });
  const finish = (turn, content) => {
    append('assistant/message', { turn, step: 1, message: { content } });
    append('turn/end', { turn, reason: { kind: 'completed' } });
  };
  const original = '继续，把失败的测试修掉';
  await s.start(1, original);
  user(original);
  finish(1, '你想继续哪项任务？');
  await s.start(2, 'CSV 那个');
  user('CSV 那个');
  user('Only check the header.');
  finish(2, 'header verified');
  assert.equal((await s.slash('recover 2 9')).kind, 'success');
  assert.deepEqual(readHubTaskThread(hub, 9).map(r => r.content), [original + '\n\nOnly check the header.', 'header verified']);
  assert.equal(readSessionBinding(hub, s.session.id), null);
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
    assert.equal(JSON.parse(doctor.text).ok, true, 'new task has no history to lose');
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
