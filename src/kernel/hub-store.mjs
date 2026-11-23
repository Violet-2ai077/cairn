import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createEmptyLedger, projectReadOnlyLedger } from './ledger.mjs';
import { normalizeTaskId, writeJsonAtomic, writeTextAtomic } from './store.mjs';
import { foldScopedLedger } from './scoped-ledger.mjs';

const SCOPES = new Set(['user', 'project']);
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function normalizedProjectId(value) {
  if (value === null || value === undefined || value === '' || value === 'general') return null;
  if (typeof value !== 'string' || !PROJECT_ID_RE.test(value)) throw new Error('invalid_project_id');
  return value;
}

function assertScope(scope, projectId) {
  if (!SCOPES.has(scope)) throw new Error('invalid_scope');
  const normalized = normalizedProjectId(projectId);
  if (scope === 'project' && !normalized) throw new Error('project_id_required');
  if (scope === 'user' && normalized) throw new Error('user_scope_project_id_forbidden');
  return normalized;
}

function readJson(file, fallback, errorCode) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    error.message = `${errorCode}:${error.message}`;
    throw error;
  }
}

export function resolveHubPaths(hubRoot) {
  if (typeof hubRoot !== 'string' || !hubRoot.trim()) throw new Error('store_root_required');
  const root = path.resolve(hubRoot);
  const userLedgerDir = path.join(root, 'user', 'ledger');
  const projectsDir = path.join(root, 'projects');
  const tasksDir = path.join(root, 'tasks');
  const sessionsDir = path.join(root, 'sessions');
  return Object.freeze({
    hubRoot: root,
    hubFile: path.join(root, 'hub.json'),
    userLedgerDir,
    userHeadFile: path.join(userLedgerDir, 'head.json'),
    userLedgerFile: path.join(userLedgerDir, 'ledger.jsonl'),
    userStagedFile: path.join(userLedgerDir, 'staged.json'),
    projectsDir,
    projectsIndexFile: path.join(projectsDir, 'index.json'),
    tasksDir,
    tasksIndexFile: path.join(tasksDir, 'index.json'),
    sessionsDir,
    projectDir(projectId) {
      const id = normalizedProjectId(projectId);
      if (!id) throw new Error('project_id_required');
      return path.join(projectsDir, id);
    },
    projectLedgerDir(projectId) {
      return path.join(this.projectDir(projectId), 'ledger');
    },
    ledgerPaths({ scope = 'user', projectId = null } = {}) {
      const normalized = assertScope(scope, projectId);
      const dir = scope === 'user' ? userLedgerDir : path.join(projectsDir, normalized, 'ledger');
      return Object.freeze({
        ledgerDir: dir,
        headFile: path.join(dir, 'head.json'),
        ledgerFile: path.join(dir, 'ledger.jsonl'),
        stagedFile: path.join(dir, 'staged.json'),
        scope,
        project_id: normalized
      });
    },
    taskDir(taskId) {
      return path.join(tasksDir, String(normalizeTaskId(taskId)));
    },
    taskThreadFile(taskId) {
      return path.join(this.taskDir(taskId), 'thread.jsonl');
    },
    taskCompactFile(taskId) {
      return path.join(this.taskDir(taskId), 'compact.md');
    },
    sessionBindingFile(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('session_id_required');
      const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
      return path.join(sessionsDir, `${key}.json`);
    }
  });
}

export function isHubInitialized(hubRoot) {
  const paths = resolveHubPaths(hubRoot);
  return [paths.hubFile, paths.userHeadFile, paths.userLedgerFile, paths.userStagedFile,
    paths.projectsIndexFile, paths.tasksIndexFile].every(file => fs.existsSync(file));
}

