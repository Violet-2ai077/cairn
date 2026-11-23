import fs from 'node:fs';

import {
  isCairnInitialized,
  readTasksIndex,
  readTaskThread,
  replayLedger,
  resolveCairnPaths
} from '../kernel/index.mjs';
import { distillTaskThread } from './distill.mjs';

export function runWorkspaceDoctor({ workspaceRoot = process.cwd(), maxTailChars = 6000 } = {}) {
  if (!Number.isSafeInteger(maxTailChars) || maxTailChars < 0) {
    throw new RangeError('maxTailChars must be a non-negative safe integer');
  }
  const paths = resolveCairnPaths(workspaceRoot);
  const issues = [];
  const addIssue = (code, severity = 'error', fields = {}) => {
    issues.push({ code, severity, ...fields });
  };

  if (!isCairnInitialized(workspaceRoot)) {
    return {
      ok: false,
      initialized: false,
      workspace_root: paths.workspaceRoot,
      integrity: null,
      issues: [{ code: 'not_initialized', severity: 'error', path: paths.cairnDir }],
      tasks: []
    };
  }

  let index;
  try {
    index = readTasksIndex(workspaceRoot);
  } catch (error) {
    return {
      ok: false,
      initialized: true,
      workspace_root: paths.workspaceRoot,
      integrity: null,
      issues: [{ code: 'tasks_index_unreadable', severity: 'error', path: paths.tasksIndexFile }],
      tasks: [],
      error: error.message
    };
  }

  let replay;
  try {
    replay = replayLedger(workspaceRoot);
    if (!replay.valid) addIssue('ledger_replay_invalid', 'error', { reason: replay.mismatch_reason });
  } catch (error) {
    replay = { valid: false, head_matches: false, commit_count: 0, mismatch_reason: 'replay_error' };
    addIssue('ledger_replay_error', 'error', { error: error.message });
  }

  const taskIds = new Set(index.tasks.map(task => task.id));
  const statusById = new Map(index.tasks.map(task => [task.id, task.status]));
  const taskReports = [];

  if (index.work_anchor_task_id !== null) {
    const anchorStatus = statusById.get(index.work_anchor_task_id);
    if (!anchorStatus) {
      addIssue('anchor_task_missing', 'error', { task_id: index.work_anchor_task_id });
    } else if (anchorStatus !== 'active') {
      addIssue('anchor_task_not_active', 'error', {
        task_id: index.work_anchor_task_id,
        status: anchorStatus
      });
    }
  }

  for (const task of index.tasks) {
    if (!['active', 'done', 'archived'].includes(task.status)) {
      addIssue('invalid_task_status', 'error', { task_id: task.id, status: task.status });
    }

    const threadPath = paths.taskThreadFile(task.id);
    let records = [];
    if (!fs.existsSync(threadPath)) {
      if (task.turn_count > 0 || task.compacted_record_count > 0) {
        addIssue('task_thread_missing', 'error', { task_id: task.id, path: threadPath });
      }
    } else {
      try {
        records = readTaskThread(workspaceRoot, task.id);
      } catch (error) {
        addIssue('task_thread_unreadable', 'error', { task_id: task.id, path: threadPath, error: error.message });
      }
    }

    if (task.turn_count !== records.length) {
      addIssue('task_turn_count_mismatch', 'warning', {
        task_id: task.id,
        indexed_count: task.turn_count,
        disk_count: records.length
      });
    }
    if (!Number.isSafeInteger(task.compacted_record_count) || task.compacted_record_count < 0 || task.compacted_record_count > records.length) {
      addIssue('compaction_cursor_out_of_range', 'error', {
        task_id: task.id,
        compacted_record_count: task.compacted_record_count,
        disk_count: records.length
      });
    }

    const compactPath = paths.taskCompactFile(task.id);
    const compactExists = fs.existsSync(compactPath);
    if (Boolean(task.has_compact) !== compactExists) {
      addIssue('compact_file_index_mismatch', 'warning', {
        task_id: task.id,
        path: compactPath,
        indexed_has_compact: Boolean(task.has_compact),
        disk_has_compact: compactExists
      });
    }
    const cursor = Math.min(Math.max(0, task.compacted_record_count || 0), records.length);
    const tailRecords = records.slice(cursor);
    const fullDistill = distillTaskThread(tailRecords, {
      maxThreadChars: Number.MAX_SAFE_INTEGER,
      maxPerRecordChars: Number.MAX_SAFE_INTEGER,
      maxCodeBlockChars: Number.MAX_SAFE_INTEGER,
      maxPerToolChars: Number.MAX_SAFE_INTEGER
    });
    const uncompressedChars = fullDistill.distilled_text.length;
    const ratio = maxTailChars === 0
      ? (uncompressedChars > 0 ? Number.POSITIVE_INFINITY : 0)
      : uncompressedChars / maxTailChars;
    const riskLevel = ratio >= 1.5 ? 'critical' : ratio >= 1 ? 'high' : ratio >= 0.7 ? 'watch' : 'none';

    taskReports.push({
      id: task.id,
      status: task.status,
      thread_record_count: records.length,
      compacted_record_count: task.compacted_record_count,
      uncompressed_record_count: tailRecords.length,
      uncompressed_chars: uncompressedChars,
      truncation_risk: {
        level: riskLevel,
        max_tail_chars: maxTailChars,
        ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : null,
        note: 'Measured from full distillTaskThread output with all truncation limits raised to MAX_SAFE_INTEGER; compare this source waterline to max_tail_chars.'
      }
    });
  }

  let directoryEntries = [];
  try {
    directoryEntries = fs.readdirSync(paths.tasksDir, { withFileTypes: true });
  } catch (error) {
    addIssue('tasks_directory_unreadable', 'error', { path: paths.tasksDir, error: error.message });
  }
  for (const entry of directoryEntries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]{0,2}$/.test(entry.name)) continue;
    const id = Number(entry.name);
    if (!taskIds.has(id)) addIssue('orphan_task_directory', 'warning', { task_id: id, path: paths.taskDir(id) });
  }

  return {
    ok: !issues.some(issue => issue.severity === 'error'),
    initialized: true,
    workspace_root: paths.workspaceRoot,
    integrity: {
      valid: Boolean(replay.valid),
      head_matches: Boolean(replay.head_matches),
      commit_count: replay.commit_count,
      mismatch_reason: replay.mismatch_reason ?? null
    },
    issues,
    tasks: taskReports
  };
}
