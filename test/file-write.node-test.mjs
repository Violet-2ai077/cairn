import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureFileWrite, verifyFileWrite } from 'cairn/kernel';
import { compileHubHandoff } from '../src/workers/hub-handoff.mjs';
import { upsertHubTask, writeSessionBinding, recordTurnReceipt, readHubTaskThread, readScopedHead, registerProject, transitionHubTaskStatus } from '../src/kernel/hub-store.mjs';
import { installFileWriteHook } from '../src/hosts/dsh/file-write-hook.mjs';

const digest = s => createHash('sha256').update(s).digest('hex');
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-write-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'repo'), hub = path.join(dir, 'hub');
  fs.mkdirSync(project);
  upsertHubTask(hub, { id: 1, title: 'Write', project_id: 'p', project: { canonical_root: project } });
  const binding = writeSessionBinding(hub, 's', { task_id: 1, project_id: 'p' });
  recordTurnReceipt(hub, 's', 1, { status: 'in_progress' });
  const content = 'original\nprivate bytes\r\n', target = path.join(project, 'result.txt');
  const input = { taskId: 1, projectId: 'p', bindingEpoch: binding.binding_epoch, target,
    sha256: digest(content), source: { host: 'dsh', session_id: 's', turn: 1, step: 2, call_id: 'call', journal_seq: 3 } };
  return { hub, project, target, input, content, view: () => compileHubHandoff({ hubRoot: hub, taskId: 1 }).work_state.file_writes };
}

test('a write call is immutable evidence; checkout never verifies and explicit checks never write the target', t => {
  const { hub, project, target, input, content, view } = setup(t);
  const id = captureFileWrite(hub, input);
  assert.match(id, /^[a-f0-9]{64}$/u);
  assert.equal(captureFileWrite(hub, input), id);
  assert.throws(() => captureFileWrite(hub, { ...input, sha256: digest('other') }), /conflict/u);
  assert.equal(view()[0].last_check, null);
  assert.equal(view()[0].relative_path, 'result.txt');
  fs.writeFileSync(target, content);
  assert.equal(view()[0].last_check, null);
  const check = () => verifyFileWrite(hub, 1, id);
  assert.equal(check().status, 'matches');
  fs.writeFileSync(target, 'peer changed it');
  assert.equal(view()[0].last_check.status, 'matches');
  assert.equal(check().actual_sha256, digest('peer changed it'));
  assert.equal(view()[0].last_check.status, 'differs');
  assert.equal(fs.readFileSync(target, 'utf8'), 'peer changed it');
  fs.unlinkSync(target);
  assert.equal(check().reason, 'file_missing');
  fs.mkdirSync(target);
  assert.equal(check().status, 'unverifiable');
  assert.equal(readHubTaskThread(hub, 1).length, 0);
  assert.equal(readScopedHead(hub).revision, 0);
  assert.doesNotMatch(JSON.stringify(view()), /private bytes|peer changed it/u);
  registerProject(hub, { project_id: 'p', canonical_root: path.dirname(project) });
  assert.equal(check().reason, 'project_root_changed');
});

test('write capture rejects unsafe targets, stale binding and cross-task verification', t => {
  const { hub, project, input, view } = setup(t);
  const capture = target => captureFileWrite(hub, { ...input, target });
  assert.equal(capture(path.join(project, '..', 'outside')), null);
  assert.equal(capture(path.join(project, '.git', 'config')), null);
  const other = path.join(project, '..', 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(capture(path.join(project, 'link', 'file')), null);
  const id = capture(path.join(project, 'safe', 'file'));
  fs.symlinkSync(other, path.join(project, 'safe'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(verifyFileWrite(hub, 1, id).status, 'unverifiable');
  assert.throws(() => verifyFileWrite(hub, 2, id));
  assert.throws(() => verifyFileWrite(hub, 1, '../other'));
  writeSessionBinding(hub, 's', { task_id: 1, project_id: 'p' });
  assert.equal(capture(path.join(project, 'another')), null);
  assert.equal(view().length, 1);
});

test('the pre-write observer preserves native policy and requires a direct admitted call with a proven path mapping', async t => {
  const { hub, project, target, input, content, view } = setup(t);
  let hook;
  const services = { fs: { processPath: () => target, processPathFromHostPath: () => undefined },
    workingDirectory: { ensure: async () => project } };
  const entry = { scope: { ...input, expectedEpoch: input.bindingEpoch }, step: 2, turn: 1, writeCalls: new Map([['call', { step: 2, seq: 3 }]]) };
  const ctx = { on: (_, handler) => { hook = handler; }, get: name => services[name] };
  installFileWriteHook(ctx, hub, { turns: new Map([['s', entry]]) });
  const exec = { name: 'write', arguments: { file_path: 'result.txt', content }, callId: 'call', agent: { session: { id: 's' } } };
  const policy = Object.freeze({ kind: 'createIfAbsent' });
  const run = overrides => hook({}, { ...exec, ...overrides }, async () => policy);
  assert.equal(await run({}), policy);
  services.fs.processPathFromHostPath = absolute => absolute;
  assert.equal(await run({ parent: {} }), policy);
  assert.equal(await run({ name: 'edit' }), policy);
  assert.equal(await run({ callId: 'not-from-journal' }), policy);
  await assert.rejects(hook({}, exec, async () => { throw new Error('native_denial'); }), /native_denial/u);
  assert.deepEqual(view(), []);
  assert.equal(await run({}), policy);
  assert.equal(view()[0].expected_sha256, digest(content));
  const raw = fs.readFileSync(path.join(hub, 'tasks', '1', 'file-writes', view()[0].id + '.json'), 'utf8');
  assert.doesNotMatch(raw, /private bytes/u);
  assert.equal(await run({ arguments: { file_path: 'result.txt', content: 'conflicting replay' } }), policy);
  assert.equal(view()[0].expected_sha256, digest(content));
});

test('large or multiply linked files are not hashed; frozen tasks cannot be updated by verification', t => {
  const { hub, project, target, input, view } = setup(t);
  const id = captureFileWrite(hub, input);
  fs.writeFileSync(target, '');
  fs.truncateSync(target, 16 * 1024 * 1024 + 1);
  assert.equal(verifyFileWrite(hub, 1, id).reason, 'file_too_large');
  fs.linkSync(target, path.join(project, 'another-name'));
  assert.equal(verifyFileWrite(hub, 1, id).reason, 'not_regular');
  const previous = view();
  transitionHubTaskStatus(hub, { taskId: 1, action: 'close' });
  assert.throws(() => verifyFileWrite(hub, 1, id), /task_not_active/u);
  assert.deepEqual(view(), previous);
});
