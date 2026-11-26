import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createEmptyLedger, projectReadOnlyLedger } from './ledger.mjs';
import { writeJsonAtomic, writeTextAtomic } from './store.mjs';
import { EXTENDED_TASK_CAPACITY, markerBank, markerAlias, normalizeHubTaskId as normalizeTaskId } from './hub-task-ids.mjs';
import { foldScopedLedger } from './scoped-ledger.mjs';
import { withHubWriteLock } from './hub-write-lock.mjs';
import { redactToolEvidence, redactToolOutput } from './tool-evidence.mjs';
import { planDecisionRevert, replayHubRecords } from './hub-ledger-replay.mjs';

const SCOPES = new Set(['user', 'project']);
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const locked = operation => (hubRoot, ...args) => withHubWriteLock(hubRoot, () => operation(hubRoot, ...args));

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

function hasHubLayout(paths) {
  if (fs.existsSync(paths.hubFile)) return true;
  // Unassigned turn receipts and picker state may predate the first filed task.
  return [path.dirname(paths.userLedgerDir), paths.projectsDir, paths.tasksDir].some(file => fs.existsSync(file));
}

function readRequiredJson(file, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))); }
  catch { throw new Error(code); }
}

function establishedHub(paths) {
  if (!hasHubLayout(paths)) return false;
  if (!isHubInitialized(paths.hubRoot)) throw new Error('hub_integrity:hub_layout_incomplete');
  if (readRequiredJson(paths.hubFile, 'hub_integrity:hub_metadata_invalid')?.schema_version !== 1) {
    throw new Error('hub_integrity:hub_schema_invalid');
  }
  return true;
}

export const initHubStore = locked(initHubStoreUnlocked);
function initHubStoreUnlocked(hubRoot, { createdAt = new Date().toISOString(), extendedTaskIds = false } = {}) {
  const paths = resolveHubPaths(hubRoot);
  if (establishedHub(paths)) {
    if (extendedTaskIds) {
      const index = readHubTasksIndex(hubRoot);
      if (!index.task_id_capacity) writeJsonAtomic(paths.tasksIndexFile, { ...index, task_id_capacity: EXTENDED_TASK_CAPACITY });
    }
    return { initialized: true, created_files: [], paths };
  }
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
  createIfMissing(paths.tasksIndexFile, () => writeJsonAtomic(paths.tasksIndexFile, { schema_version: 1, next_task_id: 1, tasks: [],
    ...(extendedTaskIds && { task_id_capacity: EXTENDED_TASK_CAPACITY }) }));
  return { initialized: true, created_files: createdFiles, paths };
}

function emptyStaged() {
  return { next_proposal_seq: 1, proposals: [] };
}

export function readProjectsIndex(hubRoot) {
  const paths = resolveHubPaths(hubRoot);
  if (!establishedHub(paths)) return { schema_version: 1, next_project_seq: 1, projects: [] };
  const raw = readRequiredJson(paths.projectsIndexFile, 'projects_index_unreadable');
  if (raw?.schema_version !== 1 || !Array.isArray(raw.projects) ||
      !Number.isSafeInteger(raw.next_project_seq) || raw.next_project_seq < 1) throw new Error('projects_index_invalid');
  const ids = new Set();
  for (const p of raw.projects) {
    if (!p || typeof p.project_id !== 'string' || !PROJECT_ID_RE.test(p.project_id) || p.project_id === 'general' ||
        ids.has(p.project_id) || typeof p.name !== 'string' || !p.name.trim() ||
        typeof p.identity_key !== 'string' || typeof p.canonical_root !== 'string') throw new Error('projects_index_invalid_entry');
    ids.add(p.project_id);
  }
  return { ...raw, projects: raw.projects.sort((a, b) => a.project_id.localeCompare(b.project_id)) };
}

export const registerProject = locked(registerProjectUnlocked);
function registerProjectUnlocked(hubRoot, { project_id, name, identity_key = '', canonical_root = '', created_at } = {}) {
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
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope: 'project', projectId: id });
  if (fs.existsSync(paths.ledgerDir)) throw new Error('ledger_integrity:unregistered_project_ledger');
  fs.mkdirSync(paths.ledgerDir, { recursive: true });
  writeJsonAtomic(paths.headFile, createEmptyLedger());
  writeTextAtomic(paths.ledgerFile, '');
  writeJsonAtomic(paths.stagedFile, emptyStaged());
  index.projects.push(project);
  index.projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  writeJsonAtomic(resolveHubPaths(hubRoot).projectsIndexFile, index);
  return { project, created: true };
}

export const ensureScopedLedger = locked(ensureScopedLedgerUnlocked);
function ensureScopedLedgerUnlocked(hubRoot, { scope = 'user', projectId = null, project = null } = {}) {
  const normalized = assertScope(scope, projectId);
  if (!isHubInitialized(hubRoot)) initHubStore(hubRoot);
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId: normalized });
  if (scope === 'project') {
    if (project) registerProject(hubRoot, { ...project, project_id: normalized });
    else if (!readProjectsIndex(hubRoot).projects.some(item => item.project_id === normalized)) {
      registerProject(hubRoot, { project_id: normalized, name: normalized, identity_key: normalized });
    }
  }
  if (![paths.headFile, paths.ledgerFile, paths.stagedFile].every(file => fs.existsSync(file))) {
    throw new Error('ledger_integrity:ledger_not_initialized');
  }
  return paths;
}

function readLedgerRecords(file) {
  const bytes = fs.readFileSync(file);
  if (!bytes.length) return [];
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) throw new Error('scoped_ledger_incomplete_line');
  return text.slice(0, -1).split(/\r?\n/u).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`scoped_ledger_line_${index + 1}_invalid:${error.message}`); }
  });
}

function readStagedSnapshot(paths) {
  const raw = readRequiredJson(paths.stagedFile, 'scoped_staged_unreadable');
  if (!raw || !Number.isSafeInteger(raw.next_proposal_seq) || raw.next_proposal_seq < 1) throw new Error('invalid_next_proposal_seq');
  if (!Array.isArray(raw.proposals)) throw new Error('invalid_staged_proposals');
  const ids = new Set();
  for (const p of raw.proposals) {
    if (typeof p?.proposal_id !== 'string' || !/^stg_[1-9]\d*$/u.test(p.proposal_id) ||
        Number(p.proposal_id.slice(4)) >= raw.next_proposal_seq || ids.has(p.proposal_id) ||
        p.scope !== paths.scope || p.project_id !== paths.project_id || !Array.isArray(p.ops) ||
        typeof p.source_step !== 'string' || !p.source_step.trim() || typeof p.actor_id !== 'string' ||
        !Number.isSafeInteger(p.base_revision) || p.base_revision < 0) throw new Error('invalid_staged_proposal');
    ids.add(p.proposal_id);
  }
  return raw;
}

