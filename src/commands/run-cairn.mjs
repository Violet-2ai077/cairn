import { parseArgs } from 'node:util';
import path from 'node:path';
import { pick } from '../i18n/locale.mjs';

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
} from '../kernel/index.mjs';
import { compileTaskCheckout, runStrictCompactor, createOpenAICompatibleClient, runWorkspaceDoctor } from '../workers/index.mjs';
import { resolveStoreRoot } from '../workers/store-root.mjs';
import { compileHubHandoff } from '../workers/hub-handoff.mjs';
import { readToolTimeline } from '../kernel/tool-timeline.mjs';
import { verifyFileWrite } from '../kernel/file-writes.mjs';
import { runHubDoctor } from '../workers/hub-doctor.mjs';
import { backupHub, restoreHub } from '../workers/hub-recovery.mjs';
import { runHubStrictCompactor } from '../workers/hub-strict-compactor.mjs';
import { listHubTaskPools, resolveTaskHeatPolicy } from '../kernel/task-heat.mjs';
import {
  initHubStore, isHubInitialized, readHubTasksIndex, readProjectsIndex,
  readScopedHead, readScopedLedgerLog, readScopedStaged, commitScopedStaged, revertScopedCommit, syncScopedLedger,
  dropScopedStaged, readSessionBinding, writeSessionBinding, clearSessionBinding,
  transitionHubTaskStatus
} from '../kernel/index.mjs';

const usage = syntax => pick('用法：', 'Use ') + syntax;
const taskMissing = id => pick('找不到任务：', 'Task not found: ') + id;
const proposalMissing = id => pick('找不到提案：', 'Proposal not found: ') + id;
const cliError = message => pick('Cairn CLI 错误：', 'Cairn CLI error: ') + message;
const hubError = message => pick('Cairn Hub CLI 错误：', 'Cairn Hub CLI error: ') + message;
const reopenFirst = (id, status, command = 'cairn reopen') =>
  `task_not_active:${id}:${status}; ` + pick(`请先运行 '${command} ${id}'`, `run '${command} ${id}' first`);

