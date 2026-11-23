#!/usr/bin/env node
// Cairn Minimal CLI (bin/cairn.mjs)
// Subcommands: init | status | log | commit | drop | tasks
// Zero external dependencies.

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isCairnInitialized,
  initCairnStore,
  getStoreStatus,
  readLedgerLog,
  commitStaged,
  dropStaged,
  readTasksIndex,
  buildLightTaskCatalog,
  upsertTask,
  transitionTaskStatus
} from '../src/kernel/index.mjs';
import { compileTaskCheckout, runStrictCompactor, createOpenAICompatibleClient, runWorkspaceDoctor } from '../src/workers/index.mjs';
import { resolveStoreRoot } from '../src/workers/store-root.mjs';
import { compileHubTaskCheckout } from '../src/workers/hub-task-checkout.mjs';
import { runHubDoctor } from '../src/workers/hub-doctor.mjs';
import { runHubStrictCompactor } from '../src/workers/hub-strict-compactor.mjs';
import {
  initHubStore, isHubInitialized, readHubTasksIndex, readProjectsIndex,
  readScopedHead, readScopedLedgerLog, readScopedStaged, commitScopedStaged,
  dropScopedStaged, readSessionBinding, writeSessionBinding, clearSessionBinding,
  transitionHubTaskStatus
} from '../src/kernel/index.mjs';

function printUsage(writeOut) {
  writeOut(
    [
      'Cairn — Git for Agent Work States',
      '',
      'Usage:',
      '  cairn init   [--cwd <dir>] [--json]',
      '  cairn status [--cwd <dir>] [--json]',
      '  cairn log    [--cwd <dir>] [--json]',
      '  cairn commit [proposal_id] [--rebase] [--actor <id>] [--step <step>] [--cwd <dir>] [--json]',
      '  cairn drop   [proposal_id] [--cwd <dir>] [--json]',
      '  cairn tasks  [--all | --status <active|done|archived>] [--cwd <dir>] [--json]',
      '  cairn close <id> | archive <id> | reopen <id> [--cwd <dir>] [--json]',
      '  cairn doctor [--cwd <dir>] [--json]'
      ,'  cairn checkout <id|--clear> [--preview] [--cwd <dir>]'
      ,'  cairn compact <id> [--full] [--cwd <dir>]'
      ,'  Hub default: $DSH_HOME/cairn or ~/.cairn; use --store <path> to override. --cwd selects legacy workspace storage.'
    ].join('\n')
  );
}