export function initHubStore(hubRoot, { createdAt = new Date().toISOString() } = {}) {
  const paths = resolveHubPaths(hubRoot);
  fs.mkdirSync(paths.userLedgerDir, { recursive: true });
  fs.mkdirSync(paths.projectsDir, { recursive: true });
  fs.mkdirSync(paths.tasksDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const createdFiles = [];
  const createIfMissing = (file, write) => {
    if (fs.existsSync(file)) return;
    write();
    createdFiles.push(file);
  };
  createIfMissing(paths.hubFile, () => writeJsonAtomic(paths.hubFile, { schema_version: 1, created_at: createdAt }));
  createIfMissing(paths.userHeadFile, () => writeJsonAtomic(paths.userHeadFile, createEmptyLedger()));
  createIfMissing(paths.userLedgerFile, () => writeTextAtomic(paths.userLedgerFile, ''));
  createIfMissing(paths.userStagedFile, () => writeJsonAtomic(paths.userStagedFile, emptyStaged()));
  createIfMissing(paths.projectsIndexFile, () => writeJsonAtomic(paths.projectsIndexFile, { schema_version: 1, next_project_seq: 1, projects: [] }));
  createIfMissing(paths.tasksIndexFile, () => writeJsonAtomic(paths.tasksIndexFile, { schema_version: 1, next_task_id: 1, tasks: [] }));
  return { initialized: true, created_files: createdFiles, paths };
}

function emptyStaged() {
  return { next_proposal_seq: 1, proposals: [] };
}

export function readProjectsIndex(hubRoot) {
  const file = resolveHubPaths(hubRoot).projectsIndexFile;
  const raw = readJson(file, { schema_version: 1, next_project_seq: 1, projects: [] }, 'projects_index_unreadable');
  const projects = Array.isArray(raw.projects) ? raw.projects.map(item => ({
    project_id: normalizedProjectId(item.project_id),
    name: String(item.name ?? item.project_id).trim() || item.project_id,
    identity_key: String(item.identity_key ?? ''),
    canonical_root: String(item.canonical_root ?? ''),
    created_at: item.created_at ?? null
  })).sort((a, b) => a.project_id.localeCompare(b.project_id)) : [];
  return { schema_version: 1, next_project_seq: Number.isSafeInteger(raw.next_project_seq) ? raw.next_project_seq : 1, projects };
}

export function registerProject(hubRoot, { project_id, name, identity_key = '', canonical_root = '', created_at } = {}) {
  if (!isHubInitialized(hubRoot)) initHubStore(hubRoot);
  const id = normalizedProjectId(project_id);
  if (!id) throw new Error('project_id_required');
  const index = readProjectsIndex(hubRoot);
  const existing = index.projects.find(project => project.project_id === id);
  if (existing) {
    if (identity_key && existing.identity_key && existing.identity_key !== identity_key) throw new Error('project_id_identity_conflict');
    const updated = { ...existing, name: name?.trim() || existing.name, identity_key: identity_key || existing.identity_key, canonical_root: canonical_root || existing.canonical_root };
    index.projects[index.projects.indexOf(existing)] = updated;
    writeJsonAtomic(resolveHubPaths(hubRoot).projectsIndexFile, index);
    return { project: updated, created: false };
  }
  const project = { project_id: id, name: String(name ?? id).trim() || id, identity_key, canonical_root, created_at: created_at ?? new Date().toISOString() };
  index.projects.push(project);
  index.projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  writeJsonAtomic(resolveHubPaths(hubRoot).projectsIndexFile, index);
  return { project, created: true };
}

export function ensureScopedLedger(hubRoot, { scope = 'user', projectId = null, project = null } = {}) {
  const normalized = assertScope(scope, projectId);
  if (!isHubInitialized(hubRoot)) initHubStore(hubRoot);
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId: normalized });
  if (scope === 'project') {
    if (project) registerProject(hubRoot, { project_id: normalized, ...project });
    else if (!readProjectsIndex(hubRoot).projects.some(item => item.project_id === normalized)) {
      registerProject(hubRoot, { project_id: normalized, name: normalized, identity_key: normalized });
    }
  }
  fs.mkdirSync(paths.ledgerDir, { recursive: true });
  if (!fs.existsSync(paths.headFile)) writeJsonAtomic(paths.headFile, createEmptyLedger());
  if (!fs.existsSync(paths.ledgerFile)) writeTextAtomic(paths.ledgerFile, '');
  if (!fs.existsSync(paths.stagedFile)) writeJsonAtomic(paths.stagedFile, emptyStaged());
  return paths;
}

export function readScopedHead(hubRoot, { scope = 'user', projectId = null } = {}) {
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId });
  return readJson(paths.headFile, createEmptyLedger(), 'scoped_head_unreadable');
}

export function readScopedLedgerLog(hubRoot, { scope = 'user', projectId = null } = {}) {
  const file = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId }).ledgerFile;
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/u).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`scoped_ledger_line_${index + 1}_invalid:${error.message}`); }
  });
}

