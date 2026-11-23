import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const held = new Set();
const waiter = new Int32Array(new SharedArrayBuffer(4));

export function withHubWriteLock(hubRoot, work) {
  fs.mkdirSync(hubRoot, { recursive: true });
  const lock = path.join(fs.realpathSync.native(hubRoot), '.write.lock');
  if (held.has(lock)) return work();
  const deadline = performance.now() + 1000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) throw new Error('hub_write_lock_busy');
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
  held.add(lock);
  try {
    try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    return work();
  }
  finally {
    held.delete(lock);
    fs.unlinkSync(lock);
  }
}
