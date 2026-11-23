import fs from 'node:fs';
import path from 'node:path';
import { isHubInitialized, readHubTasksIndex, readProjectsIndex, replayScopedLedger, resolveHubPaths, readHubTaskThread } from '../kernel/index.mjs';

export function runHubDoctor({ hubRoot } = {}) {
  const paths = resolveHubPaths(hubRoot);
  const issues = [];
  if (!isHubInitialized(hubRoot)) issues.push({ code: 'hub_not_initialized' });
  const projects = readProjectsIndex(hubRoot);
  const tasks = readHubTasksIndex(hubRoot);
  const userReplay = replayScopedLedger(hubRoot, { scope: 'user' });
  if (!userReplay.valid) issues.push({ code: 'user_ledger_replay_mismatch', reason: userReplay.mismatch_reason });
  for (const project of projects.projects) {
    const replay = replayScopedLedger(hubRoot, { scope: 'project', projectId: project.project_id });
    if (!replay.valid) issues.push({ code: 'project_ledger_replay_mismatch', project_id: project.project_id, reason: replay.mismatch_reason });
  }
  for (const task of tasks.tasks) {
    if (!fs.existsSync(paths.taskThreadFile(task.id))) issues.push({ code: 'task_thread_missing', task_id: task.id });
    const count = readHubTaskThread(hubRoot, task.id).length;
    if (task.compacted_record_count > count) issues.push({ code: 'task_cursor_out_of_bounds', task_id: task.id, cursor: task.compacted_record_count, record_count: count });
    if (task.project_id && !projects.projects.some(p => p.project_id === task.project_id)) issues.push({ code: 'task_project_unregistered', task_id: task.id, project_id: task.project_id });
  }
  const registered = new Set(projects.projects.map(p => p.project_id));
  if (fs.existsSync(paths.projectsDir)) for (const dir of fs.readdirSync(paths.projectsDir, { withFileTypes: true })) {
    if (dir.isDirectory() && dir.name !== 'index.json' && !registered.has(dir.name) && fs.existsSync(path.join(paths.projectsDir, dir.name, 'ledger'))) issues.push({ code: 'orphan_project_ledger', project_id: dir.name });
  }
  return { ok: issues.length === 0, hub_initialized: isHubInitialized(hubRoot), project_count: projects.projects.length, task_count: tasks.tasks.length, issues };
}
