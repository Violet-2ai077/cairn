// Cairn Kernel: Local-First .cairn/ Disk Persistence & Replay Engine (src/kernel/store.mjs)
// Zero external dependencies, zero LLM calls, zero host runtime imports.
// Enforces commit persistence ordering (ledger.jsonl -> head.json -> staged.json),
// monotonic proposal IDs (next_proposal_seq), and batch optimistic concurrency guards.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  createEmptyLedger,
  foldLedger,
  projectReadOnlyLedger
} from './ledger.mjs';
import { buildLightTaskCatalog } from './marker.mjs';

let atomicTempCounter = 0;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

/**
 * Atomically writes UTF-8 text to `filePath` using a same-directory temporary file
 * and `fs.renameSync`, with bounded retries for Windows EPERM/EBUSY file-locking contention.
 */
export function writeTextAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `.${path.basename(filePath)}.tmp.${process.pid}.${++atomicTempCounter}`;
  const tmpPath = path.join(dir, tmpName);
  fs.writeFileSync(tmpPath, content, 'utf8');

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const retryable =
        err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (retryable && attempt < maxAttempts) {
        sleepSync(10 * attempt);
        continue;
      }
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }
}

export function writeJsonAtomic(filePath, data) {
  writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function resolveCairnPaths(workspaceRoot = process.cwd()) {
  const rootDir = path.resolve(workspaceRoot);
  const cairnDir = path.join(rootDir, '.cairn');
  const tasksDir = path.join(cairnDir, 'tasks');

  return Object.freeze({
    workspaceRoot: rootDir,
    cairnDir,
    headFile: path.join(cairnDir, 'head.json'),
    ledgerFile: path.join(cairnDir, 'ledger.jsonl'),
    stagedFile: path.join(cairnDir, 'staged.json'),
    tasksDir,
    tasksIndexFile: path.join(tasksDir, 'index.json'),
    taskDir(taskId) {
      return path.join(tasksDir, String(taskId));
    },
    taskThreadFile(taskId) {
      return path.join(tasksDir, String(taskId), 'thread.jsonl');
    },
    taskCompactFile(taskId) {
      return path.join(tasksDir, String(taskId), 'compact.md');
    }
  });
}

export function normalizeTaskId(rawId) {
  const str = String(rawId ?? '').trim();
  if (!/^[1-9][0-9]{0,2}$/.test(str)) {
    throw new Error(`invalid_task_id:${String(rawId)} (expected integer 1..999)`);
  }
  return Number.parseInt(str, 10);
}

export function isCairnInitialized(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  return (
    fs.existsSync(paths.headFile) &&
    fs.existsSync(paths.ledgerFile) &&
    fs.existsSync(paths.stagedFile) &&
    fs.existsSync(paths.tasksIndexFile)
  );
}

/**
 * Idempotently initializes the `.cairn/` directory layout.
 */
export function initCairnStore(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  fs.mkdirSync(paths.cairnDir, { recursive: true });
  fs.mkdirSync(paths.tasksDir, { recursive: true });

  const createdFiles = [];

  if (!fs.existsSync(paths.headFile)) {
    writeJsonAtomic(paths.headFile, createEmptyLedger());
    createdFiles.push(paths.headFile);
  }

  if (!fs.existsSync(paths.ledgerFile)) {
    writeTextAtomic(paths.ledgerFile, '');
    createdFiles.push(paths.ledgerFile);
  }

  if (!fs.existsSync(paths.stagedFile)) {
    writeJsonAtomic(paths.stagedFile, {
      next_proposal_seq: 1,
      proposals: []
    });
    createdFiles.push(paths.stagedFile);
  }

  if (!fs.existsSync(paths.tasksIndexFile)) {
    writeJsonAtomic(paths.tasksIndexFile, {
      work_anchor_task_id: null,
      tasks: []
    });
    createdFiles.push(paths.tasksIndexFile);
  }

  return {
    initialized: true,
    created_files: createdFiles,
    paths,
    head: readHead(workspaceRoot)
  };
}

export function readHead(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  if (!fs.existsSync(paths.headFile)) {
    throw new Error(`cairn_not_initialized:${paths.cairnDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(paths.headFile, 'utf8'));
  return {
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    last_actor_id: raw.last_actor_id ?? null,
    next_decision_num: typeof raw.next_decision_num === 'number' ? raw.next_decision_num : 1,
    next_question_num: typeof raw.next_question_num === 'number' ? raw.next_question_num : 1,
    active: Array.isArray(raw.active) ? raw.active : [],
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones : [],
    open_questions: Array.isArray(raw.open_questions) ? raw.open_questions : []
  };
}

export function readLedgerLog(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  if (!fs.existsSync(paths.ledgerFile)) {
    throw new Error(`cairn_not_initialized:${paths.cairnDir}`);
  }
  const text = fs.readFileSync(paths.ledgerFile, 'utf8').trim();
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  return lines
    .map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`ledger_jsonl_parse_error:line_${idx + 1}:${err.message}`);
      }
    })
    .filter(Boolean);
}

function deepEqualPlain(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministically replays `.cairn/ledger.jsonl` from `createEmptyLedger()`
 * and verifies every commit transition as well as final equivalence with `.cairn/head.json`.
 */
export function replayLedger(workspaceRoot = process.cwd(), { repairHead = false } = {}) {
  const paths = resolveCairnPaths(workspaceRoot);
  const records = readLedgerLog(workspaceRoot);
  const currentHead = readHead(workspaceRoot);

  let workingLedger = createEmptyLedger();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const stepNo = i + 1;

    if (rec.base_revision !== undefined && rec.base_revision !== workingLedger.revision) {
      return {
        valid: false,
        commit_count: records.length,
        failed_commit_seq: rec.commit_seq ?? stepNo,
        mismatch_reason: `commit_${stepNo}_base_revision_mismatch:expected_${workingLedger.revision}_got_${rec.base_revision}`,
        head_matches: false,
        repaired: false,
        replayed_ledger: workingLedger
      };
    }

    const foldRes = foldLedger(workingLedger, rec.ops, {
      source_step: rec.source_step,
      actor_id: rec.actor_id,
      base_revision: workingLedger.revision
    });

    if (foldRes.conflict) {
      return {
        valid: false,
        commit_count: records.length,
        failed_commit_seq: rec.commit_seq ?? stepNo,
        mismatch_reason: `commit_${stepNo}_replay_conflict:${foldRes.conflict_error}`,
        head_matches: false,
        repaired: false,
        replayed_ledger: workingLedger
      };
    }

    if (rec.new_revision !== undefined && foldRes.ledger.revision !== rec.new_revision) {
      return {
        valid: false,
        commit_count: records.length,
        failed_commit_seq: rec.commit_seq ?? stepNo,
        mismatch_reason: `commit_${stepNo}_new_revision_mismatch:expected_${rec.new_revision}_got_${foldRes.ledger.revision}`,
        head_matches: false,
        repaired: false,
        replayed_ledger: foldRes.ledger
      };
    }

    if (Array.isArray(rec.accepted_ops) && !deepEqualPlain(foldRes.accepted_ops, rec.accepted_ops)) {
      return {
        valid: false,
        commit_count: records.length,
        failed_commit_seq: rec.commit_seq ?? stepNo,
        mismatch_reason: `commit_${stepNo}_accepted_ops_mismatch`,
        head_matches: false,
        repaired: false,
        replayed_ledger: foldRes.ledger
      };
    }

    workingLedger = foldRes.ledger;
  }

  const plainReplayed = JSON.parse(JSON.stringify(workingLedger));
  const plainHead = JSON.parse(JSON.stringify(currentHead));
  const headMatches = deepEqualPlain(plainReplayed, plainHead);

  let repaired = false;
  if (!headMatches && repairHead) {
    writeJsonAtomic(paths.headFile, plainReplayed);
    repaired = true;
  }

  return {
    valid: headMatches || repaired,
    commit_count: records.length,
    failed_commit_seq: null,
    mismatch_reason: headMatches ? null : 'head_json_diverged_from_ledger_jsonl',
    head_matches: headMatches,
    repaired,
    replayed_ledger: plainReplayed
  };
}

function computeNextProposalSeq(rawNextSeq, proposals) {
  let maxExisting = 0;
  for (const p of proposals) {
    const match = /^stg_(\d+)$/.exec(String(p?.proposal_id ?? ''));
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > maxExisting) {
        maxExisting = num;
      }
    }
  }
  const candidate =
    typeof rawNextSeq === 'number' && Number.isInteger(rawNextSeq) && rawNextSeq >= 1
      ? rawNextSeq
      : 1;
  return Math.max(candidate, maxExisting + 1);
}

/**
 * Reads and normalizes `.cairn/staged.json`.
 * Preserves monotonic `next_proposal_seq` across drops and commits.
 */
export function readStaged(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  if (!fs.existsSync(paths.stagedFile)) {
    throw new Error(`cairn_not_initialized:${paths.cairnDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(paths.stagedFile, 'utf8'));

  // Support manual shorthand `{"ops":[...]}` written directly to staged.json
  if ( !Array.isArray(raw.proposals) && Array.isArray(raw.ops)) {
    if (raw.ops.length === 0) {
      return {
        next_proposal_seq: computeNextProposalSeq(raw.next_proposal_seq, []),
        proposals: []
      };
    }
    const seq = computeNextProposalSeq(raw.next_proposal_seq, []);
    const syntheticProposal = {
      proposal_id: `stg_${seq}`,
      created_at: raw.created_at ?? new Date().toISOString(),
      source_step: raw.source_step ?? 'manual_stage',
      actor_id:
        typeof raw.actor_id === 'string' && raw.actor_id.trim() ? raw.actor_id.trim() : 'default',
      base_revision: raw.base_revision ?? null,
      ops: raw.ops,
      last_conflict: null,
      last_rejected_ops: null
    };
    return {
      next_proposal_seq: seq + 1,
      proposals: [syntheticProposal]
    };
  }

  const proposals = Array.isArray(raw.proposals)
    ? raw.proposals.map((p, idx) => ({
        proposal_id: p.proposal_id ?? `stg_${idx + 1}`,
        created_at: p.created_at ?? new Date().toISOString(),
        source_step: p.source_step ?? `stage_${idx + 1}`,
        actor_id:
          typeof p.actor_id === 'string' && p.actor_id.trim() ? p.actor_id.trim() : 'default',
        base_revision: p.base_revision !== undefined ? p.base_revision : null,
        ops: Array.isArray(p.ops) ? p.ops : [],
        last_conflict: p.last_conflict ?? null,
        last_rejected_ops: p.last_rejected_ops ?? null
      }))
    : [];

  return {
    next_proposal_seq: computeNextProposalSeq(raw.next_proposal_seq, proposals),
    proposals
  };
}

/**
 * Stages candidate delta operators into `.cairn/staged.json`.
 * Ignores empty `ops: []` (NO_OP) and allocates monotonic `stg_<n>` via `next_proposal_seq`.
 */
export function stageOperators(
  workspaceRoot = process.cwd(),
  { ops, source_step, actor_id = 'default', base_revision, created_at } = {}
) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }
  if (!Array.isArray(ops)) {
    throw new Error('stage_operators_invalid_ops:expected_array');
  }

  const paths = resolveCairnPaths(workspaceRoot);
  const staged = readStaged(workspaceRoot);

  if (ops.length === 0) {
    return {
      staged: false,
      reason: 'no_op',
      proposal: null,
      next_proposal_seq: staged.next_proposal_seq
    };
  }

  const head = readHead(workspaceRoot);
  const seq = staged.next_proposal_seq;
  const proposalId = `stg_${seq}`;
  const effectiveActorId =
    typeof actor_id === 'string' && actor_id.trim().length > 0 ? actor_id.trim() : 'default';
  const effectiveBaseRevision = base_revision !== undefined ? base_revision : head.revision;

  const proposal = {
    proposal_id: proposalId,
    created_at: created_at ?? new Date().toISOString(),
    source_step: source_step ?? `stage_${seq}`,
    actor_id: effectiveActorId,
    base_revision: effectiveBaseRevision,
    ops,
    last_conflict: null,
    last_rejected_ops: null
  };

  staged.next_proposal_seq = seq + 1;
  staged.proposals.push(proposal);
  writeJsonAtomic(paths.stagedFile, staged);

  return {
    staged: true,
    reason: null,
    proposal,
    next_proposal_seq: staged.next_proposal_seq
  };
}

/**
 * Folds pending staged proposal(s) from `.cairn/staged.json` into `.cairn/head.json` and `.cairn/ledger.jsonl`.
 *
 * - Records `initialHeadRevision` before batch execution so multiple proposals staged under the
 *   same HEAD (`stg_1`, `stg_2`) can commit sequentially in one batch without false self-conflict,
 *   while any proposal with `base_revision !== initialHeadRevision` (when `rebase: false`) is
 *   halted as a genuine optimistic concurrency conflict.
 * - If all operators in a proposal are rejected by `foldLedger` (`accepted_ops.length === 0 && rejected_count > 0`),
 *   retains the proposal in `staged.json` with `last_rejected_ops` and halts without writing an empty commit.
 * - Strictly persists each accepted commit in order: `ledger.jsonl` append -> `head.json` atomic write -> `staged.json` atomic write.
 */
export function commitStaged(
  workspaceRoot = process.cwd(),
  { proposal_id = null, actor_id = null, source_step = null, rebase = false, timestamp = null } = {}
) {
  const paths = resolveCairnPaths(workspaceRoot);
  let workingHead = readHead(workspaceRoot);
  const initialHeadRevision = workingHead.revision;
  const staged = readStaged(workspaceRoot);
  const existingLog = readLedgerLog(workspaceRoot);
  let nextCommitSeq =
    existingLog.length > 0
      ? Math.max(...existingLog.map((r, i) => (typeof r.commit_seq === 'number' ? r.commit_seq : i + 1))) + 1
      : 1;

  if (staged.proposals.length === 0) {
    return {
      committed: false,
      reason: 'nothing_to_commit',
      conflict: false,
      conflict_error: null,
      all_rejected: false,
      failed_proposal_id: null,
      rejected_ops: [],
      commits: [],
      head: workingHead,
      remaining_proposals: 0
    };
  }

  let targetProposals;
  if (proposal_id !== null && proposal_id !== undefined) {
    const found = staged.proposals.find(p => p.proposal_id === proposal_id);
    if (!found) {
      return {
        committed: false,
        reason: 'proposal_not_found',
        conflict: false,
        conflict_error: null,
        all_rejected: false,
        failed_proposal_id: proposal_id,
        rejected_ops: [],
        commits: [],
        head: workingHead,
        remaining_proposals: staged.proposals.length
      };
    }
    targetProposals = [found];
  } else {
    targetProposals = [...staged.proposals];
  }

  const commits = [];

  for (const proposal of targetProposals) {
    const effectiveActorId =
      typeof actor_id === 'string' && actor_id.trim()
        ? actor_id.trim()
        : proposal.actor_id ?? 'default';
    const effectiveSourceStep =
      typeof source_step === 'string' && source_step.trim()
        ? source_step.trim()
        : proposal.source_step ?? `step_${workingHead.revision + 1}`;

    const hasBaseRevision =
      proposal.base_revision !== undefined && proposal.base_revision !== null;

    // 1. Check optimistic concurrency against initialHeadRevision (unless rebase: true)
    if (!rebase && hasBaseRevision && proposal.base_revision !== initialHeadRevision) {
      const conflictError = `base_revision_conflict:expected_${proposal.base_revision}_actual_${initialHeadRevision}`;
      proposal.last_conflict = {
        error: conflictError,
        expected_base_revision: proposal.base_revision,
        actual_head_revision: initialHeadRevision,
        detected_at: timestamp ?? new Date().toISOString()
      };
      writeJsonAtomic(paths.stagedFile, staged);

      return {
        committed: commits.length > 0,
        reason: 'base_revision_conflict',
        conflict: true,
        conflict_error: conflictError,
        all_rejected: false,
        failed_proposal_id: proposal.proposal_id,
        rejected_ops: [],
        commits,
        head: workingHead,
        remaining_proposals: staged.proposals.length
      };
    }

    // 2. Fold against current workingHead (advancing base_revision across sequential proposals in the batch)
    const parentRevision = workingHead.revision;
    const foldResult = foldLedger(workingHead, proposal.ops, {
      source_step: effectiveSourceStep,
      actor_id: effectiveActorId,
      base_revision: parentRevision
    });

    // 3. If all operators in the proposal are rejected, retain proposal with `last_rejected_ops` and abort
    if (foldResult.accepted_ops.length === 0 && foldResult.rejected_count > 0) {
      proposal.last_conflict = null;
      proposal.last_rejected_ops = foldResult.rejected_ops;
      writeJsonAtomic(paths.stagedFile, staged);

      return {
        committed: commits.length > 0,
        reason: 'all_operators_rejected',
        conflict: false,
        conflict_error: null,
        all_rejected: true,
        failed_proposal_id: proposal.proposal_id,
        rejected_ops: foldResult.rejected_ops,
        commits,
        head: workingHead,
        remaining_proposals: staged.proposals.length
      };
    }

    // Empty proposal edge case (0 accepted, 0 rejected)
    if (foldResult.accepted_ops.length === 0) {
      staged.proposals = staged.proposals.filter(p => p.proposal_id !== proposal.proposal_id);
      writeJsonAtomic(paths.stagedFile, staged);
      continue;
    }

    // 4. Valid commit: build audit record and persist strictly in order:
    //    (a) ledger.jsonl append -> (b) head.json atomic write -> (c) staged.json atomic write
    const commitRecord = {
      commit_seq: nextCommitSeq++,
      timestamp: timestamp ?? new Date().toISOString(),
      proposal_id: proposal.proposal_id,
      source_step: effectiveSourceStep,
      actor_id: foldResult.actor_id,
      base_revision: parentRevision,
      staged_base_revision: hasBaseRevision ? proposal.base_revision : parentRevision,
      new_revision: foldResult.ledger.revision,
      ops: proposal.ops,
      accepted_ops: foldResult.accepted_ops,
      rejected_ops: foldResult.rejected_ops
    };

    workingHead = JSON.parse(JSON.stringify(foldResult.ledger));
    staged.proposals = staged.proposals.filter(p => p.proposal_id !== proposal.proposal_id);

    fs.appendFileSync(paths.ledgerFile, `${JSON.stringify(commitRecord)}\n`, 'utf8');
    writeJsonAtomic(paths.headFile, workingHead);
    writeJsonAtomic(paths.stagedFile, staged);

    commits.push(commitRecord);
  }

  return {
    committed: commits.length > 0,
    reason: commits.length > 0 ? 'committed' : 'nothing_to_commit',
    conflict: false,
    conflict_error: null,
    all_rejected: false,
    failed_proposal_id: null,
    rejected_ops: [],
    commits,
    head: workingHead,
    remaining_proposals: staged.proposals.length
  };
}

/**
 * Drops a specific staged proposal by `proposal_id`, or clears all staged proposals when omitted.
 * Preserves monotonic `next_proposal_seq`.
 */
export function dropStaged(workspaceRoot = process.cwd(), { proposal_id = null } = {}) {
  const paths = resolveCairnPaths(workspaceRoot);
  const staged = readStaged(workspaceRoot);
  const beforeCount = staged.proposals.length;

  let droppedProposals = [];
  if (proposal_id !== null && proposal_id !== undefined) {
    droppedProposals = staged.proposals.filter(p => p.proposal_id === proposal_id);
    if (droppedProposals.length === 0) {
      return {
        dropped: false,
        reason: 'proposal_not_found',
        dropped_count: 0,
        dropped_proposals: [],
        remaining_proposals: staged.proposals.length,
        next_proposal_seq: staged.next_proposal_seq
      };
    }
    staged.proposals = staged.proposals.filter(p => p.proposal_id !== proposal_id);
  } else {
    droppedProposals = [...staged.proposals];
    staged.proposals = [];
  }

  writeJsonAtomic(paths.stagedFile, staged);

  return {
    dropped: droppedProposals.length > 0,
    reason: droppedProposals.length > 0 ? 'dropped' : 'empty_queue',
    dropped_count: beforeCount - staged.proposals.length,
    dropped_proposals: droppedProposals,
    remaining_proposals: staged.proposals.length,
    next_proposal_seq: staged.next_proposal_seq
  };
}

export function readTasksIndex(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  if (!fs.existsSync(paths.tasksIndexFile)) {
    throw new Error(`cairn_not_initialized:${paths.cairnDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(paths.tasksIndexFile, 'utf8'));
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map(t => ({
          id: normalizeTaskId(t.id),
          title: String(t.title ?? '').trim() || `Task ${t.id}`,
          birth_turn: typeof t.birth_turn === 'number' ? t.birth_turn : 1,
          status: typeof t.status === 'string' && t.status.trim() ? t.status.trim() : 'active',
          turn_count: typeof t.turn_count === 'number' ? t.turn_count : 0,
          compacted_record_count:
            typeof t.compacted_record_count === 'number' ? t.compacted_record_count : 0,
          has_compact: Boolean(t.has_compact),
          updated_at: t.updated_at ?? null
        }))
        .sort((a, b) => a.id - b.id)
    : [];

  return {
    work_anchor_task_id:
      raw.work_anchor_task_id !== undefined && raw.work_anchor_task_id !== null
        ? normalizeTaskId(raw.work_anchor_task_id)
        : null,
    tasks
  };
}

/**
 * Inserts or updates a task entry in `.cairn/tasks/index.json` and ensures `.cairn/tasks/<id>/` exists.
 */
export function upsertTask(
  workspaceRoot = process.cwd(),
  { id, title, birth_turn, status, work_anchor_task_id, updated_at } = {}
) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }
  const paths = resolveCairnPaths(workspaceRoot);
  const index = readTasksIndex(workspaceRoot);
  const now = updated_at ?? new Date().toISOString();

  let targetTask = null;
  if (id !== undefined && id !== null) {
    const taskId = normalizeTaskId(id);
    fs.mkdirSync(paths.taskDir(taskId), { recursive: true });
    const hasCompactFile = fs.existsSync(paths.taskCompactFile(taskId));

    const existingIdx = index.tasks.findIndex(t => t.id === taskId);
    if (existingIdx === -1) {
      targetTask = {
        id: taskId,
        title: typeof title === 'string' && title.trim() ? title.trim() : `Task ${taskId}`,
        birth_turn: typeof birth_turn === 'number' ? birth_turn : 1,
        status: typeof status === 'string' && status.trim() ? status.trim() : 'active',
        turn_count: 0,
        compacted_record_count: 0,
        has_compact: hasCompactFile,
        updated_at: now
      };
      index.tasks.push(targetTask);
    } else {
      const prev = index.tasks[existingIdx];
      targetTask = {
        ...prev,
        title: typeof title === 'string' && title.trim() ? title.trim() : prev.title,
        birth_turn: typeof birth_turn === 'number' ? birth_turn : prev.birth_turn,
        status: typeof status === 'string' && status.trim() ? status.trim() : prev.status,
        has_compact: hasCompactFile || prev.has_compact,
        updated_at: now
      };
      index.tasks[existingIdx] = targetTask;
    }
    index.tasks.sort((a, b) => a.id - b.id);
  }

  if (work_anchor_task_id !== undefined) {
    index.work_anchor_task_id =
      work_anchor_task_id === null ? null : normalizeTaskId(work_anchor_task_id);
  }

  writeJsonAtomic(paths.tasksIndexFile, index);
  return {
    task: targetTask,
    index
  };
}

function summarizeTitleFromContent(content, taskId) {
  if (typeof content !== 'string' || !content.trim()) {
    return `Task ${taskId}`;
  }
  const firstLine = content
    .trim()
    .split(/\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstLine) {
    return `Task ${taskId}`;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

/**
 * Appends a turn/message record to `.cairn/tasks/<id>/thread.jsonl` and updates `.cairn/tasks/index.json`.
 */
export function appendTaskTurn(
  workspaceRoot = process.cwd(),
  { task_id, turn, role = 'assistant', content = '', raw_content = null, title, meta = {}, timestamp } = {}
) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }
  const taskId = normalizeTaskId(task_id);
  const paths = resolveCairnPaths(workspaceRoot);
  const taskDir = paths.taskDir(taskId);
  const threadFile = paths.taskThreadFile(taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const existingRecords = readTaskThread(workspaceRoot, taskId);
  const seq = existingRecords.length + 1;
  const now = timestamp ?? new Date().toISOString();
  const effectiveTurn = typeof turn === 'number' ? turn : seq;

  const record = {
    seq,
    turn: effectiveTurn,
    timestamp: now,
    role,
    content,
    ...(raw_content !== null && raw_content !== undefined ? { raw_content } : {}),
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {})
  };

  fs.appendFileSync(threadFile, `${JSON.stringify(record)}\n`, 'utf8');

  const index = readTasksIndex(workspaceRoot);
  const existingIdx = index.tasks.findIndex(t => t.id === taskId);
  const hasCompactFile = fs.existsSync(paths.taskCompactFile(taskId));

  let taskEntry;
  if (existingIdx === -1) {
    taskEntry = {
      id: taskId,
      title:
        typeof title === 'string' && title.trim()
          ? title.trim()
          : summarizeTitleFromContent(content, taskId),
      birth_turn: effectiveTurn,
      status: 'active',
      turn_count: seq,
      compacted_record_count: 0,
      has_compact: hasCompactFile,
      updated_at: now
    };
    index.tasks.push(taskEntry);
  } else {
    const prev = index.tasks[existingIdx];
    taskEntry = {
      ...prev,
      title: typeof title === 'string' && title.trim() ? title.trim() : prev.title,
      turn_count: seq,
      has_compact: hasCompactFile || prev.has_compact,
      updated_at: now
    };
    index.tasks[existingIdx] = taskEntry;
  }

  index.tasks.sort((a, b) => a.id - b.id);
  writeJsonAtomic(paths.tasksIndexFile, index);

  return {
    record,
    task: taskEntry,
    index
  };
}

export function readTaskThread(workspaceRoot = process.cwd(), taskId) {
  const id = normalizeTaskId(taskId);
  const paths = resolveCairnPaths(workspaceRoot);
  const threadFile = paths.taskThreadFile(id);
  if (!fs.existsSync(threadFile)) {
    return [];
  }
  const text = fs.readFileSync(threadFile, 'utf8').trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function writeTaskCompaction(
  workspaceRoot = process.cwd(),
  taskId,
  compactMarkdown,
  { compactedRecordCount } = {}
) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }
  const id = normalizeTaskId(taskId);
  const paths = resolveCairnPaths(workspaceRoot);
  fs.mkdirSync(paths.taskDir(id), { recursive: true });
  const text = `${String(compactMarkdown ?? '').trim()}\n`;
  writeTextAtomic(paths.taskCompactFile(id), text);

  const threadLen = readTaskThread(workspaceRoot, id).length;
  const effectiveCompactedCount =
    typeof compactedRecordCount === 'number' ? compactedRecordCount : threadLen;

  const index = readTasksIndex(workspaceRoot);
  const existingIdx = index.tasks.findIndex(t => t.id === id);
  const now = new Date().toISOString();
  if (existingIdx === -1) {
    index.tasks.push({
      id,
      title: `Task ${id}`,
      birth_turn: 1,
      status: 'active',
      turn_count: threadLen,
      compacted_record_count: effectiveCompactedCount,
      has_compact: true,
      updated_at: now
    });
    index.tasks.sort((a, b) => a.id - b.id);
  } else {
    index.tasks[existingIdx] = {
      ...index.tasks[existingIdx],
      compacted_record_count: effectiveCompactedCount,
      has_compact: true,
      updated_at: now
    };
  }
  writeJsonAtomic(paths.tasksIndexFile, index);

  return {
    task_id: id,
    compact_file: paths.taskCompactFile(id),
    compacted_record_count: effectiveCompactedCount,
    content: text
  };
}

export function readTaskCompaction(workspaceRoot = process.cwd(), taskId) {
  const id = normalizeTaskId(taskId);
  const paths = resolveCairnPaths(workspaceRoot);
  const compactFile = paths.taskCompactFile(id);
  if (!fs.existsSync(compactFile)) {
    return null;
  }
  return fs.readFileSync(compactFile, 'utf8');
}

export function getStoreStatus(workspaceRoot = process.cwd()) {
  const paths = resolveCairnPaths(workspaceRoot);
  if (!isCairnInitialized(workspaceRoot)) {
    return {
      initialized: false,
      workspace_root: paths.workspaceRoot,
      cairn_dir: paths.cairnDir
    };
  }

  const head = readHead(workspaceRoot);
  const readOnlyHead = projectReadOnlyLedger(head);
  const staged = readStaged(workspaceRoot);
  const tasksIndex = readTasksIndex(workspaceRoot);
  const replay = replayLedger(workspaceRoot);

  return {
    initialized: true,
    workspace_root: paths.workspaceRoot,
    cairn_dir: paths.cairnDir,
    head,
    read_only_head: readOnlyHead,
    staged,
    tasks_index: tasksIndex,
    light_task_catalog: buildLightTaskCatalog(tasksIndex.tasks),
    integrity: {
      valid: replay.valid,
      head_matches: replay.head_matches,
      commit_count: replay.commit_count,
      mismatch_reason: replay.mismatch_reason
    }
  };
}