export function readScopedStaged(hubRoot, { scope = 'user', projectId = null } = {}) {
  const file = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId }).stagedFile;
  const raw = readJson(file, emptyStaged(), 'scoped_staged_unreadable');
  return { next_proposal_seq: Number.isSafeInteger(raw.next_proposal_seq) ? raw.next_proposal_seq : 1, proposals: Array.isArray(raw.proposals) ? raw.proposals : [] };
}

export function stageScopedOperators(hubRoot, { scope = 'user', projectId = null, ops, source_step, actor_id = 'default', base_revision, created_at, project = null } = {}) {
  const paths = ensureScopedLedger(hubRoot, { scope, projectId, project });
  if (!Array.isArray(ops)) throw new Error('stage_operators_invalid_ops:expected_array');
  const staged = readScopedStaged(hubRoot, { scope, projectId });
  if (ops.length === 0) return { staged: false, reason: 'no_op', proposal: null, next_proposal_seq: staged.next_proposal_seq };
  const head = readScopedHead(hubRoot, { scope, projectId });
  const seq = staged.next_proposal_seq;
  const proposal = {
    proposal_id: `stg_${seq}`,
    scope,
    project_id: scope === 'project' ? normalizedProjectId(projectId) : null,
    created_at: created_at ?? new Date().toISOString(),
    source_step: source_step ?? `stage_${seq}`,
    actor_id: String(actor_id || 'default'),
    base_revision: base_revision ?? head.revision,
    ops,
    last_conflict: null,
    last_rejected_ops: null
  };
  staged.next_proposal_seq++;
  staged.proposals.push(proposal);
  writeJsonAtomic(paths.stagedFile, staged);
  return { staged: true, proposal, next_proposal_seq: staged.next_proposal_seq };
}

export function commitScopedStaged(hubRoot, { scope = 'user', projectId = null, proposal_id = null, actor_id = null, rebase = false, timestamp = null } = {}) {
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId });
  let head = readScopedHead(hubRoot, { scope, projectId });
  const initialRevision = head.revision;
  const staged = readScopedStaged(hubRoot, { scope, projectId });
  const log = readScopedLedgerLog(hubRoot, { scope, projectId });
  let commitSeq = log.length ? Math.max(...log.map((record, index) => Number.isSafeInteger(record.commit_seq) ? record.commit_seq : index + 1)) + 1 : 1;
  const selected = proposal_id === null ? staged.proposals : staged.proposals.filter(proposal => proposal.proposal_id === proposal_id);
  if (proposal_id !== null && selected.length === 0) return { committed: false, reason: 'proposal_not_found', conflict: false, commits: [], head, remaining_proposals: staged.proposals.length };
  if (selected.length === 0) return { committed: false, reason: 'nothing_to_commit', conflict: false, commits: [], head, remaining_proposals: 0 };
  const commits = [];
  for (const proposal of [...selected]) {
    const expectedScope = proposal.scope ?? scope;
    const expectedProject = proposal.project_id ?? null;
    if (expectedScope !== scope || expectedProject !== (scope === 'project' ? projectId : null)) {
      return { committed: commits.length > 0, reason: 'proposal_scope_mismatch', conflict: false, commits, head, remaining_proposals: staged.proposals.length };
    }
    if (!rebase && proposal.base_revision !== null && proposal.base_revision !== initialRevision) {
      proposal.last_conflict = { expected_base_revision: proposal.base_revision, actual_head_revision: initialRevision, detected_at: timestamp ?? new Date().toISOString() };
      writeJsonAtomic(paths.stagedFile, staged);
      return { committed: commits.length > 0, reason: 'base_revision_conflict', conflict: true, commits, head, remaining_proposals: staged.proposals.length };
    }
    const baseRevision = head.revision;
    const fold = foldScopedLedger(head, proposal.ops, { scope, project_id: projectId, source_step: proposal.source_step, actor_id: actor_id ?? proposal.actor_id, base_revision: baseRevision });
    if (fold.conflict || (fold.accepted_ops.length === 0 && fold.rejected_count > 0)) {
      proposal.last_conflict = fold.conflict ? { error: fold.conflict_error } : null;
      proposal.last_rejected_ops = fold.rejected_ops;
      writeJsonAtomic(paths.stagedFile, staged);
      return { committed: commits.length > 0, reason: fold.conflict ? 'base_revision_conflict' : 'all_operators_rejected', conflict: Boolean(fold.conflict), rejected_ops: fold.rejected_ops, commits, head, remaining_proposals: staged.proposals.length };
    }
    if (fold.accepted_ops.length === 0) {
      staged.proposals = staged.proposals.filter(item => item.proposal_id !== proposal.proposal_id);
      writeJsonAtomic(paths.stagedFile, staged);
      continue;
    }
    const commit = {
      commit_seq: commitSeq++, timestamp: timestamp ?? new Date().toISOString(), proposal_id: proposal.proposal_id,
      scope, project_id: scope === 'project' ? projectId : null, source_step: proposal.source_step,
      actor_id: fold.actor_id, base_revision: baseRevision, staged_base_revision: proposal.base_revision,
      new_revision: fold.ledger.revision, ops: proposal.ops, accepted_ops: fold.accepted_ops, rejected_ops: fold.rejected_ops
    };
    head = JSON.parse(JSON.stringify(fold.ledger));
    staged.proposals = staged.proposals.filter(item => item.proposal_id !== proposal.proposal_id);
    fs.appendFileSync(paths.ledgerFile, `${JSON.stringify(commit)}\n`, 'utf8');
    writeJsonAtomic(paths.headFile, head);
    writeJsonAtomic(paths.stagedFile, staged);
    commits.push(commit);
  }
  return { committed: commits.length > 0, reason: commits.length ? 'committed' : 'nothing_to_commit', conflict: false, commits, head, remaining_proposals: staged.proposals.length };
}

