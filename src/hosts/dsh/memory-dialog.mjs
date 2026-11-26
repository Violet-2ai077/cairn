import { listMemoryReviews, readMemoryReview, resolveMemoryReview } from '../../kernel/memory-review.mjs';
import { pick } from '../../i18n/locale.mjs';

const choices = { user: ['所有项目', 'All projects'], project: ['仅本项目', 'This project only'], skip: ['跳过', 'Skip'] };
const labels = Object.fromEntries(Object.entries(choices).map(([key, names]) => [key, pick(...names)]));
const actions = new Map(Object.entries(choices).flatMap(([key, names]) => [key, ...names].map(n => [n.toLowerCase(), key])));
actions.set('仅当前项目', 'project');
const idPattern = /^\d{1,12}\.[1-8]$/u;
const states = {
  preparing: pick('准备中，尚未生效', 'Preparing; not yet in effect'),
  pending: pick('待确认，尚未生效', 'Awaiting confirmation; not yet in effect'),
  applying: pick('确认处理中', 'Applying confirmation'),
  committed: pick('已生效', 'In effect'),
  skipped: pick('已跳过，未保存', 'Skipped; not saved'),
  discarded: pick('提案已移除，未保存', 'Proposal removed; not saved'),
  conflict: pick('账本已变化或有同名规则；未覆盖，请重新提出', 'Ledger changed or a rule with this key exists; nothing overwritten. Propose it again.'),
  worker_failed: pick('提取失败，未保存', 'Extraction failed; not saved'),
  no_proposal: pick('未形成单条可保存偏好', 'No single preference could be proposed')
};
const quoteText = text => pick('「' + text + '」', '“' + text + '”');
export function memoryNotice(cards, turn) {
  if (!cards.length) return '';
  const rows = cards.map((card, i) => (turn + '.' + (i + 1)) + pick('', ' ') + quoteText(card.quote) + pick('：', ': ') +
    (card.scopes.length > 1 ? pick('仅本项目，还是所有项目？', 'This project only or all projects?') : labels[card.scopes[0]]));
  return '\n\n' + pick('长期记忆尚未生效；可以继续工作，不必现在答复。',
    'Long-term memory is not yet in effect. You can keep working without answering now.') + '\n' + rows.join('\n') +
    (cards.length === 1 && cards[0].scopes.length > 1 ? '\n' + pick('下一条也可直接回复「仅本项目」或「所有项目」。',
      'You can also reply "This project only" or "All projects" in your next message.') : '') +
    '\n' + pick('归档后发送「记忆 编号 范围」确认该条，或「记忆 编号 跳过」。发送「查看记忆」核对提案。',
      'After archival, send "memory ID project" or "memory ID user" to confirm the scope, or "memory ID skip" to skip. Send "view memory" to review proposals.');
}

export function memoryReply(text) {
  const input = text.trim().toLowerCase();
  if (['查看记忆', 'view memory'].includes(input)) return [];
  if (actions.has(input) && !['project', 'user'].includes(input) && actions.get(input) !== 'skip') return [null, input];
  const match = /^(?:记忆|memory)\s+(\d{1,12}\.[1-8])(?:\s+(.+))?$/u.exec(input);
  if (!match || (/\s/u.test(match[2] ?? '') && !actions.has(match[2]))) return null;
  return match.slice(1).filter(Boolean);
}
function describe(row) {
  const scope = row.chosen ?? (row.scopes.length === 1 ? row.scopes[0] : null);
  const target = scope === 'project' ? labels.project + ' (' + row.projectId + ')' : labels[scope] ?? labels.project + ' / ' + labels.user;
  return row.id + pick('', ' ') + quoteText(row.quote) + ' — ' + target + pick('；', '; ') + states[row.status] +
    (row.op ? ' [' + row.op.key + '=' + row.op.option_code + ']' : '');
}
export function memoryCommand(root, session, args) {
  try {
    if (!session) throw new Error('session_id_required');
    if (!args.length) {
      const rows = listMemoryReviews(root, session);
      return { kind: 'success', text: rows.length ? rows.map(describe).join('\n') : pick('本会话没有待确认的记忆。', 'No memory proposals await confirmation in this session.') };
    }
    const id = args[0];
    const action = args.slice(1).join(' ').toLowerCase();
    if (!idPattern.test(id) || (action && !actions.has(action))) throw new Error(pick('使用：记忆 编号 [仅本项目|所有项目|跳过]', 'Usage: memory ID [project|user|skip]'));
    const row = action ? resolveMemoryReview(root, session, id, actions.get(action)) : readMemoryReview(root, session, id);
    if (!row) throw new Error('memory_not_found');
    return { kind: 'success', text: describe(row) };
  } catch (error) { return { kind: 'error', text: pick('记忆操作未执行：', 'Memory action not performed: ') + error.message }; }
}