function printUsage(writeOut) {
  writeOut(
    [
      pick('Cairn — 智能体工作状态的 Git', 'Cairn — Git for Agent Work States'),
      '',
      pick('用法：', 'Usage:'),
      '  cairn init   [--cwd <dir>] [--json]',
      '  cairn init   --store <hub> [--extended-task-ids] [--json]',
      '  cairn status [--cwd <dir>] [--json]',
      '  cairn log    [--cwd <dir>] [--json]',
      '  cairn commit [proposal_id] [--rebase] [--actor <id>] [--step <step>] [--cwd <dir>] [--json]',
      '  cairn drop   [proposal_id] [--cwd <dir>] [--json]',
      '  cairn tasks  [--all | --status <active|done|archived>] [--cwd <dir>] [--json]',
      '  cairn tasks  [--task-heat [--hot-max-tasks <n>] [--idle-days <n>]] [--store <path>]',
      '  cairn close <id> | archive <id> | reopen <id> [--cwd <dir>] [--json]',
      '  cairn doctor [--cwd <dir>] [--json]'
      ,'  cairn checkout <id|--clear> [--preview] [--cwd <dir>]'
      ,'  cairn verify-write <task-id> <write-id> [--store <path>] [--json]'
      ,'  cairn tool-calls <task-id> [<turn> --session <id>] [--store <path>] [--json]'
      ,'  cairn backup <new-bundle-dir> --store <stopped-hub> [--key-file <external-key>] [--json]'
      ,'  cairn restore <bundle-dir> --store <new-hub-dir> [--key-file <external-key>] [--json]'
      ,'  cairn compact <id> [--full] [--cwd <dir>]'
      ,pick('  默认 Hub 位于 $DSH_HOME/cairn 或 ~/.cairn；用 --store <path> 指定其他位置，用 --cwd 选择旧版工作区存储。',
        '  Hub default: $DSH_HOME/cairn or ~/.cairn; use --store <path> to override. --cwd selects legacy workspace storage.')
      ,'  cairn revert <seq> --scope <user|project> [--project <id>] --reason <text> [--preview] [--store <path>] [--json]'
      ,'  cairn sync [--scope <user|project>] [--project <id>] [--store <path>] [--json]'
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
        'key-file': { type: 'string' },
        'extended-task-ids': { type: 'boolean' },
        session: { type: 'string' },
        scope: { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
        rebase: { type: 'boolean', default: false },
        actor: { type: 'string' },
        step: { type: 'string' },
        reason: { type: 'string' },
        preview: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        clear: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        status: { type: 'string' },
        'task-heat': { type: 'boolean', default: false },
        'hot-max-tasks': { type: 'string' },
        'idle-days': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false }
      }
    });
  } catch (err) {
    stderr(pick('参数错误：', 'Argument error: ') + err.message);
    return 1;
  }

  const { values, positionals } = parsed;
  const subcommand = positionals[0];
  const targetArg = positionals[1] ?? null;
  const workspaceRoot = path.resolve(values.cwd ? path.resolve(cwd, values.cwd) : cwd);
  const asJson = Boolean(values.json);

  const useHubStore = values.store !== undefined || (values.cwd === undefined && path.resolve(cwd) === path.resolve(process.cwd()));
  if (values['extended-task-ids'] && (subcommand !== 'init' || !useHubStore || values.cwd !== undefined)) {
    stderr(pick('--extended-task-ids 只能用于初始化 Hub', '--extended-task-ids requires Hub init')); return 1;
  }
  if (values['key-file'] !== undefined && (!['backup', 'restore'].includes(subcommand) || !values['key-file'].trim())) {
    stderr(pick('--key-file 仅用于 backup 或 restore，且必须指定外部密钥文件', '--key-file requires backup or restore and an external key file'));
    return 1;
  }
  if (values.help || !subcommand) {
    printUsage(stdout);
    return values.help ? 0 : 1;
  }
  if (useHubStore) {
    return runHubCli(subcommand, targetArg, positionals, values, { stdout, stderr, asJson });
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
          pick(`已在 ${res.paths.cairnDir} 初始化 Cairn 存储（HEAD 版本：${res.head.revision}，新建文件：${res.created_files.length}）`,
            `Initialized Cairn store in ${res.paths.cairnDir} (HEAD revision: ${res.head.revision}, created files: ${res.created_files.length})`)
        );
      }
      return 0;
    }

    if (!isCairnInitialized(workspaceRoot)) {
      if (asJson) {
        stdout(JSON.stringify({ initialized: false, workspace_root: workspaceRoot }, null, 2));
      } else {
        stderr(pick(`${workspaceRoot} 中的 Cairn 存储未初始化。请先运行 'cairn init --cwd <dir>'。`,
          `Cairn store not initialized in ${workspaceRoot}. Run 'cairn init' first.`));
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
        stdout(pick(`HEAD 版本：${head.revision}（上次操作者：${head.last_actor_id ?? '无'}）`, `HEAD revision : ${head.revision} (last_actor: ${head.last_actor_id ?? 'none'})`));
        stdout(
          pick(`完整性：${integrity.valid ? '通过' : `异常（${integrity.mismatch_reason}）`}（${integrity.commit_count} 次提交）`,
            `Integrity     : ${integrity.valid ? 'VALID' : `INVALID (${integrity.mismatch_reason})`} (${integrity.commit_count} commits)`)
        );
        stdout(
          pick(`账本状态：${head.active.length} 项生效决策，${head.tombstones.length} 条墓碑，${openQCount} 个未决问题`,
            `Ledger state  : ${head.active.length} active, ${head.tombstones.length} tombstones, ${openQCount} open questions`)
        );
        for (const d of head.active) {
          stdout(`  [${pick('生效', 'ACTIVE')}] ${d.id} ${d.key} = ${d.option_code} (${d.summary})`);
        }
        for (const t of head.tombstones) {
          stdout(
            `  [${pick('墓碑', 'TOMBSTONE')}] ${t.id} ${t.key} = ${t.option_code} -> ${t.superseded_by} (${pick('原因：', 'reason: ')}${t.reason})`
          );
        }
        for (const q of head.open_questions) {
          stdout(`  [${pick('问题', 'QUESTION')}:${q.status.toUpperCase()}] ${q.id} ${q.key}: ${q.summary}`);
        }
        stdout(
          pick(`暂存队列：${staged.proposals.length} 条待处理提案（下一序号：${staged.next_proposal_seq}）`,
            `Staged queue  : ${staged.proposals.length} pending proposal(s) (next_seq: ${staged.next_proposal_seq})`)
        );
        for (const p of staged.proposals) {
          const conflictTag = p.last_conflict ? ` [${pick('冲突：', 'CONFLICT: ')}${p.last_conflict.error}]` : '';
          const rejectTag =
            Array.isArray(p.last_rejected_ops) && p.last_rejected_ops.length > 0
              ? ` [${pick('已拒绝：', 'REJECTED: ')}${p.last_rejected_ops.map(r => r.error).join(', ')}]`
              : '';
          stdout(
            pick(`  - ${p.proposal_id}（基础版本：${p.base_revision}，操作者：${p.actor_id}，操作数：${p.ops.length}）`,
              `  - ${p.proposal_id} (base_rev: ${p.base_revision}, actor: ${p.actor_id}, ops: ${p.ops.length})`) + conflictTag + rejectTag
          );
        }
        stdout(pick(`任务：跟踪 ${tasksIndex.tasks.length} 项`, `Tasks         : ${tasksIndex.tasks.length} tracked task(s)`));
      }
      return status.integrity.valid ? 0 : 1;
    }

    if (subcommand === 'log') {
      const records = readLedgerLog(workspaceRoot);
      if (asJson) {
        stdout(JSON.stringify(records, null, 2));
      } else if (records.length === 0) {
        stdout(pick('ledger.jsonl 中尚无提交。', 'No commits in ledger.jsonl yet.'));
      } else {
        for (const r of records) {
          const ids = (r.accepted_ops ?? [])
            .map(a => a.allocated_id ?? a.resolved_id ?? a.op?.op)
            .join(', ');
          stdout(
            pick(`提交 #${r.commit_seq} [${r.proposal_id ?? '直接提交'}] 版本 ${r.base_revision} -> ${r.new_revision} | 操作者：${r.actor_id} | 步骤：${r.source_step} | 已接受：${ids}`,
              `commit #${r.commit_seq} [${r.proposal_id ?? 'direct'}] rev ${r.base_revision} -> ${r.new_revision} | actor: ${r.actor_id} | step: ${r.source_step} | accepted: ${ids}`)
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
          pick(`提案 ${res.failed_proposal_id} 提交中止：${res.conflict_error}。可运行 'cairn commit --rebase' 或 'cairn drop ${res.failed_proposal_id}'。`,
            `Commit aborted on ${res.failed_proposal_id}: ${res.conflict_error}. Use 'cairn commit --rebase' or 'cairn drop ${res.failed_proposal_id}'.`)
        );
      } else if (res.all_rejected) {
        const reasons = res.rejected_ops.map(r => `#${r.index}:${r.error}`).join(', ');
        stderr(
          pick(`提案 ${res.failed_proposal_id} 提交中止：全部操作被拒绝（${reasons}）。`,
            `Commit aborted on ${res.failed_proposal_id}: all operators rejected (${reasons}).`)
        );
      } else if (res.reason === 'proposal_not_found') {
        stderr(proposalMissing(targetArg));
      } else if (!res.committed) {
        stdout(pick('没有可提交的提案（暂存队列为空）。', 'Nothing to commit (staged queue is empty).'));
      } else {
        stdout(
          pick(`已提交 ${res.commits.length} 条提案。当前 HEAD 版本为 ${res.head.revision}。`,
            `Committed ${res.commits.length} proposal(s). HEAD is now at revision ${res.head.revision}.`)
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
        stderr(proposalMissing(targetArg));
        return 1;
      } else {
        stdout(
          pick(`已丢弃 ${res.dropped_count} 条暂存提案（剩余 ${res.remaining_proposals} 条，下一序号：${res.next_proposal_seq}）。`,
            `Dropped ${res.dropped_count} staged proposal(s) (${res.remaining_proposals} remaining, next_seq: ${res.next_proposal_seq}).`)
        );
      }
      return res.reason === 'proposal_not_found' ? 1 : 0;
    }

    if (subcommand === 'tasks') {
      const index = readTasksIndex(workspaceRoot);
      const validStatuses = new Set(['active', 'done', 'archived']);
      if (values.all && values.status) throw new Error(pick('--all 和 --status 不能同时使用。', 'Use either --all or --status, not both.'));
      if (values.status && !validStatuses.has(values.status)) {
        throw new Error(pick('无效的任务状态：', 'Invalid task status: ') + values.status);
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
        stdout(pick('.cairn/tasks/index.json 中尚无跟踪任务。', 'No tasks tracked in .cairn/tasks/index.json yet.'));
      } else {
        const listing = values.all || values.status
          ? tasks.map(task => `- [${task.status.toUpperCase()}] <|task:${task.id}|>: ${task.title}`).join('\n')
          : pick('已登记的任务（只读目录）：\n' + tasks.map(task => `- <|task:${task.id}|>: ${task.title}` +
            (typeof task.birth_turn === 'number' ? `（创建于第 ${task.birth_turn} 轮）` : '')).join('\n'), catalog);
        stdout(listing);
        if (index.work_anchor_task_id !== null) {
          stdout(pick('当前任务锚点：', 'WorkAnchor: ') + `<|task:${index.work_anchor_task_id}|>`);
        }
      }
      return 0;
    }

    if (['close', 'archive', 'reopen'].includes(subcommand)) {
      const id = Number(targetArg);
      if (!Number.isSafeInteger(id) || id < 1 || id > 999 || positionals.length !== 2) {
        throw new Error(usage(`${subcommand} <id>`));
      }
      const result = transitionTaskStatus(workspaceRoot, { taskId: id, action: subcommand });
      stdout(asJson ? JSON.stringify(result, null, 2) : pick(`任务 ${id}：${result.previous_status} -> ${result.status}。`, `Task ${id}: ${result.previous_status} -> ${result.status}.`));
      return 0;
    }

    if (subcommand === 'checkout') {
      if ((targetArg === '--clear' || values.clear) && !values.preview) {
        const result = upsertTask(workspaceRoot, { work_anchor_task_id: null });
        stdout(asJson ? JSON.stringify(result, null, 2) : pick('已清除任务锚点。', 'Cleared work anchor.'));
        return 0;
      }
      if (!targetArg || targetArg === '--clear') throw new Error(usage('checkout <id|--clear> [--preview]'));
      const id = Number(targetArg);
      const task = readTasksIndex(workspaceRoot).tasks.find(entry => entry.id === id);
      if (!task) throw new Error(taskMissing(targetArg));
      if (task.status !== 'active' && !values.preview) {
        throw new Error(reopenFirst(id, task.status));
      }
      const checkout = compileTaskCheckout({ workspaceRoot, taskId: id });
      if (!checkout.ok) throw new Error(taskMissing(targetArg));
      if (values.preview) {
        stdout(asJson ? JSON.stringify(checkout, null, 2) : checkout.text);
        return 0;
      }
      upsertTask(workspaceRoot, { work_anchor_task_id: id });
      stdout(asJson ? JSON.stringify({ work_anchor_task_id: id, checkout }, null, 2) : pick(`已切换到任务 ${id}。`, `Checked out task ${id}.`));
      return 0;
    }

    if (subcommand === 'compact') {
      throw new Error(pick('compact 是异步命令；请使用 runCairnCliAsync()', 'compact is asynchronous; use runCairnCliAsync()'));
    }

    stderr(pick('未知子命令：', 'Unknown subcommand: ') + subcommand);
    printUsage(stderr);
    return 1;
  } catch (err) {
    stderr(cliError(err.message));
    return 1;
  }
}