export function dropScopedStaged(hubRoot, { scope = 'user', projectId = null, proposal_id = null } = {}) {
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId });
  const staged = readScopedStaged(hubRoot, { scope, projectId });
  const before = staged.proposals.length;
  if (proposal_id === null) staged.proposals = [];
  else staged.proposals = staged.proposals.filter(proposal => proposal.proposal_id !== proposal_id);
  if (before !== staged.proposals.length) writeJsonAtomic(paths.stagedFile, staged);
  return { dropped: before !== staged.proposals.length, dropped_count: before - staged.proposals.length, remaining_proposals: staged.proposals.length, next_proposal_seq: staged.next_proposal_seq };
}

export function replayScopedLedger(hubRoot, { scope = 'user', projectId = null } = {}) {
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId });
  if (!fs.existsSync(paths.ledgerFile) || !fs.existsSync(paths.headFile)) return { valid: false, head_matches: false, commit_count: 0, mismatch_reason: 'ledger_not_initialized' };
  let ledger = createEmptyLedger();
  const records = readScopedLedgerLog(hubRoot, { scope, projectId });
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.scope !== scope || (record.project_id ?? null) !== (scope === 'project' ? projectId : null)) {
      return { valid: false, head_matches: false, commit_count: index, mismatch_reason: `scope_mismatch_at_commit_${index + 1}` };
    }
    const result = foldScopedLedger(ledger, record.ops, { scope, project_id: projectId, source_step: record.source_step, actor_id: record.actor_id, base_revision: ledger.revision });
    if (result.accepted_ops.length === 0 && result.rejected_count > 0) return { valid: false, head_matches: false, commit_count: index, mismatch_reason: `invalid_ops_at_commit_${index + 1}` };
    ledger = JSON.parse(JSON.stringify(result.ledger));
  }
  const disk = readScopedHead(hubRoot, { scope, projectId });
  const headMatches = JSON.stringify(ledger) === JSON.stringify(disk);
  return { valid: headMatches, head_matches: headMatches, commit_count: records.length, mismatch_reason: headMatches ? null : 'head_mismatch', ledger };
}

