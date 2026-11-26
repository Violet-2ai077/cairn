import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendHubTaskTurn, upsertHubTask } from '../src/kernel/hub-store.mjs';
import { backupHub, restoreHub } from '../src/workers/hub-recovery.mjs';

const cli = fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url));
const secret = 'sensitive private transcript content';
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-seal-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, 'hub'), bundle = path.join(tmp, 'bundle'), restored = path.join(tmp, 'restored');
  const keyFile = path.join(tmp, 'key'), badKey = path.join(tmp, 'wrong');
  fs.writeFileSync(keyFile, randomBytes(32)); fs.writeFileSync(badKey, randomBytes(32));
  upsertHubTask(src, { title: 'private task' });
  appendHubTaskTurn(src, { task_id: 1, content: secret });
  return { tmp, src, bundle, restored, keyFile, badKey };
}
function files(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter(p => fs.statSync(path.join(dir, p)).isFile()).sort();
}
test('authenticated cold backup hides names and content, and restores the exact source bytes', t => {
  const { src, bundle, restored, keyFile } = fixture(t);
  const before = new Map(files(src).map(p => [p, fs.readFileSync(path.join(src, p))]));
  for (const args of [['backup', bundle, '--store', src], ['restore', bundle, '--store', restored]]) {
    const r = spawnSync(process.execPath, [cli, ...args, '--key-file', keyFile, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  for (const p of files(bundle)) {
    assert.doesNotMatch(p, /thread|tasks|sessions/);
    const bytes = fs.readFileSync(path.join(bundle, p));
    assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes('thread.jsonl'), false);
  }
  assert.deepEqual(files(restored), [...before.keys()]);
  for (const [p, original] of before) assert.deepEqual(fs.readFileSync(path.join(restored, p)), original, p);
});
test('missing/wrong keys, altered ciphertext and manifest, and plaintext downgrade do not restore', t => {
  const { src, bundle, restored, keyFile, badKey, tmp } = fixture(t);
  backupHub(src, bundle, { keyFile });
  assert.throws(() => restoreHub(bundle, restored), /key_required/);
  assert.throws(() => restoreHub(bundle, restored, { keyFile: badKey }), /authentication/);
  const blob = files(bundle).find(p => !p.endsWith('manifest.json'));
  const target = path.join(bundle, blob), bytes = fs.readFileSync(target);
  const modified = Buffer.from(bytes); modified[0] ^= 1; fs.writeFileSync(target, modified);
  assert.throws(() => restoreHub(bundle, restored, { keyFile }), /authentication/);
  fs.writeFileSync(target, bytes);
  const manifest = path.join(bundle, 'manifest.json'), m = JSON.parse(fs.readFileSync(manifest));
  m.salt = '00'.repeat(32); fs.writeFileSync(manifest, JSON.stringify(m));
  assert.throws(() => restoreHub(bundle, restored, { keyFile }), /authentication/);
  assert.equal(fs.existsSync(restored), false);
  const plain = path.join(tmp, 'plain');
  backupHub(src, plain);
  assert.throws(() => restoreHub(plain, restored, { keyFile }), /encrypted_backup_required/);
  assert.equal(fs.existsSync(restored), false);
  const leak = path.join(src, 'key');
  fs.copyFileSync(keyFile, leak);
  assert.throws(() => backupHub(src, path.join(tmp, 'unsafe'), { keyFile: leak }), /key_must_be_external/);
  assert.notEqual(spawnSync(process.execPath, [cli, 'status', '--store', src, '--key-file', keyFile]).status, 0);
});
