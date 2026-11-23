import os from 'node:os';
import path from 'node:path';

export function resolveStoreRoot({ storeRoot, env = process.env, homeDir = os.homedir() } = {}) {
  if (typeof storeRoot === 'string' && storeRoot.trim()) return path.resolve(storeRoot);
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) return path.resolve(env.DSH_HOME, 'cairn');
  return path.resolve(homeDir, '.cairn');
}