export const stageScopedOperators = locked(stageScopedOperatorsUnlocked);
function stageScopedOperatorsUnlocked(hubRoot, { scope = 'user', projectId = null, ops, source_step, actor_id = 'default', base_revision, created_at, project = null, admission = null, extraction = null } = {}) {
  const paths = ensureScopedLedger(hubRoot, { scope, projectId, project });
  if (!Array.isArray(ops)) throw new Error('stage_operators_invalid_ops:expected_array');
  requireSyncedLedger(hubRoot, { scope, projectId });
  const staged = readScopedStaged(hubRoot, { scope, projectId });
  if (extraction) {
    const prior = readTurnReceipts(hubRoot, extraction.sessionId, extraction.turn);
    if (prior?.status !== 'archived' || prior.extraction?.[scope] !== 'pending') return { staged: false, reason: 'already_processed' };
    const existing = staged.proposals.find(p => p.extraction?.sessionId === extraction.sessionId && p.extraction.turn === extraction.turn);
    if (existing) return { staged: true, proposal: existing, reused: true };
  }
  if (ops.length === 0) return { staged: false, reason: 'no_op', proposal: null, next_proposal_seq: staged.next_proposal_seq };
  const head = readScopedHead(hubRoot, { scope, projectId });
  const seq = staged.next_proposal_seq;
  const proposal = {
    proposal_id: `stg_${seq}`,
    scope,
    project_id: scope === 'project' ? normalizedProjectId(projectId) : null,
    created_at: created_at ?? new Date().toISOString(),
    source_step: typeof source_step === 'string' && source_step.trim() ? source_step : `stage_${seq}`,
    actor_id: String(actor_id || 'default'),
    base_revision: base_revision ?? head.revision,
    ops,
    ...(extraction ? { extraction } : {}),
    last_conflict: null,
    last_rejected_ops: null,
    ...(admission ? { admission } : {})
  };
  staged.next_proposal_seq++;
  staged.proposals.push(proposal);
  writeJsonAtomic(paths.stagedFile, staged);
  return { staged: true, proposal, next_proposal_seq: staged.next_proposal_seq };
}

export const commitScopedStaged = locked(commitScopedStagedUnlocked);
function commitScopedStagedUnlocked(hubRoot, { scope = 'user', projectId = null, proposal_id = null, actor_id = null, rebase = false, timestamp = null, mode = 'manual', reviewKey = null } = {}) {
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId });
  const options = { scope, projectId };
  const initialized = fs.existsSync(paths.ledgerFile) || fs.existsSync(paths.headFile) || fs.existsSync(paths.stagedFile);
  const state = initialized ? requireSyncedLedger(hubRoot, options) : null;
  let head = state?.ledger ?? createEmptyLedger();
  const initialRevision = head.revision;
  const staged = readScopedStaged(hubRoot, { scope, projectId });
  let commitSeq = (state?.commit_count ?? 0) + 1;
  if (mode === 'auto' && (scope !== 'project' || !proposal_id || rebase)) {
    return { committed: false, reason: 'auto_commit_requires_project_proposal', conflict: false, commits: [], head };
  }
  const selected = staged.proposals.filter(p => (!p.admission?.review_key || (p.admission.review_key === reviewKey && p.proposal_id === proposal_id)) &&
    (proposal_id === null || p.proposal_id === proposal_id));
  if (!selected.length && staged.proposals.some(p => p.admission?.review_key && (!proposal_id || p.proposal_id === proposal_id))) {
    return { committed: false, reason: 'memory_review_required', conflict: false, commits: [], head, remaining_proposals: staged.proposals.length };
  }
  if (proposal_id !== null && selected.length === 0) return { committed: false, reason: 'proposal_not_found', conflict: false, commits: [], head, remaining_proposals: staged.proposals.length };
  if (selected.length === 0) return { committed: false, reason: 'nothing_to_commit', conflict: false, commits: [], head, remaining_proposals: 0 };
  const commits = [];
  for (const proposal of [...selected]) {
    if (mode === 'auto' && (proposal.admission?.eligible !== true || !Number.isSafeInteger(proposal.base_revision) ||
        !proposal.ops.every(op => op.op === 'ASSERT' || op.op === 'SUPERSEDE'))) {
      return { committed: false, reason: 'auto_commit_not_eligible', conflict: false, commits, head };
    }
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
    if (fold.conflict || (fold.rejected_count > 0 && (fold.accepted_ops.length === 0 || mode === 'auto'))) {
      proposal.last_conflict = fold.conflict ? { error: fold.conflict_error } : null;
      proposal.last_rejected_ops = fold.rejected_ops;
      writeJsonAtomic(paths.stagedFile, staged);
      return { committed: commits.length > 0, reason: fold.conflict ? 'base_revision_conflict' : mode === 'auto' ? 'auto_commit_fold_rejected' : 'all_operators_rejected', conflict: Boolean(fold.conflict), rejected_ops: fold.rejected_ops, commits, head, remaining_proposals: staged.proposals.length };
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
      new_revision: fold.ledger.revision, ops: proposal.ops, accepted_ops: fold.accepted_ops, rejected_ops: fold.rejected_ops,
      ...(mode === 'auto' ? { mode } : {})
    };
    head = JSON.parse(JSON.stringify(fold.ledger));
    markExtractionStaged(hubRoot, proposal);
    staged.proposals = staged.proposals.filter(item => item.proposal_id !== proposal.proposal_id);
    appendLedgerRecord(paths, commit);
    writeJsonAtomic(paths.headFile, head);
    writeJsonAtomic(paths.stagedFile, staged);
    commits.push(commit);
  }
  return { committed: commits.length > 0, reason: commits.length ? 'committed' : 'nothing_to_commit', conflict: false, commits, head, remaining_proposals: staged.proposals.length };
}

