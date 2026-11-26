import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function normalizeProjectPath(input) {
  const win = /^[A-Za-z]:[\\/]/u.test(String(input)) || String(input).startsWith('\\\\');
  const normalized = win ? path.win32.normalize(String(input)).replaceAll('\\', '/') : path.resolve(String(input)).replaceAll('\\', '/');
  return win ? normalized.toLowerCase().replace(/\/$/u, '') : normalized.replace(/\/$/u, '');
}

function metadataLine(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8192) return '';
  const line = fs.readFileSync(file, 'utf8').trimEnd();
  return /[\r\n\0]/u.test(line) ? '' : line;
}

// This is a worktree hint, not object/commit validation. Do not run a Git
// subprocess on each turn, or inherit GIT_DIR from the host process.
function hasWorktreeMetadata(root, dotGit) {
  let gitDir = dotGit;
  if (!fs.statSync(dotGit).isDirectory()) {
    const pointer = /^gitdir: (.+)$/u.exec(metadataLine(dotGit));
    if (!pointer) return false;
    gitDir = path.resolve(root, pointer[1]);
  }
  const head = metadataLine(path.join(gitDir, 'HEAD'));
  if (!/^(?:ref: refs\/\S+|[a-f\d]{40}|[a-f\d]{64})$/iu.test(head)) return false;
  const commonFile = path.join(gitDir, 'commondir');
  let common = gitDir;
  if (fs.existsSync(commonFile)) {
    const target = metadataLine(commonFile);
    if (!target) return false;
    common = path.resolve(gitDir, target);
  }
  return ['objects', 'refs'].every(name => fs.statSync(path.join(common, name)).isDirectory());
}

function gitRootFromCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let current = path.resolve(cwd);
  while (true) {
    const dotGit = path.join(current, '.git');
    if (fs.existsSync(dotGit)) {
      return hasWorktreeMetadata(current, dotGit) ? current : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveGitProjectHint(cwd) {
  try {
    if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) return null;
    const root = gitRootFromCwd(cwd);
    if (!root) return null;
    const identity_key = normalizeProjectPath(root);
    const project_id = `p_${createHash('sha256').update(identity_key).digest('hex').slice(0, 20)}`;
    return { project_id, identity_key, canonical_root: root, name: path.basename(root), source: 'git_root' };
  } catch { return null; }
}
