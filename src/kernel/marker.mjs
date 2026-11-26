// Cairn Kernel: Inline Task Tail-Marker Parser & Display Stripper (src/kernel/marker.mjs)
// Extracts and strips trailing <|task:N|> (N in 1..999) or <|task:UNRESOLVED|> markers.
// Fixes the TC5-B t3 closed-fence false negative: permits answers ending with a properly closed
// Markdown code fence (paired ```) when the tail marker sits on its own trailing line outside the fence,
// while strictly rejecting markers trapped inside an unclosed code fence.

import { EXTENDED_TASK_CAPACITY } from './hub-task-ids.mjs';

const MARKER_PREFIX_GLOBAL_REGEX = /<\|task:/g;
const TRAILING_MARKER_EXEC_REGEX = /<\|task:([1-9][0-9]{0,2}|UNRESOLVED)\|>\s*$/;

// Scan top-level fenced blocks on the untrimmed input: four leading spaces
// are significant, as are the opener's character and minimum closing length.
function scanFences(text) {
  let open = '', endsWithClosingFence = false;
  for (const line of text.split(/\r\n|[\r\n]/u)) {
    if (!line.trim()) continue;
    endsWithClosingFence = false;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!match) continue;
    const [, run, rest] = match;
    if (!open) {
      if (run[0] !== '`' || !rest.includes('`')) open = run;
    } else if (run[0] === open[0] && run.length >= open.length && /^[ \t]*$/u.test(rest)) {
      open = '';
      endsWithClosingFence = true;
    }
  }
  return { open, endsWithClosingFence };
}

/**
 * Parses and validates an assistant response ending with `<|task:N|>` or `<|task:UNRESOLVED|>`.
 *
 * @param {string} content - Raw assistant completion content.
 * @returns {{
 *   valid: boolean,
 *   error: string | null,
 *   marker: string | null,
 *   is_unresolved: boolean,
 *   task_number: number | null,
 *   answer: string | null,
 *   display_text: string,
 *   closed_fence_before_marker: boolean
 * }}
 */
export function parseTaskMarker(content) {
  if (typeof content !== 'string') {
    return {
      valid: false,
      error: 'not_string',
      marker: null,
      is_unresolved: false,
      task_number: null,
      answer: null,
      display_text: '',
      closed_fence_before_marker: false
    };
  }

  const allMarkerPrefixes = content.match(MARKER_PREFIX_GLOBAL_REGEX) ?? [];
  const match = TRAILING_MARKER_EXEC_REGEX.exec(content);

  if (allMarkerPrefixes.length !== 1 || !match) {
    return {
      valid: false,
      error: 'missing_duplicate_or_malformed_marker',
      marker: null,
      is_unresolved: false,
      task_number: null,
      answer: null,
      display_text: content,
      closed_fence_before_marker: false
    };
  }

  const rawBeforeMarker = content.slice(0, match.index);
  const answer = rawBeforeMarker.trim();

  if (!answer) {
    return {
      valid: false,
      error: 'empty_answer_body',
      marker: null,
      is_unresolved: false,
      task_number: null,
      answer: null,
      display_text: content,
      closed_fence_before_marker: false
    };
  }

  const { open, endsWithClosingFence } = scanFences(rawBeforeMarker);
  if (open) {
    return {
      valid: false,
      error: 'marker_inside_unclosed_code_fence',
      marker: null,
      is_unresolved: false,
      task_number: null,
      answer: null,
      display_text: content,
      closed_fence_before_marker: false
    };
  }

  if (endsWithClosingFence) {
    // When the answer body ends with a closed code fence, the tail marker must occupy
    // its own trailing line (separated by a newline from the closing ``` delimiter).
    if (!/\r?\n[ \t]*$/.test(rawBeforeMarker)) {
      return {
        valid: false,
        error: 'marker_not_on_own_line_after_closed_fence',
        marker: null,
        is_unresolved: false,
        task_number: null,
        answer: null,
        display_text: content,
        closed_fence_before_marker: false
      };
    }
  }

  const marker = match[1];
  const isUnresolved = marker === 'UNRESOLVED';
  const taskNumber = isUnresolved ? null : Number.parseInt(marker, 10);

  return {
    valid: true,
    error: null,
    marker,
    is_unresolved: isUnresolved,
    task_number: taskNumber,
    answer,
    display_text: answer,
    closed_fence_before_marker: endsWithClosingFence
  };
}

