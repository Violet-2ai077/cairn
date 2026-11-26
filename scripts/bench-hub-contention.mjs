import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConsistentHub, withHubWriteLock, withImmediateHubAccess } from '../src/kernel/hub-write-lock.mjs';

async function probe(op, expected) {
  const start = performance.now();
  const wake = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  assert.throws(op, error => error.message === expected);
  const elapsed = performance.now() - start;
  return { outcome: expected, call_ms: elapsed, timer_observed_after_ms: await wake };
}

if (process.argv[2] === '--probe') {
  const root = process.argv[3];
  const measure = async run => ({
    read: await probe(() => run(() => readConsistentHub(root, () => null)), 'hub_snapshot_busy'),
    write: await probe(() => run(() => withHubWriteLock(root, () => {})), 'hub_write_lock_busy')
  });
  const interactive = await measure(work => withImmediateHubAccess(root, work));
  const default_retry = await measure(work => work());
  console.log(JSON.stringify({ node: process.version, platform: process.platform, interactive, default_retry }, null, 2));
} else {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'cairn-contention-'));
  try {
    withHubWriteLock(root, () => {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', root],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      process.stdout.write(result.stdout);
    });
  } finally {
    if (path.dirname(root) === parent && path.basename(root).startsWith('cairn-contention-')) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
