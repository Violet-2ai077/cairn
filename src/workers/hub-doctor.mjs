import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isHubInitialized, readFileWrites, readHubTasksIndex, readProjectsIndex, replayScopedLedger, resolveHubPaths, readHubTaskThread } from '../kernel/index.mjs';
import { readSessionBinding, readSessionMarkerBank, readTaskObservations } from '../kernel/hub-store.mjs';
import { EXTENDED_TASK_CAPACITY, markerBank } from '../kernel/hub-task-ids.mjs';

function inspectReceipts(paths, observations, banks, inspect, issue) {
  const dir = path.join(paths.sessionsDir, 'turns');
  if (!fs.existsSync(dir)) return;
  for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!/^[a-f0-9]{24}$/u.test(session.name)) continue;
    const fields = { session_key: session.name };
    inspect('receipt_directory_unreadable', fields, () => {
      if (!session.isDirectory()) throw new Error('invalid_directory');
      const folder = path.join(dir, session.name);
      for (const name of fs.readdirSync(folder).filter(n => /^\d+\.json$/u.test(n))) {
        const turn = Number.parseInt(name, 10);
        inspect('turn_receipt_unreadable', { ...fields, turn }, () => {
          const r = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
          if (r.turn !== turn || typeof r.status !== 'string') throw new Error('invalid_receipt');
          if ((Object.hasOwn(r, 'marker_bank') && (!banks.has(session.name) || r.marker_bank !== banks.get(session.name))) ||
              (r.task_id > 999 && r.status === 'archived' && r.marker_bank !== markerBank(r.task_id))) {
            issue('receipt_marker_bank_mismatch', { ...fields, turn });
          }
          if (r.observation_task_id != null && !observations.has([r.observation_task_id, session.name, turn].join(':'))) {
            issue('receipt_observation_missing', { ...fields, turn, task_id: r.observation_task_id });
          }
        });
      }
    });
  }
}