/**
 * Strips a valid trailing `<|task:N|UNRESOLVED|>` marker for clean UI display.
 * If the content does not contain a valid trailing marker, returns the original string untouched.
 *
 * @param {string} content - Raw assistant completion content.
 * @returns {string} Clean display text without the trailing task marker.
 */
export function stripTaskMarker(content) {
  const parsed = parseTaskMarker(content);
  return parsed.valid ? parsed.display_text : String(content ?? '');
}

/**
 * Compiles a deterministic, read-only 1-line-per-task catalog header from confirmed tasks
 * to amortize the long-gap online CoT re-scan tax identified in TC3-B.
 *
 * @param {Array<{ id: string | number, title: string, birth_turn?: number, status?: string }>} tasks
 * @returns {string}
 */
export function buildLightTaskCatalog(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return '';
  }
  const lines = tasks.filter(t => (t?.status ?? 'active') === 'active').map(t => {
    const id = String(t.id).trim();
    const title = String(t.title ?? '').trim();
    const birthSuffix =
      typeof t.birth_turn === 'number' ? ` (established turn ${t.birth_turn})` : '';
    return `- <|task:${id}|>: ${title}${birthSuffix}`;
  });
  return `Read-only established task catalog (for reference only; do not echo this catalog):\n${lines.join('\n')}`;
}

export function buildHubTaskCatalog(tasks = []) {
  if (!Array.isArray(tasks)) return '';
  const cards = buildHubRoutingCards(tasks).filter(card => card.task_id <= 999);
  if (!cards.length) return '';
  const lines = cards.map(card => {
    const project = card.project_id ? ` [project:${card.project_name}; id:${card.project_id}]` : ' [general]';
    return `- <|task:${card.task_id}|>${project}: ${card.title}`;
  });
  return `Read-only global active task catalog (reference only; do not echo):\n${lines.join('\n')}`;
}

export function sanitizeHubRoutingText(value) {
  return String(value ?? '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?(?:<\/system-reminder>|$)/giu, '')
    .replace(/\[\s*(?:(?:#\d+|turn\s*=\s*\d+)(?:\s+|(?=\])))+(?:(?:user|assistant|tool)\s*)?\]/giu, '')
    .replace(/\b(?:established\s+turn|turn\s*#|seq\s*#)\s*\d+|\[turn\s+\d+\]|\b\d+\s+turns?\s+ago\b/giu, '')
    .replace(/\b(?:created[_ ]at|updated[_ ]at|last[_ ]activity[_ ]at|timestamp|birth[_ ]turn|turn[_ ]count|seq(?:uence)?(?:[_ ]count)?|record[_ ]count|compacted[_ ]record[_ ]count|age(?:[_ ]days)?|heat(?:[_ ]score)?|recency(?:[_ ]score)?|turn)\b["']?\s*[:=]\s*["']?(?:\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)?|\d+(?:\.\d+)?)(?:["'])?/giu, '')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/giu, '')
    .replace(/\s+/gu, ' ').trim();
}

export function buildHubRoutingCards(tasks) {
  return tasks.filter(task => (task?.status ?? 'active') === 'active')
    .map(task => ({
      task_id: Number(task.id),
      project_id: task.project_id ?? null,
      project_name: sanitizeHubRoutingText(task.project_name ?? task.project_id ?? 'general').slice(0, 120),
      title: sanitizeHubRoutingText(task.title).slice(0, 200),
      preview: sanitizeHubRoutingText(task.preview).slice(0, 200)
    })).filter(card => Number.isSafeInteger(card.task_id) && card.task_id >= 1 && card.task_id <= EXTENDED_TASK_CAPACITY)
    .sort((a, b) => a.task_id - b.task_id);
}