export function runCairnCli(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    stdout = msg => process.stdout.write(`${msg}\n`),
    stderr = msg => process.stderr.write(`${msg}\n`)
  } = {}
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cwd: { type: 'string' },
        store: { type: 'string' },
        session: { type: 'string' },
        scope: { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
        rebase: { type: 'boolean', default: false },
        actor: { type: 'string' },
        step: { type: 'string' },
        preview: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        clear: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        status: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false }
      }
    });
  } catch (err) {
    stderr(`Argument error: ${err.message}`);
    return 1;
  }

  const { values, positionals } = parsed;
  const subcommand = positionals[0];
  const targetArg = positionals[1] ?? null;
  const workspaceRoot = path.resolve(values.cwd ? path.resolve(cwd, values.cwd) : cwd);
  const asJson = Boolean(values.json);

  const useHubStore = values.store !== undefined || (values.cwd === undefined && path.resolve(cwd) === path.resolve(process.cwd()));
  if (useHubStore) {
    return runHubCli(subcommand, targetArg, positionals, values, { stdout, stderr, asJson });
  }

  if (values.help || !subcommand) {
    printUsage(stdout);
    return subcommand ? 0 : 1;
  }

  if (subcommand === 'doctor') {
    const report = runWorkspaceDoctor({ workspaceRoot });
    stdout(asJson ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    return report.ok ? 0 : 1;
  }

  try {
    if (subcommand === 'init') {
      const res = initCairnStore(workspaceRoot);
      if (asJson) {
        stdout(
          JSON.stringify(
            {
              initialized: res.initialized,
              cairn_dir: res.paths.cairnDir,
              created_files: res.created_files,
              revision: res.head.revision
            },
            null,
            2
          )
        );
      } else {
        stdout(
          `Initialized Cairn store in ${res.paths.cairnDir} (HEAD revision: ${res.head.revision}, created files: ${res.created_files.length})`
        );
      }
      return 0;
    }

    if (!isCairnInitialized(workspaceRoot)) {
      if (asJson) {
        stdout(JSON.stringify({ initialized: false, workspace_root: workspaceRoot }, null, 2));
      } else {
        stderr(`Cairn store not initialized in ${workspaceRoot}. Run 'cairn init' first.`);
      }
      return 1;
    }

    if (subcommand === 'status') {
      const status = getStoreStatus(workspaceRoot);
      if (asJson) {
        stdout(JSON.stringify(status, null, 2));
      } else {
        const { head, staged, tasks_index: tasksIndex, integrity } = status;
        const openQCount = head.open_questions.filter(q => q.status === 'open').length;
        stdout(`HEAD revision : ${head.revision} (last_actor: ${head.last_actor_id ?? 'none'})`);
        stdout(
          `Integrity     : ${integrity.valid ? 'VALID' : `INVALID (${integrity.mismatch_reason})`} (${integrity.commit_count} commits)`
        );
        stdout(
          `Ledger state  : ${head.active.length} active, ${head.tombstones.length} tombstones, ${openQCount} open questions`
        );
        for (const d of head.active) {
          stdout(`  [ACTIVE] ${d.id} ${d.key} = ${d.option_code} (${d.summary})`);
        }
        for (const t of head.tombstones) {
          stdout(
            `  [TOMBSTONE] ${t.id} ${t.key} = ${t.option_code} -> ${t.superseded_by} (reason: ${t.reason})`
          );
        }
        for (const q of head.open_questions) {
          stdout(`  [QUESTION:${q.status.toUpperCase()}] ${q.id} ${q.key}: ${q.summary}`);
        }
        stdout(
          `Staged queue  : ${staged.proposals.length} pending proposal(s) (next_seq: ${staged.next_proposal_seq})`
        );
        for (const p of staged.proposals) {
          const conflictTag = p.last_conflict ? ` [CONFLICT: ${p.last_conflict.error}]` : '';
          const rejectTag =
            Array.isArray(p.last_rejected_ops) && p.last_rejected_ops.length > 0
              ? ` [REJECTED: ${p.last_rejected_ops.map(r => r.error).join(', ')}]`
              : '';
          stdout(
            `  - ${p.proposal_id} (base_rev: ${p.base_revision}, actor: ${p.actor_id}, ops: ${p.ops.length})${conflictTag}${rejectTag}`
          );
        }
        stdout(`Tasks         : ${tasksIndex.tasks.length} tracked task(s)`);
      }
      return status.integrity.valid ? 0 : 1;
    }

    if (subcommand === 'log') {
      const records = readLedgerLog(workspaceRoot);
      if (asJson) {
        stdout(JSON.stringify(records, null, 2));
      } else if (records.length === 0) {
        stdout('No commits in ledger.jsonl yet.');
      } else {
        for (const r of records) {
          const ids = (r.accepted_ops ?? [])
            .map(a => a.allocated_id ?? a.resolved_id ?? a.op?.op)
            .join(', ');
          stdout(
            `commit #${r.commit_seq} [${r.proposal_id ?? 'direct'}] rev ${r.base_revision} -> ${r.new_revision} | actor: ${r.actor_id} | step: ${r.source_step} | accepted: ${ids}`
          );
        }
      }
      return 0;
    }

    if (subcommand === 'commit') {
      const res = commitStaged(workspaceRoot, {
        proposal_id: targetArg,
        rebase: Boolean(values.rebase),
        actor_id: values.actor ?? null,
        source_step: values.step ?? null
      });

      if (asJson) {
        stdout(JSON.stringify(res, null, 2));
      } else if (res.conflict) {
        stderr(
          `Commit aborted on ${res.failed_proposal_id}: ${res.conflict_error}. Use 'cairn commit --rebase' or 'cairn drop ${res.failed_proposal_id}'.`
        );
      } else if (res.all_rejected) {
        const reasons = res.rejected_ops.map(r => `#${r.index}:${r.error}`).join(', ');
        stderr(
          `Commit aborted on ${res.failed_proposal_id}: all operators rejected (${reasons}).`
        );
      } else if (res.reason === 'proposal_not_found') {
        stderr(`Proposal not found: ${targetArg}`);
      } else if (!res.committed) {
        stdout('Nothing to commit (staged queue is empty).');
      } else {
        stdout(
          `Committed ${res.commits.length} proposal(s). HEAD is now at revision ${res.head.revision}.`
        );
      }

      if (res.conflict || res.all_rejected || res.reason === 'proposal_not_found') {
        return 1;
      }
      return 0;
    }

    if (subcommand === 'drop') {
      const res = dropStaged(workspaceRoot, {
        proposal_id: targetArg
      });

      if (asJson) {
        stdout(JSON.stringify(res, null, 2));
      } else if (res.reason === 'proposal_not_found') {
        stderr(`Proposal not found: ${targetArg}`);
        return 1;
      } else {
        stdout(
          `Dropped ${res.dropped_count} staged proposal(s) (${res.remaining_proposals} remaining, next_seq: ${res.next_proposal_seq}).`
        );
      }
      return res.reason === 'proposal_not_found' ? 1 : 0;
    }

    if (subcommand === 'tasks') {
      const index = readTasksIndex(workspaceRoot);
      const validStatuses = new Set(['active', 'done', 'archived']);
      if (values.all && values.status) throw new Error('Use either --all or --status, not both.');
      if (values.status && !validStatuses.has(values.status)) {
        throw new Error(`Invalid task status: ${values.status}`);
      }
      const tasks = values.all
        ? index.tasks
        : index.tasks.filter(task => task.status === (values.status ?? 'active'));
      const catalog = buildLightTaskCatalog(tasks);
      if (asJson) {
        stdout(
          JSON.stringify(
            {
              ...index,
              tasks,
              filter: values.all ? 'all' : values.status ?? 'active',
              light_task_catalog: catalog
            },
            null,
            2
          )
        );
      } else if (tasks.length === 0) {
        stdout('No tasks tracked in .cairn/tasks/index.json yet.');
      } else {
        const listing = values.all || values.status
          ? tasks.map(task => `- [${task.status.toUpperCase()}] <|task:${task.id}|>: ${task.title}`).join('\n')
          : catalog;
        stdout(listing);
        if (index.work_anchor_task_id !== null) {
          stdout(`WorkAnchor: <|task:${index.work_anchor_task_id}|>`);
        }
      }
      return 0;
    }

    if (['close', 'archive', 'reopen'].includes(subcommand)) {
      const id = Number(targetArg);
      if (!Number.isSafeInteger(id) || id < 1 || id > 999 || positionals.length !== 2) {
        throw new Error(`Use ${subcommand} <id>`);
      }
      const result = transitionTaskStatus(workspaceRoot, { taskId: id, action: subcommand });
      stdout(asJson ? JSON.stringify(result, null, 2) : `Task ${id}: ${result.previous_status} -> ${result.status}.`);
      return 0;
    }

    if (subcommand === 'checkout') {
      if ((targetArg === '--clear' || values.clear) && !values.preview) {
        const result = upsertTask(workspaceRoot, { work_anchor_task_id: null });
        stdout(asJson ? JSON.stringify(result, null, 2) : 'Cleared work anchor.');
        return 0;
      }
      if (!targetArg || targetArg === '--clear') throw new Error('Use checkout <id|--clear> [--preview]');
      const id = Number(targetArg);
      const task = readTasksIndex(workspaceRoot).tasks.find(entry => entry.id === id);
      if (!task) throw new Error(`Task not found: ${targetArg}`);
      if (task.status !== 'active' && !values.preview) {
        throw new Error(`task_not_active:${id}:${task.status}; run 'cairn reopen ${id}' first`);
      }
      const checkout = compileTaskCheckout({ workspaceRoot, taskId: id });
      if (!checkout.ok) throw new Error(`Task not found: ${targetArg}`);
      if (values.preview) {
        stdout(asJson ? JSON.stringify(checkout, null, 2) : checkout.text);
        return 0;
      }
      upsertTask(workspaceRoot, { work_anchor_task_id: id });
      stdout(asJson ? JSON.stringify({ work_anchor_task_id: id, checkout }, null, 2) : `Checked out task ${id}.`);
      return 0;
    }

    if (subcommand === 'compact') {
      throw new Error('compact is asynchronous; use runCairnCliAsync()');
    }

    stderr(`Unknown subcommand: ${subcommand}`);
    printUsage(stderr);
    return 1;
  } catch (err) {
    stderr(`Cairn CLI error: ${err.message}`);
    return 1;
  }
}