export const dropScopedStaged = locked(dropScopedStagedUnlocked);
function dropScopedStagedUnlocked(hubRoot, { scope = 'user', projectId = null, proposal_id = null, reviewKey = null } = {}) {
  const paths = resolveHubPaths(hubRoot).ledgerPaths({ scope, projectId });
  if ([paths.headFile, paths.ledgerFile, paths.stagedFile].some(file => fs.existsSync(file))) requireSyncedLedger(hubRoot, { scope, projectId });
  const staged = readScopedStaged(hubRoot, { scope, projectId });
  const before = staged.proposals.length;
  for (const p of staged.proposals) {
    if ((!proposal_id || p.proposal_id === proposal_id) && !p.admission?.review_key) markExtractionStaged(hubRoot, p);
  }
  staged.proposals = staged.proposals.filter(p => (p.admission?.review_key && (p.admission.review_key !== reviewKey || proposal_id !== p.proposal_id)) ||
    (proposal_id !== null && p.proposal_id !== proposal_id));
  if (before !== staged.proposals.length) writeJsonAtomic(paths.stagedFile, staged);
  return { dropped: before !== staged.proposals.length, dropped_count: before - staged.proposals.length, remaining_proposals: staged.proposals.length, next_proposal_seq: staged.next_proposal_seq };
}

function markExtractionStaged(root, proposal) {
  const key = proposal.extraction;
  if (key && readTurnReceipts(root, key.sessionId, key.turn)?.extraction?.[proposal.scope] === 'pending') {
    recordTurnReceipt(root, key.sessionId, key.turn, { extraction: { [proposal.scope]: 'staged' } });
  }
}

function appendLedgerRecord(paths, record) {
  fs.appendFileSync(paths.ledgerFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flush: true });
}

function inspectScopedLedger(hubRoot, { scope = 'user', projectId = null } = {}) {
  const hub = resolveHubPaths(hubRoot);
  const paths = hub.ledgerPaths({ scope, projectId });
  const invalid = reason => ({ valid: false, head_matches: false, commit_count: 0, mismatch_reason: reason });
  try {
    if (!establishedHub(hub) || (scope === 'project' && !readProjectsIndex(hubRoot).projects.some(p => p.project_id === projectId))) {
      if (fs.existsSync(paths.ledgerDir)) return invalid('unregistered_project_ledger');
      return { ...invalid('ledger_not_initialized'), absent: true };
    }
    if (![paths.ledgerFile, paths.headFile, paths.stagedFile].every(file => fs.existsSync(file))) return invalid('ledger_not_initialized');
    const disk = readRequiredJson(paths.headFile, 'scoped_head_unreadable');
    const records = readLedgerRecords(paths.ledgerFile);
    const replay = replayHubRecords(records, disk, { scope, projectId: paths.project_id });
    if (!replay.valid && replay.mismatch_reason !== 'materialization_pending') return replay;
    const staged = readStagedSnapshot(paths);
    const proposals = staged.proposals.filter(proposal => !replay.consumed.has(proposal.proposal_id));
    let nextSeq = staged.next_proposal_seq;
    for (const id of replay.consumed) nextSeq = Math.max(nextSeq, Number(id.slice(4)) + 1);
    const stagedPending = proposals.length !== staged.proposals.length || nextSeq !== staged.next_proposal_seq;
    return {
      ...replay, staged, records, valid: replay.valid && !stagedPending,
      mismatch_reason: stagedPending ? 'materialization_pending' : replay.mismatch_reason,
      pendingStaged: stagedPending ? { proposals, next_proposal_seq: nextSeq } : null
    };
  } catch (error) {
    return invalid(error.message.split(':')[0] || 'ledger_unreadable');
  }
}

function replayReport({ history, consumed, pendingStaged, staged, records, absent, ...report }) { return report; }

function verifiedRead(hubRoot, options) {
  const state = inspectScopedLedger(hubRoot, options);
  if (state.absent) return { ledger: createEmptyLedger(), staged: emptyStaged(), records: [] };
  if (!state.valid && state.mismatch_reason !== 'materialization_pending') {
    throw new Error(`ledger_integrity:${state.mismatch_reason}`);
  }
  return state;
}

export const readScopedHead = (root, options) => verifiedRead(root, options).ledger;
export const readScopedLedgerLog = (root, options) => verifiedRead(root, options).records;
export function readScopedStaged(root, options) {
  const state = verifiedRead(root, options);
  return state.pendingStaged ?? state.staged;
}

export function replayScopedLedger(hubRoot, options) {
  return replayReport(inspectScopedLedger(hubRoot, options));
}

function requireSyncedLedger(hubRoot, options) {
  const replay = inspectScopedLedger(hubRoot, options);
  if (replay.valid) return replay;
  if (replay.mismatch_reason !== 'materialization_pending') throw new Error(`ledger_integrity:${replay.mismatch_reason}`);
  const paths = resolveHubPaths(hubRoot).ledgerPaths(options);
  if (!replay.head_matches) writeJsonAtomic(paths.headFile, replay.ledger);
  if (replay.pendingStaged) writeJsonAtomic(paths.stagedFile, replay.pendingStaged);
  return { ...replay, valid: true, head_matches: true, mismatch_reason: null, synchronized: true };
}

export const syncScopedLedger = locked((hubRoot, options = {}) => replayReport(requireSyncedLedger(hubRoot, options)));

export function revertScopedCommit(hubRoot, options = {}) {
  if (options.preview) return revertScopedCommitUnlocked(hubRoot, options);
  return withHubWriteLock(hubRoot, () => revertScopedCommitUnlocked(hubRoot, options));
}

function revertScopedCommitUnlocked(hubRoot, { scope, projectId = null, commitSeq, reason, actorId = 'human', preview = false } = {}) {
  projectId = assertScope(scope, projectId);
  if (!Number.isSafeInteger(commitSeq) || commitSeq <= 0) throw new Error('invalid_revert_commit_seq');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('revert_reason_required');
  const options = { scope, projectId };
  const replay = preview ? inspectScopedLedger(hubRoot, options) : requireSyncedLedger(hubRoot, options);
  if (!replay.valid && replay.mismatch_reason !== 'materialization_pending') throw new Error(`ledger_integrity:${replay.mismatch_reason}`);
  const planned = planDecisionRevert(replay.history, replay.ledger, commitSeq, reason.trim());
  if (planned.status !== 'ready') return planned;
  const seq = replay.commit_count + 1;
  const source_step = `revert_${commitSeq}_at_${seq}`;
  const base_revision = replay.ledger.revision;
  const fold = foldScopedLedger(replay.ledger, planned.ops, {
    scope, project_id: projectId, actor_id: actorId, base_revision, source_step, allowDecisionRetraction: true
  });
  if (fold.rejected_count || !fold.accepted_ops.length) throw new Error('revert_fold_rejected');
  const commit = {
    kind: 'revert', version: 1, commit_seq: seq, reverts_commit_seq: commitSeq, reason: reason.trim(),
    scope, project_id: projectId, proposal_id: null, timestamp: new Date().toISOString(), source_step,
    actor_id: fold.actor_id, base_revision, new_revision: fold.ledger.revision, ops: planned.ops,
    accepted_ops: fold.accepted_ops, rejected_ops: fold.rejected_ops
  };
  if (!preview) {
    const paths = resolveHubPaths(hubRoot).ledgerPaths(options);
    appendLedgerRecord(paths, commit);
    writeJsonAtomic(paths.headFile, fold.ledger);
  }
  return { status: preview ? 'preview' : 'reverted', commit, head: fold.ledger };
}