function formatDoctorReport(report) {
  const lines = [
    pick(`Cairn 诊断：${report.ok ? '正常' : '发现问题'}`, `Cairn doctor: ${report.ok ? 'OK' : 'ISSUES'}`),
    pick(`账本重放：${report.integrity?.valid ? '通过' : '异常'}`, `Ledger replay: ${report.integrity?.valid ? 'VALID' : 'INVALID'}`)
  ];
  for (const issue of report.issues ?? []) {
    lines.push(`  [${issue.severity.toUpperCase()}] ${issue.code}${issue.task_id ? ` task=${issue.task_id}` : ''}${issue.path ? ` path=${issue.path}` : ''}`);
  }
  for (const task of report.tasks ?? []) {
    lines.push(pick(`  任务 ${task.id} ${task.status}：${task.uncompressed_record_count} 条记录 / ${task.uncompressed_chars} 个字符；截断风险：${task.truncation_risk.level}`,
      `  task ${task.id} ${task.status}: ${task.uncompressed_record_count} records / ${task.uncompressed_chars} chars; truncation=${task.truncation_risk.level}`));
  }
  return lines.join('\n');
}

function runHubCli(command, targetArg, positionals, values, { stdout, stderr, asJson }) {
  const hubRoot = resolveStoreRoot({ storeRoot: values.store });
  const scope = values.scope ?? (values.project ? 'project' : 'user');
  const projectId = values.project ?? null;
  const emit = value => stdout(!asJson && typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  try {
    if (command === 'backup' || command === 'restore') {
      if (positionals.length !== 2 || !targetArg?.trim() || !values.store?.trim() ||
          Object.entries(values).some(([key, v]) => v && !['json', 'store', 'key-file'].includes(key))) {
        throw new Error(usage('cairn ' + command + ' <bundle-dir> --store <hub-dir> [--key-file <external-key>] [--json]'));
      }
      const options = { keyFile: values['key-file'] };
      const result = command === 'backup' ? backupHub(hubRoot, targetArg, options) : restoreHub(targetArg, hubRoot, options);
      emit(asJson ? result : pick(`已校验 ${result.file_count} 个文件：`, `Verified ${result.file_count} files: `) + (result.backup ?? result.hub));
      return 0;
    }
    if (command === 'init') { emit(initHubStore(hubRoot, { extendedTaskIds: values['extended-task-ids'] })); return 0; }
    if (command === 'doctor') {
      const report = runHubDoctor({ hubRoot });
      if (asJson) emit(report);
      else stdout([pick('Hub 诊断：' + (report.ok ? '正常' : '发现问题'), 'Hub doctor: ' + (report.ok ? 'OK' : 'issues found')), ...report.issues.map(i => JSON.stringify(i))].join('\n'));
      return report.ok ? 0 : 1;
    }
    if (command === 'status') {
      const head = readScopedHead(hubRoot, { scope, projectId });
      const staged = readScopedStaged(hubRoot, { scope, projectId });
      emit({ initialized: isHubInitialized(hubRoot), scope, project_id: scope === 'project' ? projectId : null, head, staged }); return 0;
    }
    if (!isHubInitialized(hubRoot)) { stderr(pick(`Cairn Hub 尚未在 ${hubRoot} 初始化；请先运行 'cairn init --store <path>'。`,
      `Cairn Hub not initialized at ${hubRoot}; run 'cairn init --store <path>' first.`)); return 1; }
    if (command === 'tasks') {
      if (values.all && values.status) throw new Error(pick('--all 和 --status 不能同时使用。', 'Use either --all or --status, not both.'));
      const filter = values.all ? null : values.status ?? 'active';
      if (filter && !['active', 'done', 'archived'].includes(filter)) throw new Error(pick('无效的任务状态：', 'Invalid task status: ') + filter);
      const index = readHubTasksIndex(hubRoot);
      const policy = resolveTaskHeatPolicy({ enabled: values['task-heat'], taskHeat: {
        hotMaxTasks: Number(values['hot-max-tasks']), idleDays: Number(values['idle-days'])
      } });
      const tasks = listHubTaskPools(index.tasks, { policy }).filter(task => !filter || task.status === filter);
      if (asJson) emit({ ...index, tasks, filter: filter ?? 'all' });
      else stdout(tasks.map(task => `- [${task.status} / ${task.pool}] ${task.id}: ${task.title}`).join('\n') || pick('没有符合此状态筛选条件的任务。', 'No tasks in this lifecycle filter.'));
      return 0;
    }
    if (['close', 'archive', 'reopen'].includes(command)) {
      const id = Number(targetArg);
      if (!Number.isSafeInteger(id) || id < 1 || positionals.length !== 2) throw new Error(usage(`${command} <id>`));
      emit(transitionHubTaskStatus(hubRoot, { taskId: id, action: command })); return 0;
    }
    if (command === 'log') { emit(readScopedLedgerLog(hubRoot, { scope, projectId })); return 0; }
    if (command === 'sync') {
      if (targetArg) throw new Error(usage('cairn sync [--scope <scope>] [--project <id>]'));
      stdout(JSON.stringify(syncScopedLedger(hubRoot, { scope, projectId }), null, asJson ? 2 : 0)); return 0;
    }
    if (command === 'revert') {
      if (!values.scope || positionals.length !== 2 || !/^\d+$/u.test(targetArg ?? '')) {
        throw new Error(usage('cairn revert <seq> --scope <user|project> [--project <id>] --reason <text> [--preview]'));
      }
      const result = revertScopedCommit(hubRoot, { scope, projectId, commitSeq: Number(targetArg), reason: values.reason, actorId: values.actor, preview: values.preview });
      stdout(JSON.stringify(result, null, asJson ? 2 : 0));
      return ['preview', 'reverted', 'already_reverted'].includes(result.status) ? 0 : 1;
    }
    if (command === 'commit') {
      const result = commitScopedStaged(hubRoot, { scope, projectId, proposal_id: targetArg, rebase: values.rebase, actor_id: values.actor });
      emit(result); return ['committed', 'nothing_to_commit'].includes(result.reason) ? 0 : 1;
    }
    if (command === 'drop') { emit(dropScopedStaged(hubRoot, { scope, projectId, proposal_id: targetArg })); return 0; }
    if (command === 'tool-calls') {
      const turn = positionals[2];
      if (!/^[1-9]\d*$/u.test(targetArg ?? '') || positionals.length > 3 ||
          (turn !== undefined && (!values.session || !/^\d+$/u.test(turn) || !Number.isSafeInteger(Number(turn))))) {
        throw new Error(usage('tool-calls <task-id> [<turn> --session <id>]'));
      }
      emit(readToolTimeline(hubRoot, Number(targetArg), { sessionId: values.session, turn: turn == null ? null : Number(turn) }));
      return 0;
    }
    if (command === 'verify-write') {
      if (positionals.length !== 3 || !/^[1-9]\d*$/u.test(targetArg) || values.preview) throw new Error(usage('verify-write <task-id> <write-id>'));
      const result = verifyFileWrite(hubRoot, Number(targetArg), positionals[2]);
      emit(asJson ? result : [result.relative_path, result.status, result.reason ?? result.actual_sha256, result.checked_at].join('  '));
      return result.status === 'matches' ? 0 : result.status === 'differs' ? 2 : 3;
    }
    if (command === 'checkout') {
      const sessionId = values.session;
      if (targetArg === '--clear' || values.clear) {
        if (values.preview) throw new Error(pick('checkout --clear 不能与 --preview 同时使用', 'checkout --clear cannot be combined with --preview'));
        if (!sessionId) throw new Error(pick('checkout --clear 需要 --session <id>', 'checkout --clear requires --session <id>'));
        const cleared = clearSessionBinding(hubRoot, sessionId);
        emit({ cleared, session_id: sessionId }); return 0;
      }
      const taskId = Number(targetArg);
      if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error(usage('checkout <id|--clear> [--preview]'));
      const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === taskId);
      if (!task) throw new Error(taskMissing(taskId));
      const checkout = compileHubHandoff({ hubRoot, taskId });
      if (values.preview || !checkout.ok) { emit(asJson ? checkout : checkout.text); return checkout.ok ? 0 : 1; }
      if (!sessionId) throw new Error(pick('绑定任务需要 --session <id>；只读查看请用 --preview', 'checkout binding requires --session <id>; use --preview for read-only output'));
      if (task.status !== 'active') throw new Error(reopenFirst(taskId, task.status));
      const binding = writeSessionBinding(hubRoot, sessionId, { project_id: task.project_id, task_id: taskId, source: 'cli_checkout' });
      emit(asJson ? { binding, checkout } : pick(`已切换到任务 ${taskId}。`, `Checked out task ${taskId}.`)); return 0;
    }
    if (command === 'compact') throw new Error(pick('此版本未接入同步 Hub 压缩命令。', 'Hub compaction runner is not wired in this build.'));
    throw new Error(pick('Hub 不支持此命令：', 'Unsupported Hub command: ') + command);
  } catch (error) { stderr(hubError(error.message)); return 1; }
}

