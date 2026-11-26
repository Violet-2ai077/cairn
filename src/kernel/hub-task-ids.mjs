export const MARKER_BANK_SIZE = 999;
export const EXTENDED_TASK_CAPACITY = MARKER_BANK_SIZE * 1000;

export function normalizeHubTaskId(value) {
  const text = String(value ?? '').trim(), id = Number(text);
  if (!/^[1-9]\d{0,5}$/u.test(text) || id > EXTENDED_TASK_CAPACITY) throw new Error('invalid_task_id');
  return id;
}
export const markerBank = id => Math.floor((normalizeHubTaskId(id) - 1) / MARKER_BANK_SIZE);
export const markerAlias = id => (normalizeHubTaskId(id) - 1) % MARKER_BANK_SIZE + 1;