export function readHubTasksIndex(hubRoot) {
  const paths = resolveHubPaths(hubRoot);
  if (!establishedHub(paths)) return { schema_version: 1, next_task_id: 1, tasks: [] };
  const raw = readRequiredJson(paths.tasksIndexFile, 'tasks_index_unreadable');
  if (raw?.schema_version !== 1 || !Array.isArray(raw.tasks) || !Number.isSafeInteger(raw.next_task_id) ||
      (Object.hasOwn(raw, 'task_id_capacity') && raw.task_id_capacity !== EXTENDED_TASK_CAPACITY) ||
      raw.next_task_id < 1 || raw.next_task_id > (raw.task_id_capacity ?? 999) + 1) throw new Error('tasks_index_invalid');
  const ids = new Set(), projects = new Set(readProjectsIndex(hubRoot).projects.map(p => p.project_id));
  for (const task of raw.tasks) {
    if (!task || !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= raw.next_task_id ||
        ids.has(task.id) || (task.project_id !== null && !projects.has(task.project_id)) ||
        typeof task.title !== 'string' || !task.title.trim() || !Number.isSafeInteger(task.birth_turn) || task.birth_turn < 0 ||
        !['active', 'done', 'archived'].includes(task.status) || !Number.isSafeInteger(task.turn_count) || task.turn_count < 0 ||
        !Number.isSafeInteger(task.compacted_record_count) || task.compacted_record_count < 0 ||
        task.compacted_record_count > task.turn_count || typeof task.has_compact !== 'boolean' ||
        (!task.has_compact && task.compacted_record_count > 0) ||
        (Object.hasOwn(task, 'compact_sha256') && (typeof task.compact_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(task.compact_sha256) || !task.has_compact))) throw new Error('tasks_index_invalid_entry');
    ids.add(task.id);
    // Legacy compaction overwrote updated_at, so it cannot date a compacted task.
    if (!Object.hasOwn(task, 'last_activity_at')) task.last_activity_at = !task.has_compact && task.turn_count > 0 ? task.updated_at ?? null : null;
  }
  return { ...raw, tasks: raw.tasks.sort((a, b) => a.id - b.id) };
}

export const upsertHubTask = locked(upsertHubTaskUnlocked);
function upsertHubTaskUnlocked(hubRoot, { id, project_id = null, title, birth_turn, status = 'active', updated_at, project = null, creation_turn_key = null } = {}) {
  if (!isHubInitialized(hubRoot)) initHubStore(hubRoot);
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const projectId = normalizedProjectId(project_id);
  if (id == null && index.next_task_id > (index.task_id_capacity ?? 999)) throw new Error('task_ids_exhausted');
  const taskId = normalizeTaskId(id ?? index.next_task_id);
  if (taskId > (index.task_id_capacity ?? 999)) throw new Error('invalid_task_id');
  const existingIndex = index.tasks.findIndex(task => task.id === taskId);
  if (existingIndex < 0 && taskId < index.next_task_id) throw new Error('task_id_below_allocation_cursor');
  if (projectId && !readProjectsIndex(hubRoot).projects.some(item => item.project_id === projectId)) {
    registerProject(hubRoot, { project_id: projectId, name: project?.name ?? projectId, identity_key: project?.identity_key ?? projectId, canonical_root: project?.canonical_root ?? '' });
  }
  if (projectId) ensureScopedLedger(hubRoot, { scope: 'project', projectId, project });
  const now = updated_at ?? new Date().toISOString();
  if (existingIndex >= 0 && index.tasks[existingIndex].project_id !== projectId) throw new Error('task_project_id_immutable');
  if (existingIndex < 0 && status !== 'active') throw new Error('new_task_status_must_be_active');
  const task = existingIndex >= 0
    ? { ...index.tasks[existingIndex], title: title?.trim() || index.tasks[existingIndex].title, updated_at: now }
    : { id: taskId, project_id: projectId, title: title?.trim() || `Task ${taskId}`, birth_turn: birth_turn ?? 1, status, turn_count: 0, compacted_record_count: 0, has_compact: false, updated_at: now, last_activity_at: null, ...(creation_turn_key ? { creation_turn_key } : {}) };
  if (existingIndex >= 0) index.tasks[existingIndex] = task;
  else { index.tasks.push(task); index.next_task_id = Math.max(index.next_task_id, taskId + 1); }
  index.tasks.sort((a, b) => a.id - b.id);
  fs.mkdirSync(paths.taskDir(taskId), { recursive: true });
  writeJsonAtomic(paths.tasksIndexFile, index);
  return { task, index };
}

export const appendHubTaskTurn = locked(appendHubTaskTurnUnlocked);
function updateTaskActivity(task, at) {
  const next = Date.parse(at);
  const current = Date.parse(task.last_activity_at);
  if (Number.isFinite(next) && (!Number.isFinite(current) || next >= current)) task.last_activity_at = at;
}

function isActivityRecord(record) {
  return ['user', 'assistant'].includes(record.role) && record.meta?.cairn_activity !== false;
}

function appendHubTaskTurnUnlocked(hubRoot, { task_id, project_id = null, turn, role = 'assistant', content = '', raw_content = null, meta = {}, timestamp } = {}) {
  if (Array.isArray(meta?.tools)) meta = { ...meta, tools: redactToolEvidence(meta.tools) };
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
  fs.appendFileSync(paths.taskThreadFile(id), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flush: true });
  const indexTask = index.tasks.find(item => item.id === id);
  indexTask.turn_count = record.seq;
  indexTask.updated_at = record.timestamp;
  if (isActivityRecord(record)) updateTaskActivity(indexTask, record.timestamp);
  writeJsonAtomic(paths.tasksIndexFile, index);
  return { record, task: indexTask };
}

