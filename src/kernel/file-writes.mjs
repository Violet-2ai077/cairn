import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readHubTasksIndex, readProjectsIndex, readSessionBinding, readTurnReceipts, resolveHubPaths } from './hub-store.mjs';
import { withHubWriteLock } from './hub-write-lock.mjs';
import { writeJsonAtomic } from './store.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const hex = /^[a-f0-9]{64}$/u;
const maxBytes = 16 * 1024 * 1024;
const directory = (hub, task) => path.join(resolveHubPaths(hub).taskDir(task), 'file-writes');
const same = (a, b) => path.relative(a, b) === '';
const outside = rel => rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
const lookup = (hub, project) => readProjectsIndex(hub).projects.find(p => p.project_id === project)?.canonical_root;
const taskAt = (hub, id) => readHubTasksIndex(hub).tasks.find(t => t.id === id);
const identity = st => [String(st.dev), String(st.ino)].join(':');
const unavailable = reason => ({ status: 'unverifiable', reason });
function rootStamp(root) {
  if (!root || !path.isAbsolute(root) || /^(?:\\\\|\/\/)/u.test(root)) return null;
  for (let p = path.resolve(root); p !== path.dirname(p); p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) return null;
  }
  const st = fs.lstatSync(root, { bigint: true });
  return st.isDirectory() && st.ino !== 0n ? hash(JSON.stringify([fs.realpathSync.native(root), identity(st), String(st.birthtimeNs)])) : null;
}

