import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const format = 'cairn-cold-hub', version = 2, cipher = 'aes-256-gcm';
const domain = Buffer.from('cairn:cold-backup:v2:aes-256-gcm');
const authFailure = () => new Error('backup_authentication_failed');
const blobName = index => String(index).padStart(8, '0') + '.bin';

function regular(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw new Error('recovery_invalid_regular_file');
  return st;
}
function derive(keyFile, salt, roots) {
  if (!keyFile) throw new Error('backup_key_required');
  const keyPath = fs.realpathSync.native(keyFile);
  if (roots.some(root => {
    const rel = path.relative(root, keyPath);
    return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
  })) throw new Error('backup_key_must_be_external');
  const size = regular(keyFile).size;
  if (![32, 64, 65, 66].includes(size)) throw new Error('backup_key_must_be_32_bytes');
  const raw = fs.readFileSync(keyFile);
  let master = raw;
  try {
    if (raw.length !== 32) {
      if (!/^[\da-f]{64}(?:\r?\n)?$/iu.test(raw.toString('latin1'))) throw new Error('backup_key_must_be_32_bytes');
      master = Buffer.from(raw.toString('latin1').trimEnd(), 'hex');
    }
    return Buffer.from(hkdfSync('sha256', master, salt, domain, 32));
  } finally { raw.fill(0); master.fill(0); }
}

// Manifest uses nonce 0. File nonces are their unique authenticated inventory positions.
function transform(key, index, opening = false) {
  const iv = Buffer.alloc(12); iv.writeBigUInt64BE(BigInt(index), 4);
  const ctx = (opening ? createDecipheriv : createCipheriv)(cipher, key, iv, { authTagLength: 16 });
  ctx.setAAD(domain);
  return ctx;
}
function openEnvelope(bytes, key) {
  if (bytes.length < 16) throw authFailure();
  const ctx = transform(key, 0, true);
  ctx.setAuthTag(bytes.subarray(-16));
  try { return JSON.parse(Buffer.concat([ctx.update(bytes.subarray(0, -16)), ctx.final()]).toString('utf8')); }
  catch { throw authFailure(); }
}
function writeAll(fd, bytes) {
  for (let pos = 0; pos < bytes.length;) {
    const n = fs.writeSync(fd, bytes, pos, bytes.length - pos);
    if (!n) throw new Error('backup_short_write');
    pos += n;
  }
}
function streamBlob(key, index, entry, source, dest, opening) {
  if (regular(source).size !== entry.size + (opening ? 16 : 0)) throw new Error('recovery_integrity_mismatch');
  const ctx = transform(key, index, opening), hash = createHash('sha256');
  const input = fs.openSync(source, 'r');
  let output;
  try {
    if (dest) output = fs.openSync(dest, 'wx', 0o600);
    const block = Buffer.allocUnsafe(65536);
    for (let left = entry.size; left > 0;) {
      const n = fs.readSync(input, block, 0, Math.min(left, block.length), null);
      if (!n) throw new Error('recovery_integrity_mismatch');
      const chunk = block.subarray(0, n), transformed = ctx.update(chunk);
      hash.update(opening ? transformed : chunk);
      if (output !== undefined) writeAll(output, transformed);
      left -= n;
    }
    if (opening) {
      const tag = Buffer.alloc(16);
      if (fs.readSync(input, tag, 0, 16, null) !== 16) throw authFailure();
      ctx.setAuthTag(tag);
      try { ctx.final(); } catch { throw authFailure(); }
    } else {
      writeAll(output, ctx.final()); writeAll(output, ctx.getAuthTag());
    }
    if (fs.readSync(input, block, 0, 1, null) || hash.digest('hex') !== entry.sha256) throw new Error('recovery_integrity_mismatch');
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
}

function validInventory(entries) {
  if (!Array.isArray(entries)) throw new Error('recovery_invalid_inventory');
  const known = new Map();
  for (const e of entries) {
    const parts = typeof e?.path === 'string' ? e.path.split('/') : [];
    if (!parts.length || parts.some(part => !part || /[\\:\x00-\x1f]/u.test(part) ||
        /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part)) ||
        /^\.write\.lock(?:\.|$)/iu.test(parts[0])) throw new Error('recovery_invalid_inventory_path');
    const identity = process.platform === 'win32' ? e.path.toLowerCase() : e.path;
    const parent = identity.slice(0, identity.lastIndexOf('/'));
    if (known.has(identity) || (parts.length > 1 && known.get(parent) !== 'directory') ||
        (e.type !== 'directory' && (e.type !== 'file' || !Number.isSafeInteger(e.size) || e.size < 0 ||
         typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(e.sha256)))) throw new Error('recovery_invalid_inventory');
    known.set(identity, e.type);
  }
}

export function sealBackup(src, bundle, entries, keyFile) {
  const salt = randomBytes(32), key = derive(keyFile, salt, [src, bundle]);
  try {
    validInventory(entries);
    fs.mkdirSync(bundle, { mode: 0o700 });
    for (const [i, e] of entries.entries()) if (e.type === 'file') {
      const blob = path.join(bundle, blobName(i + 1));
      streamBlob(key, i + 1, e, path.join(src, e.path), blob, false);
      streamBlob(key, i + 1, e, blob, null, true);
    }
    const ctx = transform(key, 0);
    const bytes = Buffer.concat([ctx.update(JSON.stringify(entries), 'utf8'), ctx.final(), ctx.getAuthTag()]);
    const manifest = { format, version, salt: salt.toString('hex'), sealed: bytes.toString('base64') };
    const pending = path.join(bundle, '.manifest.pending');
    fs.writeFileSync(pending, JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(pending, path.join(bundle, 'manifest.json'));
  } finally { key.fill(0); }
}

export function withOpenBackup(bundle, dest, manifest, keyFile, restore) {
  if (!keyFile) throw new Error('backup_key_required');
  if (Object.keys(manifest).sort().join(',') !== 'format,salt,sealed,version' || manifest.format !== format ||
      manifest.version !== version || typeof manifest.salt !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.salt) ||
      typeof manifest.sealed !== 'string') throw new Error('recovery_invalid_manifest');
  const key = derive(keyFile, Buffer.from(manifest.salt, 'hex'), [bundle, dest]);
  try {
    const bytes = Buffer.from(manifest.sealed, 'base64');
    if (bytes.toString('base64') !== manifest.sealed) throw authFailure();
    const entries = openEnvelope(bytes, key);
    validInventory(entries);
    const names = new Set(['manifest.json']);
    const unpack = target => {
      for (const [i, e] of entries.entries()) {
        const out = target ? path.join(target, e.path) : null;
        if (e.type === 'directory') { if (out) fs.mkdirSync(out, { mode: 0o700 }); continue; }
        const name = blobName(i + 1); names.add(name);
        streamBlob(key, i + 1, e, path.join(bundle, name), out, true);
      }
    };
    unpack(null); // Authenticate every byte before reserving or populating a destination.
    if (fs.readdirSync(bundle).some(name => !names.has(name))) throw new Error('recovery_unexpected_bundle_entry');
    return restore(entries, unpack);
  } finally { key.fill(0); }
}
