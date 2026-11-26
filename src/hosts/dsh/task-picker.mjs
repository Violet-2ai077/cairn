import { randomUUID } from 'node:crypto';
import { pick } from '../../i18n/locale.mjs';
import { sanitizeHubRoutingText } from '../../kernel/marker.mjs';
import { readHubTasksIndex, readSessionChoice, replaceSessionChoice, resolveHubPaths } from '../../kernel/hub-store.mjs';
import { taskPickerHint } from '../../workers/hub-cold-router.mjs';

const PAGE = 5;
const other = ['都不是，描述另一项任务', 'None of these; describe another task'];
const more = ['更多任务', 'More tasks'];
const cancel = ['取消', 'Cancel'];
const norm = text => text.normalize('NFKC').trim().toLowerCase();
const clean = text => sanitizeHubRoutingText(text).replace(/[\p{Cc}\p{Cf}<>|]/gu, '').slice(0, 100);

export const resumeIntent = text => /^(?:请\s*)?(?:继续|接着|(?:please\s+)?(?:continue|resume|go on|keep going)\b)/iu.test(text.trim());
export function genericResume(text) {
  if (!resumeIntent(text)) return false;
  const action = text.trim().replace(/^(?:请\s*)?(?:继续(?:吧|一下|做下去)?|接着(?:做|来)?|(?:please\s+)?(?:continue|resume|go on|keep going))\s*[,，;；:：]?\s*/iu, '').replace(/[.!！。?？…]+$/u, '').trim();
  if (/^(?:(?:上次|之前|刚才)的?(?:任务|工作)?|(?:the |our )?(?:last|previous) (?:task|work)|where we left off)$/iu.test(action)) return true;
  return !action || /^(?:(?:把|将)?(?:失败的|失败|没过的)测试(?:修好|修掉|修复)|(?:修复|修好)(?:失败的|失败)测试|(?:fix|rerun|check) (?:the )?failing tests?)$/iu.test(action);
}

function pageOf(root, pending, eligible, projects) {
  const paths = resolveHubPaths(root);
  return pending.ids.slice(pending.offset, pending.offset + PAGE).map((id, index) => {
    const task = eligible.find(t => t.id === id);
    const title = task ? clean(task.title) || pick('未命名任务', 'Untitled task') : pick('该任务已不可选', 'Task no longer available');
    let note = '';
    if (task) {
      try { note = taskPickerHint(paths, task); } catch { /* A preview is optional. */ }
    }
    const project = task && clean(projects.get(task.project_id) ?? task.project_id ?? 'general');
    return { id, title, available: Boolean(task), label: `${index + 1}. ${title} (#${id})`,
      description: task ? [project, note].filter(Boolean).join(' · ') : pick('请重新选择', 'Choose again') };
  });
}

function question(rows, pending) {
  const options = rows.map(({ label, description }) => ({ label, description }));
  if (pending.ids.length > PAGE) options.push({ label: pick(...more) });
  options.push({ label: pick(...other) }, { label: pick(...cancel) });
  return { id: pending.key, header: pick('确认任务',
    'Confirm task'), question: pick('你想继续哪项任务？',
    'Which task do you want to continue?'), multiSelect: false, options };
}

function menu(q, notice = '') {
  return [notice, q.question, ...q.options.map(o => o.description ? o.label + ' — ' + o.description : o.label),
    pick('回复列表序号、任务名或 #任务号即可。原请求已保留，无需重说。',
      'Reply with the list number, task name, or #task-ID. Your original request is saved; you do not need to repeat it.')].filter(Boolean).join('\n');
}

