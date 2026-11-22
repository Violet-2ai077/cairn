// Cairn Workers: Cross-Session Cold-Start Semantic Task Router (src/workers/cold-router.mjs)
// Physically strips recency/volume metadata (`updated_at`, `turn_count`, `birth_turn`) from
// task catalog cards before LLM routing, enforces SYSTEM_C1 Anti-Recency / Anti-Primacy rules,
// short-circuits when the task catalog is empty, and strictly validates returned JSON & task IDs.

import {
  isCairnInitialized,
  initCairnStore,
  normalizeTaskId,
  readTasksIndex,
  readTaskCompaction,
  readTaskThread,
  upsertTask
} from '../kernel/index.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';
import { truncateHeadTail } from './distill.mjs';

const VALID_ROUTER_DECISIONS = new Set(['match', 'new', 'ambiguous']);

/**
 * Compiles sanitized task cards for cold-start routing.
 * Physically excludes `updated_at`, `turn_count`, and `birth_turn` to prevent Recency/Primacy leakage.
 */
export function buildSanitizedTaskCards(
  workspaceRoot = process.cwd(),
  tasks = [],
  { includePreview = true, maxPreviewChars = 200 } = {}
) {
  const sorted = [...tasks].sort((a, b) => normalizeTaskId(a.id) - normalizeTaskId(b.id));
  return sorted.map(t => {
    const id = normalizeTaskId(t.id);
    const card = {
      id,
      title: String(t.title ?? '').trim() || `Task ${id}`,
      status: String(t.status ?? 'active').trim() || 'active'
    };

    if (includePreview) {
      let previewText = '';
      if (typeof t.preview === 'string' && t.preview.trim()) {
        previewText = t.preview.trim();
      } else {
        const compact = readTaskCompaction(workspaceRoot, id);
        if (compact && compact.trim()) {
          previewText = compact.trim().replace(/\s+/g, ' ');
        } else {
          const thread = readTaskThread(workspaceRoot, id);
          if (thread.length > 0) {
            const firstMsg = String(thread[0].content ?? '').trim();
            const lastMsg =
              thread.length > 1 ? String(thread[thread.length - 1].content ?? '').trim() : '';
            previewText = [firstMsg, lastMsg]
              .filter(Boolean)
              .join(' | ')
              .replace(/\s+/g, ' ');
          }
        }
      }
      if (previewText) {
        card.preview = truncateHeadTail(previewText, maxPreviewChars, ' ... ');
      }
    }

    return card;
  });
}

/**
 * Builds the system prompt for cross-session cold-start semantic routing.
 * Physically strips any `updated_at` or `turn_count` fields if raw task objects are passed.
 */
export function buildColdRouterPrompt(taskCards = []) {
  const sanitizedCards = [...taskCards]
    .map(c => {
      const id = normalizeTaskId(c.id);
      const clean = {
        id,
        title: String(c.title ?? '').trim() || `Task ${id}`,
        status: String(c.status ?? 'active').trim() || 'active'
      };
      if (typeof c.preview === 'string' && c.preview.trim()) {
        clean.preview = truncateHeadTail(c.preview.trim(), 200, ' ... ');
      }
      return clean;
    })
    .sort((a, b) => a.id - b.id);

  return `你是跨会话冷启动任务语义路由器（Cold-Start Task Semantic Router）。
你的职责是：根据工作区已确立的静态任务目录（established_tasks）与用户在新会话中的首条请求（opening_user_request），判定该请求属于继续某一个既有任务、存在多任务歧义、还是开启一项全新独立任务。

你必须仅输出一个合法的原始 JSON 对象，严禁使用 Markdown 代码围栏（如 \`\`\`json），严禁在 JSON 前后附加任何解释文字。输出格式严格为：
{"decision":"match"|"new"|"ambiguous","task_id":<正整数或null>,"candidates":[<候选任务ID正整数数组>],"reason":"<简明判定依据>"}

### 严格反默认归属与路由纪律（Anti-Recency / Anti-Primacy Cold-Routing Contract）
1. 唯一匹配（"decision": "match"）：仅当用户请求包含能够唯一区分某一个既有任务的具体内容线索（或明确点名该任务编号/唯一特征）时，返回 "decision": "match"，"task_id": <该任务ID>，"candidates": [<该任务ID>]。
2. 多任务歧义澄清（"decision": "ambiguous"）：当用户请求仅匹配多个已有任务的共享特征、缺乏唯一区分证据，或在存在多个任务时仅发出泛化延续指令（如“继续上次那个”、“把刚才的改完”）时，严禁按编号大小（Primacy）或任何猜测做默认归属，必须返回 "decision": "ambiguous"，"task_id": null，"candidates": [<所有匹配或候选的任务ID正整数列表>]。
3. 全新独立任务（"decision": "new"）：当用户请求明确开启一项与既有任务均无关的全新工作目标时，返回 "decision": "new"，"task_id": null，"candidates": []。

### 已确立的静态任务目录（established_tasks，按 ID 升序排列，无时间戳）
${JSON.stringify(sanitizedCards, null, 2)}`;
}