// Accept only ordinary local paths, never repository metadata, device aliases or the Hub itself.
function relativeTarget(hub, root, absolute) {
  if (!path.isAbsolute(absolute)) return null;
  const rel = path.relative(root, absolute);
  if (!rel || outside(rel) || !outside(path.relative(hub, absolute))) return null;
  if (!outside(path.relative(fs.realpathSync.native(hub), path.resolve(fs.realpathSync.native(root), rel)))) return null;
  const parts = rel.split(path.sep);
  if (parts.some(p => /[\\/:*?"<>|\x00-\x1f]|[. ]$/u.test(p) ||
    /^(?:\.git|\.cairn)$/iu.test(p) || /^(?:con|conin\$|conout\$|prn|aux|nul|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(p))) return null;
  return parts.join('/');
}

function inspectPath(root, rel) {
  const parts = rel.split('/');
  const canonical = fs.realpathSync.native(root);
  let current = root, stat;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    try { stat = fs.lstatSync(current, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT') return { missing: true }; throw e; }
    if (stat.isSymbolicLink() || !same(fs.realpathSync.native(current), path.join(canonical, ...parts.slice(0, i + 1)))) throw new Error('linked_path');
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) throw new Error('not_regular');
  }
  return { stat, absolute: current };
}

function recordFile(hub, task, id) {
  if (typeof id !== 'string' || !hex.test(id)) throw new Error('invalid_write_id');
  return path.join(directory(hub, task), id + '.json');
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function captureFileWrite(hub, { taskId, projectId, bindingEpoch, source, target, sha256 }) {
  if (!projectId || !bindingEpoch || typeof sha256 !== 'string' || !hex.test(sha256) || typeof source?.host !== 'string' || !source.host ||
    typeof source.session_id !== 'string' || !source.session_id || typeof source.call_id !== 'string' || !source.call_id ||
    !Number.isSafeInteger(source.journal_seq) || source.journal_seq < 0 || !Number.isSafeInteger(source.step) || source.step < 1 ||
    !Number.isSafeInteger(source.turn) || source.turn < 1) return null;
  return withHubWriteLock(hub, () => {
    const binding = readSessionBinding(hub, source.session_id), task = taskAt(hub, taskId);
    if (binding?.binding_epoch !== bindingEpoch || binding.task_id !== taskId || binding.project_id !== projectId ||
      task?.status !== 'active' || task.project_id !== projectId || readTurnReceipts(hub, source.session_id, source.turn)?.status !== 'in_progress') return null;
    const root = lookup(hub, projectId);
    let stamp, rel;
    try {
      stamp = rootStamp(root);
      if (!stamp || !(rel = relativeTarget(hub, root, target))) return null;
      inspectPath(root, rel);
    } catch { return null; } // Unsupported targets are not tracked; dsh still owns the write policy.
    const { host, session_id, turn, step, call_id, journal_seq } = source;
    const id = hash(JSON.stringify([host, session_id, turn, journal_seq, call_id]));
    const intent = { id, task_id: taskId, project_id: projectId, root_stamp: stamp, relative_path: rel, expected_sha256: sha256,
      source: { host, session_id, turn, step, call_id, journal_seq } };
    const file = recordFile(hub, taskId, id);
    if (fs.existsSync(file)) {
      const previous = read(file);
      if (Object.keys(intent).some(k => JSON.stringify(intent[k]) !== JSON.stringify(previous[k]))) throw new Error('write_intent_conflict');
    } else writeJsonAtomic(file, { ...intent, recorded_at: new Date().toISOString(), check_revision: 0, last_check: null });
    return id;
  });
}

export function readFileWrites(hub, taskId) {
  const dir = directory(hub, taskId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/u.test(n)).sort()
    .map(n => { const { root_stamp, ...view } = read(path.join(dir, n)); return view; })
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

function check(hub, root, intent) {
  let fd;
  try {
    if (rootStamp(root) !== intent.root_stamp) return unavailable('project_root_changed');
    const rel = intent.relative_path, absolute = path.resolve(root, rel);
    if (relativeTarget(hub, root, absolute) !== rel) return unavailable('unsafe_path');
    const before = inspectPath(root, rel);
    if (before.missing) return rootStamp(root) === intent.root_stamp && inspectPath(root, rel).missing
      ? { status: 'differs', reason: 'file_missing' } : unavailable('changed_during_check');
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = () => fs.fstatSync(fd, { bigint: true });
    const initial = stat();
    const stable = st => st && st.isFile() && st.nlink === 1n && st.ino !== 0n && identity(st) === identity(initial) &&
      st.size === initial.size && st.ctimeNs === initial.ctimeNs && st.mtimeNs === initial.mtimeNs;
    const stillBound = () => rootStamp(root) === intent.root_stamp && stable(inspectPath(root, rel).stat);
    if (!stable(before.stat) || !stillBound()) return unavailable('changed_during_check');
    if (initial.size > BigInt(maxBytes)) return unavailable('file_too_large');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      if ((bytes += n) > maxBytes) return unavailable('file_too_large');
      digest.update(buffer.subarray(0, n));
    }
    if (BigInt(bytes) !== initial.size || !stable(stat()) || !stillBound()) return unavailable('changed_during_check');
    const actual_sha256 = digest.digest('hex');
    return { status: actual_sha256 === intent.expected_sha256 ? 'matches' : 'differs', actual_sha256, bytes };
  } catch (e) {
    return unavailable(['linked_path', 'not_regular'].includes(e.message) ? e.message : 'path_unavailable');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function verifyFileWrite(hub, taskId, id) {
  const file = recordFile(hub, taskId, id);
  if (!fs.existsSync(file)) throw new Error('write_intent_not_found');
  const intent = read(file);
  const admissible = () => {
    const task = taskAt(hub, taskId);
    if (intent.id !== id || intent.task_id !== taskId || !task || task.project_id !== intent.project_id) throw new Error('write_scope_mismatch');
    if (task.status !== 'active') throw new Error('task_not_active');
  };
  admissible();
  const root = lookup(hub, intent.project_id);
  const result = check(hub, root, intent);
  const checked_at = new Date().toISOString();
  return withHubWriteLock(hub, () => {
    admissible();
    const current = read(file);
    if (current.check_revision !== intent.check_revision) throw new Error('verification_changed_retry');
    const evidence = { ...(root === lookup(hub, intent.project_id) ? result : unavailable('project_root_changed')), checked_at };
    writeJsonAtomic(file, { ...current, check_revision: current.check_revision + 1, last_check: evidence });
    return { task_id: taskId, id, relative_path: intent.relative_path, expected_sha256: intent.expected_sha256, ...evidence };
  });
}
