import { readTurnReceipts } from '../../kernel/hub-store.mjs';
import { pick } from '../../i18n/locale.mjs';

export function freshSessionReply(taskId) {
  return pick('当前模式不混用不同任务或归属不明的原生历史。请打开全新 dsh 会话（不要恢复或 fork 当前会话），' +
    (taskId ? '输入“继续任务 #' + taskId + '”并重述请求。' : '并重述目标任务和请求。') + '没有执行本轮操作。',
    'This mode cannot mix native history from different or unidentified tasks. Open a new dsh session (do not resume or fork this one), ' +
    (taskId ? 'enter "continue task #' + taskId + '", and repeat your request. ' : 'then restate the target task and request. ') +
    'No action was taken this turn.');
}

// Do not edit native messages: even one missing tool call/result breaks replay.
// A skipped, ambiguous or interrupted earlier turn can still be in the native prefix.
export function hasSingleTaskHistory(hubRoot, session, sessionId, turn, taskId) {
  if (!sessionId || session?.id !== sessionId || session.inheritedEventCount !== 0 ||
      !Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(taskId)) return false;
  for (let i = turn - 1; i > 0; i--) {
    const prior = readTurnReceipts(hubRoot, sessionId, i);
    if (prior?.turn !== i || prior.status !== 'archived' || prior.reason !== 'confirmed_marker' || prior.task_id !== taskId) return false;
  }
  return true;
}