export function readHubTasksIndex(hubRoot) {
  const file = resolveHubPaths(hubRoot).tasksIndexFile;
  const raw = readJson(file, { schema_version: 1, next_task_id: 1, tasks: [] }, 'tasks_index_unreadable');
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map(task => ({
    id: normalizeTaskId(task.id), project_id: normalizedProjectId(task.project_id),
    title: String(task.title ?? '').trim() || `Task ${task.id}`, birth_turn: Number.isSafeInteger(task.birth_turn) ? task.birth_turn : 1,
    status: ['active', 'done', 'archived'].includes(task.status) ? task.status : 'active',
    turn_count: Number.isSafeInteger(task.turn_count) ? task.turn_count : 0,
    compacted_record_count: Number.isSafeInteger(task.compacted_record_count) ? task.compacted_record_count : 0,
    has_compact: Boolean(task.has_compact), updated_at: task.updated_at ?? null
  })).sort((a, b) => a.id - b.id) : [];
  return { schema_version: 1, next_task_id: Number.isSafeInteger(raw.next_task_id) ? raw.next_task_id : 1, tasks };
}

export function upsertHubTask(hubRoot, { id, project_id = null, title, birth_turn, status = 'active', updated_at, project = null } = {}) {
  if (!isHubInitialized(hubRoot)) initHubStore(hubRoot);
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const projectId = normalizedProjectId(project_id);
  if (projectId && !readProjectsIndex(hubRoot).projects.some(item => item.project_id === projectId)) {
    registerProject(hubRoot, { project_id: projectId, name: project?.name ?? projectId, identity_key: project?.identity_key ?? projectId, canonical_root: project?.canonical_root ?? '' });
  }
  if (projectId) ensureScopedLedger(hubRoot, { scope: 'project', projectId, project });
  const taskId = id === undefined || id === null ? index.next_task_id : normalizeTaskId(id);
  const existingIndex = index.tasks.findIndex(task => task.id === taskId);
  const now = updated_at ?? new Date().toISOString();
  if (existingIndex >= 0 && index.tasks[existingIndex].project_id !== projectId) throw new Error('task_project_id_immutable');
  if (existingIndex < 0 && status !== 'active') throw new Error('new_task_status_must_be_active');
  const task = existingIndex >= 0
    ? { ...index.tasks[existingIndex], title: title?.trim() || index.tasks[existingIndex].title, updated_at: now }
    : { id: taskId, project_id: projectId, title: title?.trim() || `Task ${taskId}`, birth_turn: birth_turn ?? 1, status, turn_count: 0, compacted_record_count: 0, has_compact: false, updated_at: now };
  if (existingIndex >= 0) index.tasks[existingIndex] = task;
  else { index.tasks.push(task); index.next_task_id = Math.max(index.next_task_id, taskId + 1); }
  index.tasks.sort((a, b) => a.id - b.id);
  fs.mkdirSync(paths.taskDir(taskId), { recursive: true });
  writeJsonAtomic(paths.tasksIndexFile, index);
  return { task, index };
}

export function appendHubTaskTurn(hubRoot, { task_id, project_id = null, turn, role = 'assistant', content = '', raw_content = null, meta = {}, timestamp } = {}) {
  const id = normalizeTaskId(task_id);
  const projectId = normalizedProjectId(project_id);
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const task = index.tasks.find(item => item.id === id);
  if (!task) throw new Error(`task_not_found:${id}`);
  if (task.project_id !== projectId) throw new Error(`task_project_mismatch:${id}`);
  if (task.status !== 'active') throw new Error(`task_not_active:${id}:${task.status}`);
  fs.mkdirSync(paths.taskDir(id), { recursive: true });
  const records = readHubTaskThread(hubRoot, id);
  const record = { seq: records.length + 1, turn: Number.isSafeInteger(turn) ? turn : records.length + 1, timestamp: timestamp ?? new Date().toISOString(), role, content, project_id: projectId, ...(raw_content !== null ? { raw_content } : {}), ...(Object.keys(meta ?? {}).length ? { meta } : {}) };
  fs.appendFileSync(paths.taskThreadFile(id), `${JSON.stringify(record)}\n`, 'utf8');
  const indexTask = index.tasks.find(item => item.id === id);
  indexTask.turn_count = record.seq;
  indexTask.updated_at = record.timestamp;
  writeJsonAtomic(paths.tasksIndexFile, index);
  return { record, task: indexTask };
}

export function readHubTaskThread(hubRoot, taskId) {
  const file = resolveHubPaths(hubRoot).taskThreadFile(taskId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`task_thread_line_${index + 1}_invalid:${error.message}`); }
  });
}

