const DAY_MS = 86_400_000;
const byId = (a, b) => a.id - b.id;

export function resolveTaskHeatPolicy(autopilot = {}) {
  const config = autopilot?.taskHeat;
  const bounded = (value, fallback, min, max) =>
    Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    enabled: autopilot?.enabled === true && config?.enabled !== false,
    hotMaxTasks: bounded(config?.hotMaxTasks, 24, 1, 999),
    idleDays: bounded(config?.idleDays, 14, 1, 36500),
    dormantMaxCandidates: bounded(config?.dormantMaxCandidates, 5, 0, 999)
  };
}

export function selectHubTaskPools(tasks, { policy = resolveTaskHeatPolicy(), nowMs = Date.now() } = {}) {
  const active = tasks.filter(task => task.status === 'active');
  const excluded = tasks.filter(task => task.status !== 'active').sort(byId);
  if (!policy.enabled) return { hot: active.sort(byId), dormant: [], excluded };
  const cutoff = nowMs - policy.idleDays * DAY_MS;
  const hot = active.map(task => ({ task, at: Date.parse(task.last_activity_at) }))
    .filter(({ at }) => Number.isFinite(at) && at >= cutoff)
    .sort((a, b) => b.at - a.at || byId(a.task, b.task))
    .slice(0, policy.hotMaxTasks).map(({ task }) => task).sort(byId);
  const ids = new Set(hot.map(task => task.id));
  return { hot, dormant: active.filter(task => !ids.has(task.id)).sort(byId), excluded };
}

export function listHubTaskPools(tasks, options) {
  const pools = selectHubTaskPools(tasks, options);
  return Object.entries(pools).flatMap(([pool, items]) => items.map(task => ({ ...task, pool }))).sort(byId);
}
