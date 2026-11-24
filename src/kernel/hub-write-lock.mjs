import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const held = new Set();
const waiter = new Int32Array(new SharedArrayBuffer(4));
const machine = createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
const ownerName = /^([0-9a-f]{16})-([1-9]\d{0,9})-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const raced = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const transientAccess = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);

function definitelyGone(pid) {
  if (pid <= 0 || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// Non-recursive rmdir is the compare-and-delete: a new owner always has
// its own uniquely named file already inside when its directory appears.
function removeEmpty(dir) {
  try { fs.rmdirSync(dir); }
  catch (error) { if (!raced(error) && !transientAccess(error) && !['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

function release(dir, token) {
  try { fs.unlinkSync(path.join(dir, token)); }
  catch (error) { if (raced(error)) return; throw error; }
  removeEmpty(dir);
}

function reapDirectory(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  if (!files.length) { removeEmpty(dir); return; }
  if (files.length !== 1 || !files[0].isFile()) return;
  const owner = ownerName.exec(files[0].name);
  if (owner && owner[1] === machine && definitelyGone(Number(owner[2]))) release(dir, files[0].name);
}

// Old writers use wx + PID and don't participate in recovery. Serialize
// their reapers, and pin the inode across the liveness check: a legacy
// owner may finish normally and a different writer may reuse the pathname.
function reapLegacy(lock) {
  const fd = fs.openSync(lock, 'r');
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.ino === 0n || st.size < 1n || st.size > 10n) return;
    const text = fs.readFileSync(fd, 'utf8');
    if (!/^[1-9]\d{0,9}$/u.test(text) || !definitelyGone(Number(text))) return;
    const now = fs.lstatSync(lock, { bigint: true, throwIfNoEntry: false });
    if (now?.isFile() && now.ino === st.ino && now.dev === st.dev) fs.unlinkSync(lock);
  } finally { fs.closeSync(fd); }
}

function underDirectoryLock(lock, deadline, work) {
  const token = machine + '-' + process.pid + '-' + randomUUID();
  const candidate = lock + '.pending-' + token;
  fs.mkdirSync(candidate);
  let published = false;
  try {
    fs.writeFileSync(path.join(candidate, token), '', { flag: 'wx' });
    for (;;) {
      try {
        const st = fs.lstatSync(lock, { throwIfNoEntry: false });
        if (!st) { fs.renameSync(candidate, lock); published = true; break; }
        if (st.isDirectory()) reapDirectory(lock);
      } catch (error) { if (!raced(error) && !transientAccess(error) && !['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      if (performance.now() >= deadline) throw new Error('hub_write_lock_busy');
      Atomics.wait(waiter, 0, 0, 10);
    }
    return work();
  } finally {
    if (published) release(lock, token);
    else { release(candidate, token); removeEmpty(candidate); }
  }
}

// Never rename onto the legacy pathname: Windows can replace even a live
// regular PID file with a directory. mkdir is exclusive for both kinds.
function acquireLegacyFence(lock, deadline) {
  for (;;) {
    try { fs.mkdirSync(lock); return; }
    catch (error) { if (error.code !== 'EEXIST' && !transientAccess(error)) throw error; }
    try {
      const st = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (st?.isDirectory() && fs.readdirSync(lock).length === 0) return; // Left by the previous guard owner.
      if (st?.isFile()) reapLegacy(lock);
    } catch (error) { if (!raced(error) && !transientAccess(error) && error.code !== 'EISDIR') throw error; }
    if (performance.now() >= deadline) throw new Error('hub_write_lock_busy');
    Atomics.wait(waiter, 0, 0, 10);
  }
}

export function withHubWriteLock(hubRoot, work) {
  fs.mkdirSync(hubRoot, { recursive: true });
  const lock = path.join(fs.realpathSync.native(hubRoot), '.write.lock');
  if (held.has(lock)) return work();
  const deadline = performance.now() + 1000;
  return underDirectoryLock(lock + '.guard', deadline, () => {
    acquireLegacyFence(lock, deadline);
    held.add(lock);
    try { return work(); } finally { held.delete(lock); fs.rmdirSync(lock); }
  });
}
