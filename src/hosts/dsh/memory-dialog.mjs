import { listMemoryReviews, readMemoryReview, resolveMemoryReview } from '../../kernel/memory-review.mjs';

const labels = { user: '所有项目', project: '仅本项目', skip: '跳过' };
const actions = new Map([...Object.entries(labels).flatMap(([k, v]) => [[k, k], [v, k]]), ['仅当前项目', 'project']]);
const idPattern = /^\d{1,12}\.[1-8]$/u;
const states = { preparing: '准备中，尚未生效', pending: '待确认，尚未生效', applying: '确认处理中',
  committed: '已生效', skipped: '已跳过，未保存', discarded: '提案已移除，未保存',
  conflict: '账本已变化或有同名规则；未覆盖，请重新提出', worker_failed: '提取失败，未保存', no_proposal: '未形成单条可保存偏好' };
export function memoryNotice(cards, turn) {
  if (!cards.length) return '';
  const rows = cards.map((card, i) => (turn + '.' + (i + 1)) + '「' + card.quote + '」：' +
    (card.scopes.length > 1 ? '仅本项目，还是所有项目？' : labels[card.scopes[0]]));
  return '\n\n长期记忆尚未生效；可以继续工作，不必现在答复。\n' + rows.join('\n') +
    (cards.length === 1 && cards[0].scopes.length > 1 ? '\n下一条也可直接回复「仅本项目」或「所有项目」。' : '') +
    '\n归档后发送「记忆 编号 范围」确认该条，或「记忆 编号 跳过」。发送「查看记忆」核对提案。';
}

export function memoryReply(text) {
  const input = text.trim();
  if (input === '查看记忆') return [];
  if (['仅本项目', '仅当前项目', '所有项目'].includes(input)) return [null, input];
  const match = /^记忆\s+(\d{1,12}\.[1-8])(?:\s+(\S+))?$/u.exec(input);
  return match ? match.slice(1).filter(Boolean) : null;
}
function describe(row) {
  const scope = row.chosen ?? (row.scopes.length === 1 ? row.scopes[0] : null);
  const target = scope === 'project' ? labels.project + ' (' + row.projectId + ')' : labels[scope] ?? '仅本项目 / 所有项目';
  return row.id + '「' + row.quote + '」 — ' + target + '；' + states[row.status] +
    (row.op ? ' [' + row.op.key + '=' + row.op.option_code + ']' : '');
}
export function memoryCommand(root, session, args) {
  try {
    if (!session) throw new Error('session_id_required');
    if (!args.length) {
      const rows = listMemoryReviews(root, session);
      return { kind: 'success', text: rows.length ? rows.map(describe).join('\n') : '本会话没有待确认的记忆。' };
    }
    const [id, action] = args;
    if (!idPattern.test(id) || args.length > 2 || (action && !actions.has(action))) throw new Error('使用：记忆 编号 [仅本项目|所有项目|跳过]');
    const row = action ? resolveMemoryReview(root, session, id, actions.get(action)) : readMemoryReview(root, session, id);
    if (!row) throw new Error('memory_not_found');
    return { kind: 'success', text: describe(row) };
  } catch (error) { return { kind: 'error', text: '记忆操作未执行：' + error.message }; }
}