function formatDoctorReport(report) {
  const lines = [
    `Cairn doctor: ${report.ok ? 'OK' : 'ISSUES'}`,
    `Ledger replay: ${report.integrity?.valid ? 'VALID' : 'INVALID'}`
  ];
  for (const issue of report.issues ?? []) {
    lines.push(`  [${issue.severity.toUpperCase()}] ${issue.code}${issue.task_id ? ` task=${issue.task_id}` : ''}${issue.path ? ` path=${issue.path}` : ''}`);
  }
  for (const task of report.tasks ?? []) {
    lines.push(`  task ${task.id} ${task.status}: ${task.uncompressed_record_count} records / ${task.uncompressed_chars} chars; truncation=${task.truncation_risk.level}`);
  }
  return lines.join('\n');
}

function runHubCli(command, targetArg, positionals, values, { stdout, stderr, asJson }) {
  const hubRoot = resolveStoreRoot({ storeRoot: values.store });
  const scope = values.scope ?? (values.project ? 'project' : 'user');
  const projectId = values.project ?? null;
  const emit = value => stdout(asJson ? JSON.stringify(value, null, 2) : String(value));
  try {
    if (command === 'init') { emit(initHubStore(hubRoot)); return 0; }
    if (command === 'doctor') {
      const report = runHubDoctor({ hubRoot });
      emit(report);
      return report.ok ? 0 : 1;
    }
    if (!isHubInitialized(hubRoot)) { stderr(`Cairn Hub not initialized at ${hubRoot}; run 'cairn init --store <path>' first.`); return 1; }
    if (command === 'tasks') {
      if (values.all && values.status) throw new Error('Use either --all or --status, not both.');
      const filter = values.all ? null : values.status ?? 'active';
      if (filter && !['active', 'done', 'archived'].includes(filter)) throw new Error(`Invalid task status: ${filter}`);
      const index = readHubTasksIndex(hubRoot);
      const tasks = filter ? index.tasks.filter(task => task.status === filter) : index.tasks;
      emit({ ...index, tasks, filter: filter ?? 'all' }); return 0;
    }
    if (['close', 'archive', 'reopen'].includes(command)) {
      const id = Number(targetArg);
      if (!Number.isSafeInteger(id) || id < 1 || positionals.length !== 2) throw new Error(`Use ${command} <id>`);
      emit(transitionHubTaskStatus(hubRoot, { taskId: id, action: command })); return 0;
    }
    if (command === 'status') {
      const head = readScopedHead(hubRoot, { scope, projectId });
      const staged = readScopedStaged(hubRoot, { scope, projectId });
      emit({ scope, project_id: scope === 'project' ? projectId : null, head, staged }); return 0;
    }
    if (command === 'log') { emit(readScopedLedgerLog(hubRoot, { scope, projectId })); return 0; }
    if (command === 'commit') {
      const result = commitScopedStaged(hubRoot, { scope, projectId, proposal_id: targetArg, rebase: values.rebase, actor_id: values.actor });
      emit(result); return result.conflict || result.all_rejected ? 1 : 0;
    }
    if (command === 'drop') { emit(dropScopedStaged(hubRoot, { scope, projectId, proposal_id: targetArg })); return 0; }
    if (command === 'checkout') {
      const sessionId = values.session;
      if (targetArg === '--clear' || values.clear) {
        if (!sessionId) throw new Error('checkout --clear requires --session <id>');
        const cleared = clearSessionBinding(hubRoot, sessionId);
        emit({ cleared, session_id: sessionId }); return 0;
      }
      const taskId = Number(targetArg);
      if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error('Use checkout <id|--clear> [--preview]');
      const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const checkout = compileHubTaskCheckout({ hubRoot, taskId });
      if (values.preview) { emit(checkout); return 0; }
      if (!sessionId) throw new Error('checkout binding requires --session <id>; use --preview for read-only output');
      if (task.status !== 'active') throw new Error(`task_not_active:${taskId}:${task.status}; run 'cairn reopen ${taskId}' first`);
      const binding = writeSessionBinding(hubRoot, sessionId, { project_id: task.project_id, task_id: taskId, source: 'cli_checkout' });
      emit({ binding, checkout }); return 0;
    }
    if (command === 'compact') throw new Error('Hub compaction runner is not wired in this build.');
    throw new Error(`Unsupported Hub command: ${command}`);
  } catch (error) { stderr(`Cairn Hub CLI error: ${error.message}`); return 1; }
}

