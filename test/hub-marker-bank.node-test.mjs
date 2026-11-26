import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHubDshHost } from '../src/hosts/dsh/hub-host.mjs';
import { initHubStore, claimSessionMarkerBank, clearSessionBinding, readSessionMarkerBank, writeSessionBinding,
  upsertHubTask, readHubTasksIndex, readHubTaskThread, readTurnReceipts } from '../src/kernel/hub-store.mjs';
import { parseTaskMarker } from '../src/kernel/marker.mjs';

const bin = fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url));
function cli(...args) {
  const r = spawnSync(process.execPath, [bin, ...args, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
async function adapter(hub, enabled) {
  const handlers = new Map(), contexts = [];
  const ctx = { on(key, fn) { handlers.set(key, fn); }, systemPrompt: { context(def) { contexts.push(def); } } };
  const host = await createHubDshHost(ctx, { storeRoot: hub, autopilot: { enabled },
    llmClient: { complete: async req => ({ ok: true, content: req.system.startsWith('Route the opening')
      ? '{"decision":"new","task_id":null}' : '{"ops":[]}' }) } });
  return { host, async turn(s, turn, input, marker) {
    const event = (type, data) => handlers.get('session/event')(s, { type, data, surfaceOp: 'append' });
    event('turn/start', { turn });
    event('user/message', { turn, message: { source: { kind: 'user' }, content: input } });
    await handlers.get('agent/pre-step')?.({ turn, step: 1, agent: { session: s }, session: s,
      messages: [{ source: { kind: 'user' }, content: input }] }, async () => ({ kind: 'enter' }));
    const prompt = contexts.map(p => p.text({ session: s })).join('\n');
    event('assistant/message', { turn, step: 1, message: { content: 'answer\n<|task:' + marker + '|>' } });
    event('turn/end', { turn, reason: { kind: 'completed' } });
    await handlers.get('session/flush')?.(s);
    return prompt;
  } };
}

test('banked Hub keeps literal markers short and immutable across native session restart and compatibility mode', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-bank-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hub = path.join(tmp, 'hub');
  cli('init', '--store', hub, '--extended-task-ids');
  upsertHubTask(hub, { id: 1 }); upsertHubTask(hub, { id: 999 });
  const fresh = { id: 'banked', inheritedEventCount: 0 }, old = { id: 'low', inheritedEventCount: 0 };
  let a = await adapter(hub, true);
  assert.match(await a.turn(old, 1, 'continue task #999', 999), /Required tail marker[^\n]*task:999/);
  await a.turn(old, 2, 'new task: another item', 1);
  assert.equal(readTurnReceipts(hub, old.id, 2).reason, 'fresh_session_required');
  const fork = { id: 'fork', inheritedEventCount: 2 };
  await a.turn(fork, 1, 'new task: another item', 1);
  assert.equal(readTurnReceipts(hub, fork.id, 1).reason, 'fresh_session_required');
  assert.match(await a.turn(fresh, 1, 'new task: another item', 1), /Required tail marker[^\n]*task:1\|/);
  assert.equal(readTurnReceipts(hub, fresh.id, 1).task_id, 1000);
  assert.equal(readHubTaskThread(hub, 1000).length, 2);
  assert.equal(parseTaskMarker('answer\n<|task:1000|>').valid, false);
  a = await adapter(hub, true);
  await a.turn(fresh, 2, 'continue task #1000', 2);
  assert.equal(readTurnReceipts(hub, fresh.id, 2).reason, 'marker_mismatch');
  await a.turn(fresh, 3, 'continue task #1000', 1);
  assert.equal(readTurnReceipts(hub, fresh.id, 3).task_id, 1000);
  await a.turn(fresh, 4, 'continue task #1', 1);
  assert.equal(readTurnReceipts(hub, fresh.id, 4).reason, 'fresh_session_required');
  const legacy = await adapter(hub, false);
  await legacy.turn(fresh, 5, 'continue', 1);
  assert.equal(readTurnReceipts(hub, fresh.id, 5).reason, 'marker_bank_requires_turn_scope');
  assert.equal(readHubTaskThread(hub, 1).length, 0);
  assert.equal(readHubTasksIndex(hub).next_task_id, 1001);
  assert.equal(cli('checkout', '1000', '--preview', '--store', hub).task_id, 1000);
  const bundle = path.join(tmp, 'backup'), restored = path.join(tmp, 'restored');
  cli('backup', bundle, '--store', hub); cli('restore', bundle, '--store', restored);
  assert.deepEqual(readHubTaskThread(restored, 1000), readHubTaskThread(hub, 1000));
  const restoredHost = await adapter(restored, true);
  await restoredHost.turn(fresh, 6, 'continue task #1', 1);
  assert.equal(readTurnReceipts(restored, fresh.id, 6).reason, 'fresh_session_required');
  upsertHubTask(restored, { id: 999000 });
  assert.throws(() => upsertHubTask(restored, {}), /task_ids_exhausted/);
  assert.throws(() => upsertHubTask(restored, { id: 1002 }), /below_allocation_cursor/);
  assert.equal(readHubTasksIndex(restored).next_task_id, 999001);
});

test('one native session cannot claim two banks in concurrent hosts; clearing a checkout does not clear the bank', async t => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-bank-race-'));
  t.after(() => fs.rmSync(hub, { recursive: true, force: true }));
  initHubStore(hub, { extendedTaskIds: true });
  const script = `import {claimSessionMarkerBank} from ${JSON.stringify(new URL('../src/kernel/hub-store.mjs', import.meta.url).href)};
    console.log(claimSessionMarkerBank(process.argv[1], 'same', Number(process.argv[2]),
      { turn:1, nativeId:'same', inheritedEventCount:0 }));`;
  const results = await Promise.all([1, 1000].map(id => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', script, hub, String(id)])));
  assert.deepEqual(results.map(r => r.stdout.trim()).sort(), ['false', 'true']);
  const bank = readSessionMarkerBank(hub, 'same');
  writeSessionBinding(hub, 'same', { source: 'explicit' }); clearSessionBinding(hub, 'same');
  assert.equal(readSessionMarkerBank(hub, 'same'), bank);
  assert.equal(claimSessionMarkerBank(hub, 'same', bank === 0 ? 1000 : 1,
    { turn: 1, nativeId: 'same', inheritedEventCount: 0 }), false);
});