export async function runCairnCliAsync(argv = process.argv.slice(2), io = {}) {
  const ioCwd = io.cwd ?? process.cwd();
  if (argv[0] === 'compact' && (argv.includes('--store') || (!argv.includes('--cwd') && path.resolve(ioCwd) === path.resolve(process.cwd())))) {
    const { stdout = msg => process.stdout.write(`${msg}\n`), stderr = msg => process.stderr.write(`${msg}\n`), llmClient = createOpenAICompatibleClient() } = io;
    try {
      const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { store: { type: 'string' }, full: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, cwd: { type: 'string' } } });
      const id = Number(parsed.positionals[0]);
      if (!Number.isSafeInteger(id) || id < 1 || parsed.positionals.length !== 1 || (argv.includes('--store') && !parsed.values.store)) throw new Error(usage('compact <id> [--full] [--store <path>]'));
      const hubRoot = resolveStoreRoot({ storeRoot: parsed.values.store });
      const task = readHubTasksIndex(hubRoot).tasks.find(item => item.id === id);
      if (!task) throw new Error(taskMissing(id));
      if (task.status !== 'active') throw new Error(reopenFirst(id, task.status, 'reopen'));
      const result = await runHubStrictCompactor({ hubRoot, taskId: id, mode: parsed.values.full ? 'full' : 'incremental', llmClient });
      stdout(JSON.stringify(result));
      return result.ok ? 0 : 1;
    } catch (error) { stderr(hubError(error.message)); return 1; }
  }
  if (argv[0] !== 'compact') return runCairnCli(argv, io);
  const { stdout = msg => process.stdout.write(`${msg}\n`), stderr = msg => process.stderr.write(`${msg}\n`), cwd = process.cwd(), llmClient = createOpenAICompatibleClient() } = io;
  const args = argv.slice(1).filter((arg, index, all) => !['--full', '--json', '--cwd'].includes(arg) && (index === 0 || all[index - 1] !== '--cwd'));
  const id = Number(args[0]);
  const full = argv.includes('--full');
  const cwdIndex = argv.indexOf('--cwd');
  try {
    if (!Number.isSafeInteger(id) || id < 1 || args.length !== 1 || (cwdIndex >= 0 && !argv[cwdIndex + 1])) throw new Error(usage('compact <id> [--full] [--cwd <dir>]'));
    const root = path.resolve(cwdIndex >= 0 ? argv[cwdIndex + 1] : cwd);
    const task = isCairnInitialized(root) ? readTasksIndex(root).tasks.find(entry => entry.id === id) : null;
    if (!task) throw new Error(taskMissing(id));
    if (task.status !== 'active') {
      stderr(reopenFirst(id, task.status));
      return 1;
    }
    const result = await runStrictCompactor({ workspaceRoot: root, taskId: id, mode: full ? 'full' : 'incremental', llmClient });
    stdout(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (err) { stderr(cliError(err.message)); return 1; }
}