export async function runColdRouter({
  workspaceRoot = process.cwd(),
  userPrompt = '',
  includeCompactPreview = true,
  applyWorkAnchor = false,
  llmClient = null,
  reasoningEffort,
  signal
} = {}) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }

  const tasksIndex = readTasksIndex(workspaceRoot);
  if (tasksIndex.tasks.length === 0) {
    return {
      ok: true,
      decision: 'new',
      task_id: null,
      candidates: [],
      reason: 'empty_task_catalog',
      llm_called: false
    };
  }

  const sanitizedCards = buildSanitizedTaskCards(workspaceRoot, tasksIndex.tasks, {
    includePreview: includeCompactPreview
  });
  const systemPrompt = buildColdRouterPrompt(sanitizedCards);
  const userMessage = `### 新会话首条用户请求（opening_user_request）\n${String(userPrompt ?? '').trim()}`;

  const client = llmClient ?? createOpenAICompatibleClient();
  const llmRes = await client.complete({
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    temperature: 0,
    reasoningEffort,
    signal
  });

  if (!llmRes.ok) {
    return {
      ok: false,
      decision: null,
      task_id: null,
      candidates: [],
      reason: null,
      llm_called: true,
      error_code: llmRes.error_code,
      error: llmRes.error_message
    };
  }

  const rawTrimmed = String(llmRes.content ?? '').trim();
  if (rawTrimmed.startsWith('```')) {
    return {
      ok: false,
      decision: null,
      task_id: null,
      candidates: [],
      reason: null,
      llm_called: true,
      error_code: 'markdown_fence_forbidden',
      error: 'Cold router output wrapped in Markdown code fence is strictly forbidden',
      raw_output: llmRes.content
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawTrimmed);
  } catch (err) {
    return {
      ok: false,
      decision: null,
      task_id: null,
      candidates: [],
      reason: null,
      llm_called: true,
      error_code: 'strict_json_parse_failed',
      error: err.message,
      raw_output: llmRes.content
    };
  }

  const decision = parsed?.decision;
  if (!VALID_ROUTER_DECISIONS.has(decision)) {
    return {
      ok: false,
      decision: null,
      task_id: null,
      candidates: [],
      reason: null,
      llm_called: true,
      error_code: 'invalid_router_decision',
      error: `Invalid decision "${String(decision)}" (expected "match" | "new" | "ambiguous")`,
      raw_output: llmRes.content
    };
  }

  const validIdSet = new Set(tasksIndex.tasks.map(t => t.id));
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';

  if (decision === 'match') {
    const matchedId =
      typeof parsed.task_id === 'number' && Number.isInteger(parsed.task_id)
        ? parsed.task_id
        : null;
    if (matchedId === null || !validIdSet.has(matchedId)) {
      return {
        ok: false,
        decision: null,
        task_id: null,
        candidates: [],
        reason: null,
        llm_called: true,
        error_code: 'invalid_routed_task_id',
        error: `Routed task_id ${String(parsed.task_id)} does not exist in tasks/index.json`,
        raw_output: llmRes.content
      };
    }

    if (applyWorkAnchor) {
      upsertTask(workspaceRoot, { work_anchor_task_id: matchedId });
    }

    return {
      ok: true,
      decision: 'match',
      task_id: matchedId,
      candidates: [matchedId],
      reason,
      llm_called: true
    };
  }

  if (decision === 'ambiguous') {
    if (parsed.task_id !== null && parsed.task_id !== undefined) {
      return {
        ok: false,
        decision: null,
        task_id: null,
        candidates: [],
        reason: null,
        llm_called: true,
        error_code: 'ambiguous_must_have_null_task_id',
        error: 'Ambiguous decision must have task_id: null',
        raw_output: llmRes.content
      };
    }
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates.filter(cid => typeof cid === 'number' && validIdSet.has(cid))
      : [];
    if (
      !Array.isArray(parsed.candidates) ||
      candidates.length < 2 ||
      candidates.length !== parsed.candidates.length
    ) {
      return {
        ok: false,
        decision: null,
        task_id: null,
        candidates: [],
        reason: null,
        llm_called: true,
        error_code: 'invalid_ambiguous_candidates',
        error: 'Ambiguous decision must list >= 2 valid candidate task IDs from tasks/index.json',
        raw_output: llmRes.content
      };
    }

    return {
      ok: true,
      decision: 'ambiguous',
      task_id: null,
      candidates,
      reason,
      llm_called: true
    };
  }

  // decision === 'new'
  if (parsed.task_id !== null && parsed.task_id !== undefined) {
    return {
      ok: false,
      decision: null,
      task_id: null,
      candidates: [],
      reason: null,
      llm_called: true,
      error_code: 'new_must_have_null_task_id',
      error: 'New decision must have task_id: null',
      raw_output: llmRes.content
    };
  }

  return {
    ok: true,
    decision: 'new',
    task_id: null,
    candidates: [],
    reason,
    llm_called: true
  };
}
