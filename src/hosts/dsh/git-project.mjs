import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function normalizeProjectPath(input) {
  const win = /^[A-Za-z]:[\\/]/u.test(String(input)) || String(input).startsWith('\\\\');
  const normalized = win ? path.win32.normalize(String(input)).replaceAll('\\', '/') : path.resolve(String(input)).replaceAll('\\', '/');
  return win ? normalized.toLowerCase().replace(/\/$/u, '') : normalized.replace(/\/$/u, '');
}

function gitRootFromCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let current = path.resolve(cwd);
  while (true) {
    const dotGit = path.join(current, '.git');
    if (fs.existsSync(dotGit)) {
      if (fs.statSync(dotGit).isDirectory()) return current;
      const match = /^gitdir:\s*(.+)\s*$/imu.exec(fs.readFileSync(dotGit, 'utf8'));
      if (match) {
        const gitDir = path.resolve(current, match[1]);
          if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return null;
        const commonFile = path.join(gitDir, 'commondir');
        if (fs.existsSync(commonFile)) {
          const common = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim());
          const marker = path.join(common, 'config');
          if (fs.existsSync(marker)) return current;
        }
        return current;
      }
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
