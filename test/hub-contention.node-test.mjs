import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHubDshHost } from '../src/hosts/dsh/hub-host.mjs';
import { readHubTaskThread, readHubTasksIndex, readTurnReceipts, upsertHubTask, writeSessionBinding } from '../src/kernel/hub-store.mjs';

test('a live peer fences interactive snapshots and human writes without sleeping; turn/end still archives across a short hold', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-contention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  upsertHubTask(root, { id: 1, title: 'Pinned' });
  const session = { id: 'contender' };
  writeSessionBinding(root, session.id, { task_id: 1, project_id: null, source: 'slash_checkout' });
  const hooks = new Map(), contexts = [], commands = [], tools = [];
  const host = await createHubDshHost({
    on: (name, fn) => { hooks.set(name, fn); },
    systemPrompt: { context: def => { contexts.push(def); } },
    commands: { register: def => { commands.push(def); } },
    tools: { register: def => { tools.push(def); } }
  }, { storeRoot: root, llmClient: { complete: async () => ({ ok: true, content: '{"ops":[]}' }) } });
  t.after(() => host.dispose());
  const emit = (type, data) => hooks.get('session/event')(session, { type, surfaceOp: 'append', data: { turn: 1, ...data } });
  emit('turn/start', {});
  await hooks.get('agent/pre-step')({ session, turn: 1 }, async () => ({ kind: 'enter' }));
  emit('user/message', { message: { source: { kind: 'user' }, content: 'question' } });
  emit('assistant/message', { step: 1, message: { content: 'confirmed answer\n<|task:1|>' } });

  const scopedHooks = new Map(), scopedSession = { id: 'scope-busy' };
  writeSessionBinding(root, scopedSession.id, { task_id: 1, project_id: null, source: 'slash_checkout' });
  const scoped = await createHubDshHost({ on: (name, fn) => { scopedHooks.set(name, fn); } },
    { storeRoot: root, autopilot: { enabled: true } });
  t.after(() => scoped.dispose());
  const peer = fork(new URL('../scripts/fixtures/hold-hub-lock.mjs', import.meta.url), [root], { execArgv: [], windowsHide: true });
  const exited = once(peer, 'exit');
  try {
    assert.deepEqual((await Promise.race([once(peer, 'message'), exited]))[0], 'held');
    const wait = t.mock.method(Atomics, 'wait', () => { throw new Error('unexpected synchronous sleep'); });
    try {
      assert.throws(() => contexts[0].text({ session }), /^Error: hub_snapshot_busy$/u);
      const reply = await commands[0].handler({ rawInput: 'close 1', agent: { session } });
      assert.deepEqual(reply, { kind: 'error', text: 'hub_write_lock_busy' });
      const tool = tools.find(def => def.name === 'cairn_close_task');
      assert.equal(await tool.execute({ task_id: 1, confirmed: true }), 'hub_write_lock_busy');
      await scopedHooks.get('agent/pre-step')({ session: scopedSession, turn: 1, step: 1,
        messages: [{ source: { kind: 'user' }, content: 'use the current task' }] }, async () => ({ kind: 'enter' }));
      assert.equal(scoped.sessions.get(scopedSession.id).route.reason, 'hub_snapshot_busy');
      const stream = scopedHooks.get('llm/stream')({ sessionId: scopedSession.id }, () => assert.fail('busy scope reached provider'));
      for await (const chunk of stream) assert.ok(chunk);
      assert.equal(wait.mock.callCount(), 0);
      assert.equal(readHubTasksIndex(root).tasks[0].status, 'active');
    } finally { wait.mock.restore(); }
    fs.writeFileSync(path.join(root, 'release-after-delay'), '');
    emit('turn/end', { reason: { kind: 'completed' } });
    assert.equal((await exited)[0], 0);
    await hooks.get('session/flush')(session);
    assert.deepEqual(readHubTaskThread(root, 1).map(row => row.content), ['question', 'confirmed answer']);
    scopedHooks.get('session/event')(scopedSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(readTurnReceipts(root, scopedSession.id, 1).reason, 'hub_snapshot_busy');
  } finally {
    if (peer.exitCode === null && peer.signalCode === null) peer.kill();
    await exited;
  }
});