export async function runCairnCliAsync(argv = process.argv.slice(2), io = {}) {
  const ioCwd = io.cwd ?? process.cwd();
  if (argv[0] === 'compact' && (argv.includes('--store') || (!argv.includes('--cwd') && path.resolve(ioCwd) === path.resolve(process.cwd())))) {
    const { stdout = msg => process.stdout.write(`${msg}\n`), stderr = msg => process.stderr.write(`${msg}\n`), llmClient = createOpenAICompatibleClient() } = io;
    try {
      const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { store: { type: 'string' }, full: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, cwd: { type: 'string' } } });
      const id = Number(parsed.positionals[0]);
      if (!Number.isSafeInteger(id) || id < 1 || parsed.positionals.length !== 1 || (argv.includes('--store') && !parsed.values.store)) throw new Error('Use compact <id> [--full] [--store <path>]');
      const hubRoot = resolveStoreRoot({ storeRoot: parsed.values.store });
      const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === id);
      if (!task) throw new Error(`Task not found: ${id}`);
      if (task.status !== 'active') throw new Error(`task_not_active:${id}:${task.status}; run 'reopen ${id}' first`);
      const result = await runHubStrictCompactor({ hubRoot, taskId: id, mode: parsed.values.full ? 'full' : 'incremental', llmClient });
      stdout(JSON.stringify(result));
      return result.ok ? 0 : 1;
    } catch (error) { stderr(`Cairn Hub CLI error: ${error.message}`); return 1; }
  }
  if (argv[0] !== 'compact') return runCairnCli(argv, io);
  const { stdout = msg => process.stdout.write(`${msg}\n`), stderr = msg => process.stderr.write(`${msg}\n`), cwd = process.cwd(), llmClient = createOpenAICompatibleClient() } = io;
  const args = argv.slice(1).filter((arg, index, all) => !['--full', '--json', '--cwd'].includes(arg) && (index === 0 || all[index - 1] !== '--cwd'));
  const id = Number(args[0]);
  const full = argv.includes('--full');
  const cwdIndex = argv.indexOf('--cwd');
  const root = path.resolve(cwdIndex >= 0 ? argv[cwdIndex + 1] : cwd);
  try {
    if (!Number.isSafeInteger(id) || id < 1 || args.length !== 1 || (cwdIndex >= 0 && !argv[cwdIndex + 1])) throw new Error('Use compact <id> [--full] [--cwd <dir>]');
    const task = isCairnInitialized(root) ? readTasksIndex(root).tasks.find(entry => entry.id === id) : null;
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'active') {
      stderr(`task_not_active:${id}:${task.status}; run 'cairn reopen ${id}' first`);
      return 1;
    }
    const result = await runStrictCompactor({ workspaceRoot: root, taskId: id, mode: full ? 'full' : 'incremental', llmClient });
    stdout(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (err) { stderr(`Cairn CLI error: ${err.message}`); return 1; }
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const code = await runCairnCliAsync();
  process.exitCode = code;
}