export const appendHubTaskTurnPair = locked((hubRoot, { taskId, projectId, sessionId, turn, user, assistant, tools = [], activity = true, recovered = false }) => {
  const records = readHubTaskThread(hubRoot, taskId, { requireComplete: true });
  const turnRecords = records.filter(record => record.turn === turn && record.meta?.dsh_session_id === sessionId);
  const texts = { user, assistant };
  const roles = ['user', 'assistant'];
  for (const role of roles) {
    const matching = turnRecords.filter(record => record.role === role);
    if (matching.length > 1 || matching.some(record => record.content !== texts[role] || record.project_id !== projectId)) {
      throw new Error('hub_turn_redelivery_mismatch');
    }
  }
  const missing = roles.filter(role => !turnRecords.some(record => record.role === role));
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const task = index.tasks.find(item => item.id === taskId);
  if (!task || (missing.length && task.status !== 'active') || task.project_id !== projectId) throw new Error('task_invalidated');
  if (task.turn_count > records.length || records.some((record, i) => record.seq !== i + 1 || record.project_id !== projectId)) {
    throw new Error('task_thread_index_mismatch');
  }
  const priorSeq = records.length;
  for (const role of missing) {
    const meta = { dsh_session_id: sessionId, ...(activity ? {} : { cairn_activity: false }) };
    if (role === 'assistant' && tools.length) meta.tools = redactToolEvidence(tools);
    if (recovered) meta.attribution = 'manual_recovery';
    records.push({ seq: records.length + 1, turn, timestamp: new Date().toISOString(), role, content: texts[role], project_id: projectId, meta });
  }
  if (missing.length) {
    const file = paths.taskThreadFile(taskId);
    const prefix = priorSeq ? fs.readFileSync(file, 'utf8') : '';
    writeTextAtomic(file, prefix + records.slice(priorSeq).map(row => JSON.stringify(row) + '\n').join(''));
  }
  const lastRecord = records.at(-1);
  if (task.status === 'active' && task.turn_count < lastRecord.seq) {
    task.turn_count = lastRecord.seq;
    task.updated_at = lastRecord.timestamp;
    updateTaskActivity(task, records.findLast(isActivityRecord)?.timestamp);
    writeJsonAtomic(paths.tasksIndexFile, index);
  }
  return { appended: missing.length > 0, roles: missing, prior_seq: priorSeq, end_seq: records.length };
});

export function readHubTaskThread(hubRoot, taskId, { requireComplete = false } = {}) {
  const file = resolveHubPaths(hubRoot).taskThreadFile(taskId);
  if (!fs.existsSync(file)) return [];
  const text = requireComplete ? new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8');
  if (requireComplete && text && !text.endsWith('\n')) throw new Error('task_thread_incomplete_line');
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`task_thread_line_${index + 1}_invalid:${error.message}`); }
  });
}

