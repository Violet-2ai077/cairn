import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export function resolveWorkspaceDirectory(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, reason: 'workspace_cwd_missing' };
  }

  const rawPath = candidate.trim();
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  if (!pathApi.isAbsolute(rawPath)) {
    return { ok: false, reason: 'workspace_cwd_not_absolute' };
  }

  try {
    const root = realpathSync.native(pathApi.normalize(rawPath));
    if (!statSync(root).isDirectory()) {
      return { ok: false, reason: 'workspace_cwd_not_directory' };
    }
    const key = process.platform === 'win32'
      ? path.win32.normalize(root).replaceAll('/', '\\').replace(/[\\]+$/u, '').toLowerCase()
      : path.normalize(root);
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 8);
    return { ok: true, root, key, fingerprint };
  } catch {
    return { ok: false, reason: 'workspace_cwd_unavailable' };
  }
}