export function runHubDoctor({ hubRoot } = {}) {
  const paths = resolveHubPaths(hubRoot), issues = [];
  const issue = (code, fields = {}) => issues.push({ code, ...fields });
  const inspect = (code, fields, fn) => {
    try { return fn(); } catch { issue(code, fields); return null; }
  };
  const initialized = isHubInitialized(hubRoot);
  if (!initialized) issue('hub_not_initialized');
  if (![paths.hubFile, paths.userLedgerDir, paths.projectsDir, paths.tasksDir, paths.sessionsDir].some(file => fs.existsSync(file))) {
    return { ok: false, hub_initialized: false, project_count: 0, task_count: 0, issues };
  }
  if (fs.existsSync(paths.hubFile)) inspect('hub_metadata_invalid', {}, () => {
    if (JSON.parse(fs.readFileSync(paths.hubFile, 'utf8')).schema_version !== 1) issue('hub_schema_unsupported');
  });
  function index(key, file, reader) {
    return inspect(key + '_index_unreadable', {}, () => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(raw[key]) || raw.schema_version !== 1) throw new Error('invalid_index');
      if (key === 'tasks' && raw.tasks.some(t => ['turn_count', 'compacted_record_count'].some(k =>
        Object.hasOwn(t, k) && (!Number.isSafeInteger(t[k]) || t[k] < 0)))) throw new Error('invalid_index_counter');
      if (key === 'tasks') {
        if (!Number.isSafeInteger(raw.next_task_id) || raw.next_task_id < 1 || raw.tasks.some(t => Number(t.id) >= raw.next_task_id)) issue('task_next_id_invalid');
        for (const t of raw.tasks) if (Object.hasOwn(t, 'status') && !['active', 'done', 'archived'].includes(t.status)) {
          issue('task_status_invalid', { task_id: Number(t.id) });
        }
      }
      try { return reader(hubRoot)[key]; }
      catch (error) {
        if (key !== 'tasks') throw error;
        issue('tasks_index_unreadable');
        // A diagnostic may inspect safe task paths without granting invalid rows authority.
        return raw.tasks.filter(t => Number.isSafeInteger(t?.id) && t.id >= 1 && t.id <= EXTENDED_TASK_CAPACITY);
      }
    });
  }
  const projects = index('projects', paths.projectsIndexFile, readProjectsIndex);
  const tasks = index('tasks', paths.tasksIndexFile, readHubTasksIndex);
  function ledger(scope, projectId = null) {
    const fields = projectId ? { project_id: projectId } : {};
    inspect(scope + '_ledger_unreadable', fields, () => {
      const replay = replayScopedLedger(hubRoot, { scope, projectId });
      if (!replay.valid) {
        const reason = replay.mismatch_reason?.split(':', 1)[0];
        issue(scope + (reason === 'materialization_pending' ? '_ledger_sync_pending' : '_ledger_replay_mismatch'), { ...fields, reason });
      }
    });
  }
  ledger('user');
  for (const project of projects ?? []) ledger('project', project.project_id);
  const observations = new Set();
  for (const task of tasks ?? []) {
    const fields = { task_id: task.id };
    if (!fs.existsSync(paths.taskDir(task.id))) issue('task_dir_missing', fields);
    // A new task has a directory but no thread until its first record is appended.
    if (task.turn_count > 0 && !fs.existsSync(paths.taskThreadFile(task.id))) issue('task_thread_missing', fields);
    inspect('task_thread_unreadable', fields, () => {
      const rows = readHubTaskThread(hubRoot, task.id, { requireComplete: true }), count = rows.length;
      if (task.turn_count !== count) issue('task_record_count_mismatch', { ...fields, indexed_count: task.turn_count, record_count: count });
      if (task.compacted_record_count < 0 || task.compacted_record_count > count) {
        issue('task_cursor_out_of_bounds', { ...fields, cursor: task.compacted_record_count, record_count: count });
      }
      const bad = rows.findIndex((r, i) => r?.seq !== i + 1 || r.project_id !== task.project_id);
      if (bad !== -1) issue('task_record_identity_mismatch', { ...fields, record_number: bad + 1 });
    });
    const compactExists = fs.existsSync(paths.taskCompactFile(task.id));
    if (compactExists && task.compact_sha256) inspect('task_compact_unreadable', fields, () => {
      if (createHash('sha256').update(fs.readFileSync(paths.taskCompactFile(task.id))).digest('hex') !== task.compact_sha256)
        issue('task_compact_digest_mismatch', fields);
    });
    if ((task.has_compact || task.compacted_record_count > 0) && !compactExists) issue('task_compact_missing', fields);
    if (!task.has_compact && (compactExists || task.compacted_record_count > 0)) issue('task_compact_index_mismatch', fields);
    inspect('task_observations_unreadable', fields, () => {
      for (const row of readTaskObservations(hubRoot, task.id)) {
        const session = path.basename(paths.sessionBindingFile(row.source.session_id), '.json');
        observations.add([task.id, session, row.source.turn].join(':'));
      }
    });
    inspect('task_file_writes_unreadable', fields, () => {
      for (const w of readFileWrites(hubRoot, task.id)) {
        if (w.task_id !== task.id || w.project_id !== task.project_id || !/^[a-f0-9]{64}$/u.test(w.id) ||
          !/^[a-f0-9]{64}$/u.test(w.expected_sha256) || typeof w.relative_path !== 'string' ||
          !fs.existsSync(path.join(paths.taskDir(task.id), 'file-writes', w.id + '.json'))) {
          issue('task_file_write_identity_invalid', fields);
          break;
        }
      }
    });
    if (projects && task.project_id && !projects.some(p => p.project_id === task.project_id)) issue('task_project_unregistered', fields);
  }
  const banks = new Map(), bankDir = path.join(paths.sessionsDir, 'marker-banks');
  if (fs.existsSync(bankDir)) inspect('marker_banks_unreadable', {}, () => {
    for (const name of fs.readdirSync(bankDir)) inspect('session_marker_bank_invalid', {}, () => {
      const row = JSON.parse(fs.readFileSync(path.join(bankDir, name), 'utf8'));
      if (path.basename(paths.sessionBindingFile(row.session_id)) !== name) throw new Error('identity_mismatch');
      banks.set(path.basename(name, '.json'), readSessionMarkerBank(hubRoot, row.session_id));
    });
  });
  if (tasks) inspect('receipts_unreadable', {}, () => inspectReceipts(paths, observations, banks, inspect, issue));
  if (tasks && fs.existsSync(paths.sessionsDir)) inspect('sessions_dir_unreadable', {}, () => {
    const byId = new Map(tasks.map(task => [task.id, task]));
    for (const name of fs.readdirSync(paths.sessionsDir).filter(name => /^[a-f0-9]{24}\.json$/u.test(name))) {
      const fields = { session_key: path.basename(name, '.json') };
      inspect('session_binding_unreadable', fields, () => {
        const { session_id: id } = JSON.parse(fs.readFileSync(path.join(paths.sessionsDir, name), 'utf8'));
        if (path.basename(paths.sessionBindingFile(id)) !== name) throw new Error('identity_mismatch');
        const binding = readSessionBinding(hubRoot, id);
        if (binding?.task_id != null) {
          const task = byId.get(binding.task_id);
          if (task?.status !== 'active' || task.project_id !== binding.project_id) issue('session_binding_stale', { ...fields, task_id: binding.task_id });
        }
      });
    }
  });
  if (projects && fs.existsSync(paths.projectsDir)) inspect('projects_dir_unreadable', {}, () => {
    const known = new Set(projects.map(p => p.project_id));
    for (const dir of fs.readdirSync(paths.projectsDir, { withFileTypes: true })) {
      if (dir.isDirectory() && !known.has(dir.name) && fs.existsSync(path.join(paths.projectsDir, dir.name, 'ledger'))) {
        issue('orphan_project_ledger', { project_id: dir.name });
      }
    }
  });
  if (tasks && fs.existsSync(paths.tasksDir)) inspect('tasks_dir_unreadable', {}, () => {
    const known = new Set(tasks.map(t => String(t.id)));
    for (const dir of fs.readdirSync(paths.tasksDir, { withFileTypes: true })) {
      if (dir.isDirectory() && /^[1-9]\d*$/u.test(dir.name) && !known.has(dir.name)) issue('orphan_task_directory', { task_id: Number(dir.name) });
    }
  });
  return { ok: !issues.length, hub_initialized: initialized, project_count: projects?.length ?? 0, task_count: tasks?.length ?? 0, issues };
}