export function readHubTaskCompaction(hubRoot, taskId) {
  const file = resolveHubPaths(hubRoot).taskCompactFile(taskId);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function readSessionBinding(hubRoot, sessionId) {
  const file = resolveHubPaths(hubRoot).sessionBindingFile(sessionId);
  if (!fs.existsSync(file)) return null;
  const binding = readJson(file, null, 'session_binding_unreadable');
  if (binding?.session_id !== sessionId) throw new Error('session_binding_identity_mismatch');
  return { project_id: normalizedProjectId(binding.project_id), task_id: binding.task_id === null ? null : normalizeTaskId(binding.task_id), source: String(binding.source ?? 'explicit'), updated_at: binding.updated_at ?? null };
}

export function writeSessionBinding(hubRoot, sessionId, { project_id = null, task_id = null, source = 'explicit' } = {}) {
  const paths = resolveHubPaths(hubRoot);
  const projectId = normalizedProjectId(project_id);
  let normalizedTaskId = null;
  if (task_id !== null && task_id !== undefined) {
    normalizedTaskId = normalizeTaskId(task_id);
    const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === normalizedTaskId);
    if (!task) throw new Error(`task_not_found:${normalizedTaskId}`);
    if (task.status !== 'active') throw new Error(`task_not_active:${normalizedTaskId}:${task.status}`);
    if (task.project_id !== projectId) throw new Error('task_project_mismatch');
  }
  const binding = { session_id: sessionId, project_id: projectId, task_id: normalizedTaskId, source: String(source || 'explicit'), updated_at: new Date().toISOString() };
  writeJsonAtomic(paths.sessionBindingFile(sessionId), binding);
  return { ...binding };
}

export function clearSessionBinding(hubRoot, sessionId) {
  const file = resolveHubPaths(hubRoot).sessionBindingFile(sessionId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function clearBindingsForTask(hubRoot, taskId) {
  const paths = resolveHubPaths(hubRoot);
  let count = 0;
  for (const entry of fs.readdirSync(paths.sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(paths.sessionsDir, entry.name);
    try {
      const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (binding.task_id === taskId) { fs.unlinkSync(file); count++; }
    } catch { /* Doctor reports malformed session bindings; lifecycle must continue. */ }
  }
  return count;
}

export function transitionHubTaskStatus(hubRoot, { taskId, action, updatedAt } = {}) {
  const id = normalizeTaskId(taskId);
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const taskIndex = index.tasks.findIndex(task => task.id === id);
  if (taskIndex < 0) throw new Error(`task_not_found:${id}`);
  const task = index.tasks[taskIndex];
  const transitions = {
    close: { from: ['active'], to: 'done' },
    archive: { from: ['done'], to: 'archived' },
    reopen: { from: ['done', 'archived'], to: 'active' }
  };
  const transition = transitions[action];
  if (!transition) throw new Error(`invalid_task_lifecycle_action:${String(action)}`);
  if (!transition.from.includes(task.status)) throw new Error(`invalid_task_transition:${task.status}:${action}`);
  const nextTask = { ...task, status: transition.to, updated_at: updatedAt ?? new Date().toISOString() };
  index.tasks[taskIndex] = nextTask;
  const clearedBindings = transition.to !== 'active' ? clearBindingsForTask(hubRoot, id) : 0;
  writeJsonAtomic(paths.tasksIndexFile, index);
  return { task: nextTask, previous_status: task.status, status: transition.to, cleared_bindings: clearedBindings, index };
}

export function writeHubTaskCompaction(hubRoot, taskId, content, compactedRecordCount) {
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const task = index.tasks.find(item => item.id === normalizeTaskId(taskId));
  if (!task) throw new Error(`task_not_found:${taskId}`);
  if (task.status !== 'active') throw new Error(`task_not_active:${task.id}:${task.status}`);
  const thread = readHubTaskThread(hubRoot, task.id);
  if (!Number.isSafeInteger(compactedRecordCount) || compactedRecordCount < task.compacted_record_count || compactedRecordCount > thread.length) throw new Error('invalid_compacted_record_count');
  writeTextAtomic(paths.taskCompactFile(task.id), String(content));
  task.compacted_record_count = compactedRecordCount;
  task.has_compact = true;
  task.updated_at = new Date().toISOString();
  writeJsonAtomic(paths.tasksIndexFile, index);
  return task;
}

export { normalizedProjectId as normalizeProjectId, assertScope as validateLedgerScope, projectReadOnlyLedger };
