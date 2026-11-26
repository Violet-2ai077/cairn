import { pick } from '../../i18n/locale.mjs';
import { buildAntiRecencyContract, buildScopedAuthorityContract } from '../../i18n/contracts.mjs';
import { buildHubTaskCatalog,
  projectReadOnlyLedger, readHubTasksIndex, readProjectsIndex, readScopedHead, readSessionBinding } from '../../kernel/index.mjs';
import { readImmediateHubSnapshot } from '../../kernel/hub-write-lock.mjs';
import { selectHubTaskPools } from '../../kernel/task-heat.mjs';
import { compileHubTaskCheckout } from '../../workers/hub-task-checkout.mjs';

// dsh evaluates the catalog and project providers separately. Capture both
// portions once, so the latter never rereads a newer authority for that request.
export function captureCompatibilityContext(hubRoot, { state, sessionId, taskHeat, unresolved, maxTailChars }) {
  return readImmediateHubSnapshot(hubRoot, () => {
    const projects = new Map(readProjectsIndex(hubRoot).projects.map(p => [p.project_id, p.name]));
    const index = readHubTasksIndex(hubRoot);
    if (index.task_id_capacity) return { base: pick('扩展任务号需要 Autopilot TurnScope；当前兼容宿主不会执行或归档。',
      'Extended task IDs require Autopilot TurnScope. This compatibility host will not execute or archive the turn.'), local: '' };
    const { hot } = selectHubTaskPools(index.tasks, { policy: taskHeat });
    const catalog = buildHubTaskCatalog(hot.map(t => ({ ...t, project_name: projects.get(t.project_id) })));
    const nextMarker = '<|task:' + index.next_task_id + '|>';
    const creation = index.next_task_id <= 999 ? pick('用户明确开启不同新任务时输出 ' + nextMarker + '（下一个从未使用的 ID）。',
      'If the user explicitly starts a distinct new task, output ' + nextMarker + ' (the next unused ID). ') :
      pick('任务编号已用尽；不能新建或复用编号。', 'Task IDs are exhausted; do not create or reuse an ID. ');
    const base = [buildAntiRecencyContract() + '\n\n' + pick('Hub 建档规则：任务 marker 是宿主归档与建档的唯一触发器。继续已有任务时沿用其编号；',
      'Hub archive rules: only the task marker triggers host archival and task creation. To continue an existing task, use its ID. ') +
      creation + pick('若无法区分已有任务则输出 <|task:UNRESOLVED|> 并澄清，不得猜测。',
        'If you cannot distinguish between existing tasks, output <|task:UNRESOLVED|> and ask for clarification. Do not guess.'),
      buildScopedAuthorityContract({ userLedgerSnapshot: projectReadOnlyLedger(readScopedHead(hubRoot)), includeProject: false }), catalog
    ].filter(Boolean).join('\n\n');
    const binding = sessionId && readSessionBinding(hubRoot, sessionId);
    if (unresolved || (state?.taskId && (!binding || binding.task_id !== state.taskId ||
        binding.project_id !== state.selectedProjectId || !index.tasks.some(t => t.id === state.taskId && t.status === 'active')))) {
      return { base, local: pick('Cairn 路由尚未确认。请澄清目标；输出 <|task:UNRESOLVED|>，不要新建任务。',
        'Cairn has not confirmed the target task. Ask for clarification, output <|task:UNRESOLVED|>, and do not create a task.') };
    }
    const local = [];
    if (state?.selectedProjectId) local.push(buildScopedAuthorityContract({ includeUser: false,
      projectLedgerSnapshot: projectReadOnlyLedger(readScopedHead(hubRoot, { scope: 'project', projectId: state.selectedProjectId })),
      projectName: projects.get(state.selectedProjectId) }));
    if (state?.taskId) {
      const checkout = compileHubTaskCheckout({ hubRoot, taskId: state.taskId, maxTailChars });
      if (!checkout.ok || checkout.project_id !== state.selectedProjectId) throw new Error('task_history_inconsistent');
      local.push('<cairn_task_checkout task_id="' + state.taskId + '" project_id="' + (state.selectedProjectId ?? 'general') +
        '">\n' + checkout.text + '\n</cairn_task_checkout>');
    }
    return { base, local: local.join('\n\n') };
  });
}
