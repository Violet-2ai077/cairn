import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isHubInitialized } from '../kernel/hub-store.mjs';
import { withHubWriteLock } from '../kernel/hub-write-lock.mjs';
import { runHubDoctor } from './hub-doctor.mjs';

const format = 'cairn-cold-hub';
const lockEntry = name => /^\.write\.lock(?:\.guard(?:\.pending-.+)?)?$/iu.test(name);
const inside = (root, child) => {
  const rel = path.relative(root, child);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
};
function directory(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('recovery_expected_directory_not_link');
  return fs.realpathSync.native(dir);
}
function newDestination(src, requested) {
  const abs = path.resolve(requested);
  const out = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
  if (inside(src, out) || inside(out, src)) throw new Error('recovery_paths_overlap');
  if (fs.lstatSync(out, { throwIfNoEntry: false })) throw new Error('recovery_destination_exists');
  return out;
}
function fileDigest(file) {
  const hash = createHash('sha256'), block = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r');
  let size = 0, n;
  try {
    while ((n = fs.readSync(fd, block, 0, block.length, null)) > 0) {
      hash.update(block.subarray(0, n));
      size += n;
    }
  } finally { fs.closeSync(fd); }
  return { size, sha256: hash.digest('hex') };
}

// Paths come only from actual directory entries, never from an input manifest.
function scan(root, { copyTo = null, liveSource = false } = {}) {
  const entries = [];
  function visit(rel) {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      if (!rel && lockEntry(name)) {
        if (liveSource) continue;
        throw new Error('recovery_unexpected_lock');
      }
      const key = rel ? rel + '/' + name : name, file = path.join(root, key);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        entries.push({ path: key, type: 'directory' });
        if (copyTo) fs.mkdirSync(path.join(copyTo, key), { mode: 0o700 });
        visit(key);
      } else if (stat.isFile() && stat.nlink === 1) {
        entries.push({ path: key, type: 'file', ...fileDigest(file) });
        if (copyTo) fs.copyFileSync(file, path.join(copyTo, key), fs.constants.COPYFILE_EXCL);
      } else throw new Error('recovery_unsupported_entry:' + key);
    }
  }
  visit('');
  return entries;
}
function verify(entries, expected) {
  if (!isDeepStrictEqual(entries, expected)) throw new Error('recovery_integrity_mismatch');
}
function healthy(root) {
  const report = runHubDoctor({ hubRoot: root });
  if (!report.ok) throw new Error('recovery_unhealthy_hub:' + report.issues.map(i => i.code).join(','));
}
const result = (location, entries) => ({ ok: true, ...location, file_count: entries.filter(e => e.type === 'file').length });

export function backupHub(hubRoot, backupDir) {
  const src = directory(hubRoot), bundle = newDestination(src, backupDir);
  if (!isHubInitialized(src)) throw new Error('backup_requires_initialized_hub');
  const data = path.join(bundle, 'data');
  // The operator stops writers first; the normal Hub lock fences a writer that races the copy.
  const entries = withHubWriteLock(src, () => {
    fs.mkdirSync(bundle, { mode: 0o700 });
    fs.mkdirSync(data, { mode: 0o700 });
    return scan(src, { copyTo: data, liveSource: true });
  });
  verify(scan(data), entries);
  healthy(data);
  const pending = path.join(bundle, '.manifest.pending');
  fs.writeFileSync(pending, JSON.stringify({ format, version: 1, entries }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(pending, path.join(bundle, 'manifest.json'));
  return result({ backup: bundle }, entries);
}

export function restoreHub(backupDir, hubRoot) {
  const bundle = directory(backupDir), dest = newDestination(bundle, hubRoot);
  const manifest = path.join(bundle, 'manifest.json'), st = fs.lstatSync(manifest);
  if (!st.isFile() || st.nlink !== 1) throw new Error('recovery_invalid_manifest');
  const { format: kind, version, entries } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (kind !== format || version !== 1 || !Array.isArray(entries)) throw new Error('recovery_invalid_manifest');
  const data = directory(path.join(bundle, 'data'));
  verify(scan(data), entries);
  // Reserve exclusively, including against a concurrent restore. Never clean or replace a caller's directory.
  fs.mkdirSync(dest, { mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(dest, '.restore-pending-'));
  verify(scan(data, { copyTo: staging }), entries);
  verify(scan(staging), entries);
  healthy(staging);
  for (const name of fs.readdirSync(staging)) {
    if (name !== 'hub.json') fs.renameSync(path.join(staging, name), path.join(dest, name));
  }
  // No initialized Hub is visible until all validated payload files are in place.
  fs.renameSync(path.join(staging, 'hub.json'), path.join(dest, 'hub.json'));
  fs.rmdirSync(staging);
  return result({ hub: dest }, entries);
}