export function readHubTaskCompaction(hubRoot, taskId) {
  const file = resolveHubPaths(hubRoot).taskCompactFile(taskId);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function readSessionBinding(hubRoot, sessionId, { includeCleared = false } = {}) {
  const file = resolveHubPaths(hubRoot).sessionBindingFile(sessionId);
  if (!fs.existsSync(file)) return null;
  const binding = readJson(file, null, 'session_binding_unreadable');
  if (binding?.session_id !== sessionId) throw new Error('session_binding_identity_mismatch');
  if (binding.cleared && !includeCleared) return null;
  const source = String(binding.source ?? 'explicit');
  return { project_id: normalizedProjectId(binding.project_id), task_id: binding.task_id === null ? null : normalizeTaskId(binding.task_id), source, updated_at: binding.updated_at ?? null,
    binding_epoch: binding.binding_epoch ?? binding.updated_at ?? 'legacy', explicit_pin: binding.explicit_pin ?? isExplicitBinding(source),
    ...(binding.cleared ? { cleared: true } : {}) };
}

const isExplicitBinding = source => ['explicit', 'slash_checkout', 'cli_checkout', 'tool_checkout'].includes(source);
export const writeSessionBinding = locked(writeSessionBindingUnlocked);
function writeSessionBindingUnlocked(hubRoot, sessionId, { project_id = null, task_id = null, source = 'explicit', bindingEpoch = randomUUID(), explicitPin = isExplicitBinding(source) } = {}) {
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
  const binding = { session_id: sessionId, project_id: projectId, task_id: normalizedTaskId, source: String(source || 'explicit'), updated_at: new Date().toISOString(),
    binding_epoch: bindingEpoch, explicit_pin: explicitPin };
  writeJsonAtomic(paths.sessionBindingFile(sessionId), binding);
  return { ...binding };
}

export const finishHubScopedTurn = locked((hubRoot, { sessionId, turn, scope, user, assistant, tools, receiptFields = {} }) => {
  const receipt = readTurnReceipts(hubRoot, sessionId, turn);
  if (receipt?.status === 'recovering' || receipt?.reason === 'manual_recovery') return { status: 'already_claimed' };
  const current = readSessionBinding(hubRoot, sessionId, { includeCleared: true });
  if ((current?.binding_epoch ?? null) !== scope.expectedEpoch && current?.binding_epoch !== scope.bindingEpoch) {
    return { status: 'epoch_conflict' };
  }
  const taskId = scope.taskId ?? scope.newTaskTicket?.taskId;
  if (scope.newTaskTicket && (scope.newTaskTicket.turnKey !== scope.turnKey || scope.taskId !== null)) return { status: 'invalid_ticket' };
  const index = readHubTasksIndex(hubRoot);
  if (index.task_id_capacity && (scope.markerAlias !== markerAlias(taskId) ||
      readSessionMarkerBank(hubRoot, sessionId) !== markerBank(taskId))) return { status: 'marker_bank_mismatch' };
  const task = index.tasks.find(item => item.id === taskId);
  let createTask = null;
  if (scope.newTaskTicket && task?.creation_turn_key !== scope.turnKey) {
    if (task || index.next_task_id !== taskId) return { status: 'ticket_conflict' };
    createTask = {
      id: taskId, project_id: scope.projectId, title: user.slice(0, 120), birth_turn: turn,
      project: scope.projectHint, creation_turn_key: scope.turnKey
    };
  }
  if (!createTask && (!task || task.project_id !== scope.projectId || task.status !== 'active')) return { status: 'task_invalidated' };
  return archiveHubTurn(hubRoot, { sessionId, turn, taskId, projectId: scope.projectId, user, assistant, tools, receiptFields, createTask,
    authoredUser: user, route: scope.modelSelection, sourceStep: `turn_${scope.turnKey}`, midSession: true,
    expectedEpoch: scope.expectedEpoch, bindingEpoch: scope.bindingEpoch, bindingSource: scope.bindingSource, explicitPin: scope.explicitPin });
});

function jobFile(root, { taskId, sessionId, turn }) {
  const hash = createHash('sha256').update(JSON.stringify([sessionId, turn])).digest('hex');
  return path.join(resolveHubPaths(root).taskDir(taskId), 'archive-jobs', hash + '.json');
}

// Task-local write-ahead intent: only an already confirmed answer reaches this point.
// Replaying it materializes Cairn files; it never invokes the primary assistant or a tool.
export const archiveHubTurn = locked((root, input) => {
  const { sessionId, turn, taskId, projectId } = input;
  if (!isHubInitialized(root)) initHubStoreUnlocked(root);
  const file = jobFile(root, input);
  const prior = readTurnReceipts(root, sessionId, turn);
  if (prior?.task_id != null && prior.task_id !== taskId) throw new Error('hub_turn_redelivery_mismatch');
  const existing = readJson(file, null, 'archive_job_unreadable');
  if (!existing && input.midSession === false && readHubTasksIndex(root).task_id_capacity) {
    recordTurnReceipt(root, sessionId, turn, { status: 'unassigned', reason: 'marker_bank_requires_turn_scope' });
    return { status: 'marker_bank_requires_turn_scope' };
  }
  const source = existing ?? input;
  const job = source.tools?.length ? { ...source, tools: redactToolEvidence(source.tools) } : source;
  if (job.user !== input.user || job.assistant !== input.assistant || job.projectId !== projectId) throw new Error('hub_turn_redelivery_mismatch');
  const pending = !prior || prior.status !== 'archived' || Object.values(prior.extraction ?? {}).includes('pending');
  if (pending && !existing) writeJsonAtomic(file, job);
  if (job.createTask) {
    if (job.createTask.id !== taskId || job.createTask.project_id !== projectId) throw new Error('archive_job_task_mismatch');
    const task = readHubTasksIndex(root).tasks.find(t => t.id === taskId);
    if (!task) upsertHubTaskUnlocked(root, job.createTask);
    else if (task.creation_turn_key !== job.createTask.creation_turn_key) throw new Error('archive_job_ticket_conflict');
  }
  const pair = appendHubTaskTurnPair(root, job);
  let binding = readSessionBinding(root, sessionId, { includeCleared: true });
  if (pending && (binding?.binding_epoch ?? null) === job.expectedEpoch && binding?.binding_epoch !== job.bindingEpoch &&
    readHubTasksIndex(root).tasks.some(t => t.id === taskId && t.status === 'active')) {
    binding = writeSessionBindingUnlocked(root, sessionId, { project_id: projectId, task_id: taskId,
      source: job.bindingSource, bindingEpoch: job.bindingEpoch, explicitPin: job.explicitPin });
  }
  recordTurnReceipt(root, sessionId, turn, { ...job.receiptFields, status: 'archived', reason: 'confirmed_marker', task_id: taskId,
    extraction: { [projectId ? 'project' : 'user']: 'pending', ...(job.extractUserDefault && { user: 'pending' }), ...prior?.extraction } });
  return { status: 'archived', ...pair, taskId, binding, job: pending ? job : null };
});

export function listArchiveJobs(root, onError = null) {
  const dir = resolveHubPaths(root).tasksDir;
  if (!fs.existsSync(dir)) return [];
  return withHubWriteLock(root, () => listArchiveJobsUnlocked(root, dir, onError));
}

function listArchiveJobsUnlocked(root, dir, onError) {
  const jobs = [];
  for (const task of fs.readdirSync(dir).filter(id => /^[1-9]\d{0,5}$/u.test(id) && Number(id) <= EXTENDED_TASK_CAPACITY)) {
    const folder = path.join(dir, task, 'archive-jobs');
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder).filter(n => /^[0-9a-f]{64}\.json$/u.test(n))) {
      const file = path.join(folder, name);
      try {
        const job = readJson(file, null, 'archive_job_unreadable');
        if (!job || typeof job.sessionId !== 'string' || !job.sessionId || !Number.isSafeInteger(job.turn) ||
            job.turn < 0 || job.taskId !== Number(task) || typeof job.user !== 'string' || typeof job.assistant !== 'string' ||
            jobFile(root, job) !== file) throw new Error('archive_job_invalid');
        jobs.push(job);
      } catch (error) {
        if (!onError) throw error;
        onError({ task_id: Number(task), code: 'archive_job_unreadable' });
      }
    }
  }
  return jobs.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.turn - b.turn);
}

export const finishArchiveJob = locked((root, job) => {
  const receipt = readTurnReceipts(root, job.sessionId, job.turn);
  if (receipt?.status === 'archived' && !Object.values(receipt.extraction).includes('pending')) {
    fs.rmSync(jobFile(root, job), { force: true });
  }
});

export const settleExtraction = locked((root, { sessionId, turn, scope, projectId, outcome }) => {
  if (readTurnReceipts(root, sessionId, turn)?.extraction?.[scope] !== 'pending') return;
  const staged = readScopedStaged(root, { scope, projectId }).proposals.some(p => p.extraction?.sessionId === sessionId && p.extraction.turn === turn);
  recordTurnReceipt(root, sessionId, turn, { extraction: { [scope]: staged ? 'staged' : outcome } });
});

function receiptDir(root, sessionId) {
  const binding = resolveHubPaths(root).sessionBindingFile(sessionId);
  return path.join(path.dirname(binding), 'turns', path.basename(binding, '.json'));
}

function markerBankFile(root, sessionId) {
  const binding = resolveHubPaths(root).sessionBindingFile(sessionId);
  return path.join(path.dirname(binding), 'marker-banks', path.basename(binding));
}

export function readSessionMarkerBank(root, sessionId) {
  const row = readJson(markerBankFile(root, sessionId), undefined, 'marker_bank_unreadable');
  if (row === undefined) return null;
  if (row?.session_id !== sessionId || !Number.isSafeInteger(row.bank) || row.bank < 0 ||
      row.bank > markerBank(EXTENDED_TASK_CAPACITY)) throw new Error('marker_bank_invalid');
  return row.bank;
}

