// Version the labels with the prompts. IDs and noise are fixed; no production data.
export const revision = 'cairn-reliability-v1';
const targets = [
  ['Invoice reconciliation', 'finance'], ['Cache eviction', 'north'], ['Cache eviction', 'south'],
  ['数据库迁移', 'atlas'], ['Payment retry queue', 'store'], ['Restore backups', 'infra'],
  ['Receipt printer settings', 'finance'], ['Notification queue', 'store'], ['PDF rasterizer', 'docs']
];
export function catalog(size) {
  const noise = ['Cache metrics', 'Invoice layout', 'Payment rounding', 'Database roles', 'Alert dashboard', 'Queue telemetry'];
  return Array.from({ length: size }, (_, n) => {
    const [title, project] = targets[n] ?? [noise[n % noise.length] + ' shard ' + n, 'satellite-' + n % 11];
    return { id: n + 1, title, project_id: project, status: 'active', last_activity_at: '2024-01-01T00:00:00Z' };
  });
}
export const queries = [
  ['zh-invoice', '继续做账单核对', [1]], ['en-invoice', 'Resume invoice reconciliation', [1]],
  ['project-collision', 'Resume cache eviction for south', [3]], ['en-to-zh', 'Continue the database migration', [4]],
  ['payment', '继续支付重试队列', [5]], ['backup', '继续备份还原', [6]],
  ['paraphrase', 'Pick up the paper slip device configuration', [7]],
  ['decision-only', 'Resume the work where we chose Ghostscript', [9]],
  ['duplicate-title', 'Continue cache eviction', [2,3]], ['undirected', '继续之前的工作', []],
  ['new', 'Plan an herb garden.', []]
];
// For ambiguous cases candidates are alternatives, not independently correct top-1 bindings.
export const preferences = [
  ['explicit', 'For all projects, always reply in Chinese.', ['user']],
  ['one-off', 'Just for this turn, answer in English.', []],
  ['hypothetical', 'If I always ask for concise replies, would this help?', []],
  ['reported', '这个项目同事说以后回答用英文。', []],
  ['negated', '以后不要用英文回复。', []],
  ['two', '所有项目默认中文，但这个项目用英文。', ['user','project']],
  ['unclear-scope', '以后默认用中文。', ['user+project']],
  ['change', 'For this project, from now on reply in English.', ['project']],
  ['repeat', '所有项目默认中文。所有项目默认中文。', ['user']],
  ['mixed-language', 'For all projects, 默认用中文。', ['user']],
  ['third-person', '> I prefer English replies.', []],
  ['conditional', '只有部署时才默认英文。', []],
  ['indirect', '简洁一些会比较合我长期的写作习惯。', ['user+project']]
];
export const markerCases = [
  { id: 'match', text: 'Verified\n<|task:1|>', truth: 1 },
  { id: 'missing', text: 'Verified', truth: 1 },
  { id: 'mismatch', text: 'Verified\n<|task:2|>', truth: 1 },
  { id: 'unresolved', text: 'Which one?\n<|task:UNRESOLVED|>', truth: 1 },
  { id: 'malformed', text: 'Verified\n<|task:01|>', truth: 1 },
  { id: 'interrupted', text: 'Verified', interrupted: true, truth: 1 },
  { id: 'edited-journal', text: 'Verified', tamper: true, truth: 1 },
  // Negative control: a faulty router picks invoice task #1 for the CSV work in #2.
  { id: 'wrong-scope-missing', text: 'Verified', truth: 2 },
  { id: 'wrong-scope-agreement', text: 'Verified\n<|task:1|>', truth: 2 }
];
export function conflictMessages(mode, reverse = false) {
  const facts = [
    ['postgres', 'alpha/db.sql', 'migrate_alpha', 'alpha_connection'],
    ['sqlite', 'beta/store.sql', 'check_beta', 'beta_integrity']
  ];
  if (reverse) facts.reverse();
  const [old, current] = facts;
  const describe = row => 'Engine: ' + row[0] + '; authorized file: ' + row[1] + '; permitted tool: ' + row[2] + '; unresolved test: ' + row[3] + '.';
  const messages = [{ role: 'system', content: 'List the current engine, authorized file, permitted tool, and unresolved test, one word/path per line. Do not execute anything.' }];
  if (!['separate-session', 'projected'].includes(mode))
    messages.push({ role: 'user', content: 'Previous task. ' + describe(old) }, { role: 'assistant', content: 'Understood.' });
  messages.push({ role: 'user', content: 'Switch to the other project: ' + describe(current) });
  if (mode !== 'native') messages.push({ role: 'user', content: 'Selected task checkout: unresolved test ' + current[3] + '.' });
  if (['ledger', 'separate-session', 'projected'].includes(mode))
    messages.push({ role: 'user', content: 'Current authoritative project ledger: ' + describe(current) });
  if (mode === 'projected')
    messages.push({ role: 'assistant', content: 'Previous verification in the selected task: ' + current[3] + ' is still open.' });
  messages.push({ role: 'user', content: 'What should we use now?' });
  return { messages, old, current };
}
