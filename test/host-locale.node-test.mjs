import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Node's test runner isolates each file; select the locale before loading dsh.
process.env.CAIRN_LOCALE = 'en';
const { initHubStore, upsertHubTask, readHubTasksIndex, readSessionChoice } = await import('../src/kernel/hub-store.mjs');
const { captureCompatibilityContext } = await import('../src/hosts/dsh/hub-context.mjs');
const { freshSessionReply } = await import('../src/hosts/dsh/single-task-session.mjs');
const { pickTask } = await import('../src/hosts/dsh/task-picker.mjs');
const { memoryNotice, memoryReply, memoryCommand } = await import('../src/hosts/dsh/memory-dialog.mjs');
const { openMemoryReview } = await import('../src/kernel/memory-review.mjs');
const { HUB_TURN_CONTRACT } = await import('../src/hosts/dsh/hub-turn-runtime.mjs');

test('English host context preserves routing markers and task-selection authority', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-locale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initHubStore(root);
  for (let id = 1; id <= 6; id++) upsertHubTask(root, { id, title: 'Work item ' + id });
  const { base, local } = captureCompatibilityContext(root, { unresolved: true });
  assert.match(base, /distinct new task, output <\|task:7\|>/u);
  assert.match(local, /clarification, output <\|task:UNRESOLVED\|>/u);
  assert.match(freshSessionReply(42), /continue task #42/u);
  assert.doesNotMatch([base, local, freshSessionReply(42), HUB_TURN_CONTRACT].join('\n'), /\p{Script=Han}/u);

  const options = { root, sessionId: 'pick', expectedEpoch: null, payload: {}, projects: new Map(),
    eligible: readHubTasksIndex(root).tasks, current: () => true };
  const choose = (turn, input) => pickTask({ ...options, entry: { turn, input }, pending: readSessionChoice(root, 'pick') });
  const first = await choose(1, 'continue');
  assert.match(first.text, /Which task do you want to continue\?/u);
  assert.doesNotMatch(first.text, /\p{Script=Han}/u);
  const second = await choose(2, 'More tasks');
  assert.match(second.text, /Work item 6/u);
  const last = await choose(3, '取消');
  assert.deepEqual(last, { reason: 'choice_cancelled', text: 'Cancelled. The original request was not executed.' });
  assert.equal(readSessionChoice(root, 'pick'), null);
});

test('English memory notices preserve quotes and accept exact controls in either language', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-memory-locale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initHubStore(root);
  const notice = memoryNotice([{ quote: 'Prefer 中文', scopes: ['project', 'user'] }], 4);
  assert.match(notice, /4\.1 “Prefer 中文”: This project only or all projects\?/u);
  assert.doesNotMatch(notice.replace('中文', ''), /\p{Script=Han}/u);
  for (const phrase of ['This project only', '仅本项目']) assert.deepEqual(memoryReply(phrase), [null, phrase.toLowerCase()]);
  for (const phrase of ['查看记忆', 'View memory']) assert.deepEqual(memoryReply(phrase), []);
  assert.deepEqual(memoryReply('Memory 4.1 user'), ['4.1', 'user']);
  assert.deepEqual(memoryReply('记忆 4.1 跳过'), ['4.1', '跳过']);
  assert.equal(memoryReply('Memory 4.1 project and do something else'), null);
  openMemoryReview(root, 'session', '4.1', { quote: 'Prefer 中文', scopes: ['user'] }, null);
  assert.equal(memoryCommand(root, 'session', ['4.1', 'project', 'skip']).kind, 'error');
  assert.match(memoryCommand(root, 'session', []).text, /Preparing; not yet in effect/u);
  assert.match(memoryCommand(root, 'session', memoryReply('memory 4.1 skip')).text, /Skipped; not saved/u);
  assert.match(memoryCommand(root, 'session', []).text, /No memory proposals/u);
});