// Claim before exposing any short marker. Clearing a checkout never clears this namespace.
export const claimSessionMarkerBank = locked((root, sessionId, taskId, { turn, nativeId, inheritedEventCount }) => {
  if (nativeId !== sessionId || inheritedEventCount !== 0) return false;
  const wanted = markerBank(taskId), prior = readSessionMarkerBank(root, sessionId);
  if (prior !== null) {
    const first = readTurnReceipts(root, sessionId, 1);
    return prior === wanted && (first ? first.marker_bank === prior : turn === 1);
  }
  if (turn !== 1 || readTurnReceipts(root, sessionId).length) return false;
  writeJsonAtomic(markerBankFile(root, sessionId), { session_id: sessionId, bank: wanted });
  return true;
});

function choiceFile(root, sessionId) {
  const binding = resolveHubPaths(root).sessionBindingFile(sessionId);
  return path.join(path.dirname(binding), 'choices', path.basename(binding));
}

export const readSessionChoice = (root, sessionId) => readJson(choiceFile(root, sessionId), null, 'task_choice_unreadable');

// A late UI answer cannot consume or replace a newer menu for this session.
export const replaceSessionChoice = locked((root, sessionId, expectedKey, choice) => {
  const current = readSessionChoice(root, sessionId);
  if ((current?.key ?? null) !== expectedKey) return false;
  if (choice) writeJsonAtomic(choiceFile(root, sessionId), choice);
  else fs.rmSync(choiceFile(root, sessionId), { force: true });
  return true;
});

export function readTurnReceipts(root, sessionId, turn = null) {
  const dir = receiptDir(root, sessionId);
  if (turn !== null) {
    if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('invalid_turn');
    return readJson(path.join(dir, turn + '.json'), null, 'turn_receipt_unreadable');
  }
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^\d+\.json$/u.test(name))
    .map(name => Number.parseInt(name, 10)).sort((a, b) => b - a).slice(0, 20)
    .map(n => readTurnReceipts(root, sessionId, n));
}

export const recordTurnReceipt = locked((root, sessionId, turn, fields) => {
  const prior = readTurnReceipts(root, sessionId, turn);
  if (prior?.reason === 'manual_recovery' || (prior?.status === 'recovering' && fields.reason !== 'manual_recovery')) return prior;
  if (prior && fields.status === 'in_progress') return prior;
  if (prior?.status === 'archived' && fields.status && fields.status !== 'archived') return prior;
  const receipt = { turn, ...prior, ...fields, extraction: { ...prior?.extraction, ...fields.extraction } };
  if (receipt.status === 'archived') delete receipt.observation_task_id;
  writeJsonAtomic(path.join(receiptDir(root, sessionId), turn + '.json'), receipt);
  if (receipt.status === 'archived' && prior?.observation_task_id) {
    fs.rmSync(observationFile(root, prior.observation_task_id, sessionId, turn), { force: true });
  }
  return receipt;
});

function observationFile(root, taskId, sessionId, turn) {
  const key = createHash('sha256').update(JSON.stringify([sessionId, turn])).digest('hex');
  return path.join(resolveHubPaths(root).taskDir(taskId), 'observations', key + '.json');
}

// Link first; publish the bounded excerpt atomically. Session receipts never carry tool output.
export const checkpointToolResult = locked((root, { taskId, projectId, bindingEpoch, source, request, tool }) => {
  const { host, session_id: id, turn, step, journal_seq: seq } = source;
  if (typeof host !== 'string' || !host || !Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) ||
      step < 1 || !Number.isSafeInteger(seq) || seq < 0 || typeof tool.ok !== 'boolean') return false;
  const binding = readSessionBinding(root, id);
  if (!bindingEpoch || binding?.binding_epoch !== bindingEpoch || binding.task_id !== taskId || binding.project_id !== projectId) return false;
  if (!readHubTasksIndex(root).tasks.some(t => t.id === taskId && t.project_id === projectId && t.status === 'active')) return false;
  const receipt = readTurnReceipts(root, id, turn);
  if (receipt?.status !== 'in_progress') return false;
  if (receipt.observation_task_id != null && receipt.observation_task_id !== taskId) return false;
  const file = observationFile(root, taskId, id, turn);
  const previous = readJson(file, null, 'observation_unreadable');
  if (previous && (previous.binding_epoch !== bindingEpoch || previous.source.journal_seq >= seq)) return false;
  if (receipt.observation_task_id == null) recordTurnReceipt(root, id, turn, { observation_task_id: taskId });
  const last_tool = { name: String(tool.name).slice(0, 128), ok: tool.ok, output: redactToolOutput(tool.output).slice(0, 500),
    ...(typeof tool.call_id === 'string' && tool.call_id && { call_id: tool.call_id }) };
  const history = observationTools(previous);
  history.push({ ...last_tool, step, journal_seq: seq });
  let omitted_tools = previous?.omitted_tools ?? 0;
  let omitted_journal_seq = previous?.omitted_journal_seq ?? null;
  if (history.length > 32) {
    const removed = history.splice(1, history.length - 32);
    omitted_journal_seq = { first: omitted_tools ? omitted_journal_seq?.first ?? null : removed[0].journal_seq,
      last: removed.at(-1).journal_seq };
    omitted_tools += removed.length;
  }
  writeJsonAtomic(file, {
    task_id: taskId, binding_epoch: bindingEpoch, observed_at: new Date().toISOString(),
    source: { host, session_id: id, turn, step, journal_seq: seq },
    request_excerpt: String(request).slice(0, 320),
    last_tool, tools: history, omitted_tools, ...(omitted_journal_seq && { omitted_journal_seq })
  });
  return true;
});

function observationTools(row) {
  return row?.tools ?? (row?.last_tool ? [{ ...row.last_tool, step: row.source.step, journal_seq: row.source.journal_seq }] : []);
}

export function readTaskObservations(root, taskId) {
  const dir = path.join(resolveHubPaths(root).taskDir(taskId), 'observations');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/u.test(n)).sort()) {
    let observation;
    try { observation = readJson(path.join(dir, name), null, 'observation_unreadable'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!observation || observation.task_id !== taskId) continue;
    const receipt = readTurnReceipts(root, observation.source.session_id, observation.source.turn);
    if (receipt?.observation_task_id !== taskId || receipt.status === 'archived') continue;
    const { request_excerpt, last_tool, source, observed_at } = observation;
    rows.push({ observed_at, request_excerpt, last_tool, source, tools: observationTools(observation),
      omitted_tools: observation.omitted_tools ?? 0, ...(observation.omitted_journal_seq && { omitted_journal_seq: observation.omitted_journal_seq }),
      turn_status: receipt.status, disposition: 'verify_before_retry' });
  }
  return rows.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
}

