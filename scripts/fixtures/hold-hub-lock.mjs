import fs from 'node:fs';
import path from 'node:path';
import { withHubWriteLock } from '../../src/kernel/hub-write-lock.mjs';

const root = process.argv[2];
const waiter = new Int32Array(new SharedArrayBuffer(4));
withHubWriteLock(root, () => {
  process.send('held');
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(path.join(root, 'release-after-delay'))) {
    if (performance.now() > deadline) throw new Error('parent did not release peer');
    Atomics.wait(waiter, 0, 0, 5);
  }
  Atomics.wait(waiter, 0, 0, 80);
});
