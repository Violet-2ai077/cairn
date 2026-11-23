export function createHubWriteCoordinator() {
  const tails = new Map();
  const pending = new Set();
  function key({ scope = 'user', projectId = null } = {}) {
    if (scope === 'user') return 'user';
    if (scope !== 'project' || !projectId) throw new Error('invalid_hub_write_scope');
    return `project:${projectId}`;
  }
  function run(options, work) {
    if (typeof work !== 'function') throw new TypeError('work must be a function');
    const id = key(options);
    const previous = tails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    tails.set(id, next);
    pending.add(next);
    const cleanup = () => { pending.delete(next); if (tails.get(id) === next) tails.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }
  async function flush() { while (pending.size) await Promise.allSettled([...pending]); }
  return Object.freeze({ run, flush });
}