export const turnSourceDigest = (user, assistant) => createHash('sha256').update(JSON.stringify([user, assistant])).digest('hex');

export const recoverMarkerlessTurn = locked((root, sessionId, turn, taskId, source) => {
  const receipt = readTurnReceipts(root, sessionId, turn);
  if (receipt?.reason === 'manual_recovery' && receipt.task_id === taskId) return;
  if (!receipt || !['unassigned', 'recovering'].includes(receipt.status) || receipt.reason !== 'marker_missing' ||
      (receipt.status === 'recovering' && receipt.task_id !== taskId)) throw new Error('turn_not_recoverable');
  const index = readHubTasksIndex(root);
  if (index.task_id_capacity && (readSessionMarkerBank(root, sessionId) !== markerBank(taskId) ||
      receipt.marker_bank !== markerBank(taskId))) throw new Error('recovery_scope_mismatch');
  const task = index.tasks.find(item => item.id === taskId);
  if (!task || task.status !== 'active' || task.project_id !== receipt.project_id) throw new Error('recovery_scope_mismatch');
  if (!source || turnSourceDigest(source.user, source.assistant) !== receipt.source_digest) throw new Error('journal_mismatch');
  // Reserve the target before the first append: a crash can retry this target, never a second one.
  recordTurnReceipt(root, sessionId, turn, { status: 'recovering', task_id: taskId });
  appendHubTaskTurnPair(root, { ...source, sessionId, turn, taskId, projectId: task.project_id, activity: false, recovered: true });
  recordTurnReceipt(root, sessionId, turn, { status: 'archived', reason: 'manual_recovery', extraction: { [task.project_id ? 'project' : 'user']: 'not_requested' } });
});

export const bindHubRoutedTask = locked((hubRoot, { sessionId, taskId, projectId, source = 'cold_router_match', wake = false, at = new Date().toISOString() }) => {
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const task = index.tasks.find(item => item.id === normalizeTaskId(taskId));
  if (!task) throw new Error(`task_not_found:${taskId}`);
  if (task.status !== 'active') throw new Error(`task_not_active:${taskId}:${task.status}`);
  if (task.project_id !== normalizedProjectId(projectId)) throw new Error('task_project_mismatch');
  const binding = writeSessionBindingUnlocked(hubRoot, sessionId, { project_id: projectId, task_id: task.id, source });
  if (wake) {
    updateTaskActivity(task, at);
    writeJsonAtomic(paths.tasksIndexFile, index);
  }
  return binding;
});

export const clearSessionBinding = locked(clearSessionBindingUnlocked);
function clearSessionBindingUnlocked(hubRoot, sessionId) {
  const file = resolveHubPaths(hubRoot).sessionBindingFile(sessionId);
  if (!fs.existsSync(file)) return false;
  if (!readSessionBinding(hubRoot, sessionId)) return false;
  writeClearedBinding(file, sessionId);
  return true;
}

function writeClearedBinding(file, sessionId) {
  writeJsonAtomic(file, { session_id: sessionId, project_id: null, task_id: null, source: 'cleared',
    binding_epoch: randomUUID(), explicit_pin: false, cleared: true, updated_at: new Date().toISOString() });
}

function clearBindingsForTask(hubRoot, taskId) {
  const paths = resolveHubPaths(hubRoot);
  let count = 0;
  for (const entry of fs.readdirSync(paths.sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(paths.sessionsDir, entry.name);
    let binding;
    try { binding = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (binding?.task_id === taskId) { writeClearedBinding(file, binding.session_id); count++; }
  }
  return count;
}

export const transitionHubTaskStatus = locked(transitionHubTaskStatusUnlocked);
function transitionHubTaskStatusUnlocked(hubRoot, { taskId, action, updatedAt } = {}) {
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
  if (action === 'reopen') updateTaskActivity(nextTask, nextTask.updated_at);
  index.tasks[taskIndex] = nextTask;
  const clearedBindings = transition.to !== 'active' ? clearBindingsForTask(hubRoot, id) : 0;
  writeJsonAtomic(paths.tasksIndexFile, index);
  return { task: nextTask, previous_status: task.status, status: transition.to, cleared_bindings: clearedBindings, index };
}

export const writeHubTaskCompaction = locked(writeHubTaskCompactionUnlocked);
function writeHubTaskCompactionUnlocked(hubRoot, taskId, content, compactedRecordCount, { expected } = {}) {
  const paths = resolveHubPaths(hubRoot);
  const index = readHubTasksIndex(hubRoot);
  const task = index.tasks.find(item => item.id === normalizeTaskId(taskId));
  if (expected && (!task || task.status !== 'active' || task.compacted_record_count !== expected.count ||
      readHubTaskCompaction(hubRoot, task.id) !== expected.markdown)) return null;
  if (!task) throw new Error(`task_not_found:${taskId}`);
  if (task.status !== 'active') throw new Error(`task_not_active:${task.id}:${task.status}`);
  const thread = readHubTaskThread(hubRoot, task.id, { requireComplete: true });
  if (!Number.isSafeInteger(compactedRecordCount) || compactedRecordCount < task.compacted_record_count || compactedRecordCount > thread.length) throw new Error('invalid_compacted_record_count');
  const prior = readHubTaskCompaction(hubRoot, task.id);
  const priorDigest = prior === null ? null : createHash('sha256').update(prior).digest('hex');
  if (task.turn_count !== thread.length || task.has_compact !== (prior !== null) ||
      (task.compact_sha256 && task.compact_sha256 !== priorDigest)) throw new Error('task_history_inconsistent');
  if (prior !== null && !task.compact_sha256) {
    // Pin the old bytes before the first overwrite of a legacy compact. A
    // crash after replacing the markdown can no longer pair it with the old cursor.
    task.compact_sha256 = priorDigest;
    writeJsonAtomic(paths.tasksIndexFile, index);
  }
  writeTextAtomic(paths.taskCompactFile(task.id), String(content));
  task.compact_sha256 = createHash('sha256').update(String(content)).digest('hex');
  task.compacted_record_count = compactedRecordCount;
  task.has_compact = true;
  task.updated_at = new Date().toISOString();
  writeJsonAtomic(paths.tasksIndexFile, index);
  return task;
}

export { normalizedProjectId as normalizeProjectId, assertScope as validateLedgerScope, projectReadOnlyLedger };