async function askUntilAborted(ask, request) {
  const { signal } = request;
  if (!signal) return ask(request);
  signal.throwIfAborted();
  let stop;
  const aborted = new Promise((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([ask(request), aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

function action(value, rows, pending, eligible) {
  const text = norm(value);
  if ([...cancel, '算了', '算了吧', '不用了', 'never mind'].some(v => norm(v) === text)) return { kind: 'cancel' };
  if ([...other, '都不是', 'other'].some(v => norm(v) === text)) return { kind: 'other' };
  if ([...more, '更多', 'more'].some(v => norm(v) === text) && pending.ids.length > PAGE) return { kind: 'more' };
  let row = rows.find(r => norm(r.label) === text);
  if (!row && /^\d+$/u.test(text)) row = rows[Number(text) - 1];
  const permitted = eligible.filter(t => pending.ids.includes(t.id));
  if (!row && /^#\d+$/u.test(text)) {
    const id = Number(text.slice(1));
    return permitted.some(t => t.id === id) ? { kind: 'select', id } : { kind: 'invalid' };
  }
  // A compound reply can change the instruction. Never strip it down to an accidental choice.
  if (!row && !/^#?\d+$/u.test(text)) {
    const name = text.replace(/(?:\s*那个(?:任务)?|\s*那项(?:任务)?)$/u, '').trim();
    const matches = permitted.filter(t => norm(clean(t.title)) === name || (name.length >= 2 && norm(clean(t.title)).includes(name)));
    if (matches.length === 1) return { kind: 'select', id: matches[0].id };
  }
  return row?.available ? { kind: 'select', id: row.id } : { kind: 'invalid' };
}

export async function pickTask(options) {
  const { root, sessionId, entry, payload, expectedEpoch, eligible, projects, candidates, ask, current } = options;
  let { pending } = options;
  const reply = (reason, text) => ({ reason, text });
  const save = (key, choice) => replaceSessionChoice(root, sessionId, key, choice);
  const stale = () => reply('choice_stale', pick('任务或会话已改变，未执行原请求。请重新指定任务。',
    'The task or session has changed. The original request was not executed. Specify the task again.'));
  if (pending && pending.epoch !== expectedEpoch) { save(pending.key, null); return stale(); }
  const answeringText = Boolean(pending && pending.turn !== entry.turn);
  if (!pending) {
    const ids = eligible.filter(t => !candidates?.length || candidates.includes(t.id)).map(t => t.id);
    if (!ids.length) return reply('no_candidates', pick('没有可继续的活动任务。请描述要做的事，或明确重开已关闭的任务。',
      'There are no active tasks to continue. Describe what you want to do or explicitly reopen a closed task.'));
    pending = { key: randomUUID(), epoch: expectedEpoch, turn: entry.turn, input: entry.input, ids,
      eligibleIds: eligible.map(t => t.id), offset: 0 };
    if (!save(null, pending)) return stale();
  }
  let rows = pageOf(root, pending, eligible, projects);
  let q = question(rows, pending);
  let value = answeringText ? entry.input : '';
  if (!answeringText && ask && payload.agent) {
    try {
      const answer = await askUntilAborted(ask, { agent: payload.agent, signal: payload.signal, questions: [q] });
      const items = answer?.answers;
      const item = items?.length === 1 && items[0]?.id === q.id ? items[0] : null;
      if (item?.selected?.length === 1 && !item.custom && q.options.some(o => o.label === item.selected[0])) value = item.selected[0];
      else if (item?.selected?.length === 0 && typeof item.custom === 'string') value = item.custom;
    } catch (error) {
      if (payload.signal?.aborted || error?.code === 'ASK_ABORTED') {
        save(pending.key, null);
        return reply('choice_cancelled', pick('已取消，未执行原请求。', 'Cancelled. The original request was not executed.'));
      }
      if (['DELEGATED_CALLER', 'CALLER_NOT_LIVE'].includes(error?.code)) {
        save(pending.key, null);
        return reply('choice_unavailable', pick('当前 Agent 不能代替用户选择任务；没有执行操作。',
          'This agent cannot select a task on behalf of the user. No action was taken.'));
      }
      // NO_PROVIDER (headless) and disconnected clients use the identical text menu.
    }
  }
  if (!current() || readSessionChoice(root, sessionId)?.key !== pending.key) {
    save(pending.key, null);
    return stale();
  }
  if (!value) return reply('awaiting_choice', menu(q));
  const choice = action(value, rows, pending, eligible);
  if (choice.kind === 'select') {
    const live = readHubTasksIndex(root).tasks.filter(t => t.status === 'active' && pending.eligibleIds.includes(t.id));
    if (!live.some(t => t.id === choice.id)) return reply('awaiting_choice',
      menu(question(pageOf(root, pending, live, projects), pending), pick('该任务已不可选，请重新选择。', 'That task is no longer available. Choose again.')));
  }
  if (choice.kind === 'select' || choice.kind === 'cancel') {
    if (!save(pending.key, null)) return stale();
    return choice.kind === 'cancel' ? reply('choice_cancelled', pick('已取消，未执行原请求。', 'Cancelled. The original request was not executed.'))
      : { id: choice.id, input: pending.input, originalTurn: pending.turn };
  }
  if (choice.kind === 'other' || choice.kind === 'more') {
    if (choice.kind === 'other' && pending.ids.length === pending.eligibleIds.length) {
      if (!save(pending.key, null)) return stale();
      return reply('choice_none', pick('已退出任务选择，未执行原请求。请描述另一项任务，或指定要继续的任务。',
        'Task selection closed. The original request was not executed. Describe another task or specify the one you want to continue.'));
    }
    const ids = choice.kind === 'other' ? pending.eligibleIds : pending.ids;
    const offset = choice.kind === 'more' && pending.offset + PAGE < ids.length ? pending.offset + PAGE : 0;
    const next = { ...pending, ids, offset, key: randomUUID() };
    if (!save(pending.key, next)) return stale();
    if (!answeringText && (offset !== pending.offset || ids.length !== pending.ids.length)) {
      return pickTask({ ...options, pending: next });
    }
    pending = next;
    rows = pageOf(root, pending, eligible, projects);
    q = question(rows, pending);
  }
  return reply('awaiting_choice', menu(q, choice.kind === 'invalid' ? pick('未能唯一对应到可选任务；没有执行操作。',
    'Your reply did not identify a single available task. No action was taken.') : pick('请选择或输入任务名。',
    'Choose a task or enter its name.')));
}

export async function* menuStream(text, showMarker) {
  const answer = text + (showMarker ? '\n<|task:UNRESOLVED|>' : '');
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: answer };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
