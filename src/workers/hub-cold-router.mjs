import { readHubTaskCompaction, readHubTaskThread, readHubTasksIndex, normalizeTaskId } from '../kernel/index.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';
import { truncateHeadTail } from './distill.mjs';

export function buildHubColdRouterPrompt(tasks, { cwdProjectHint = null } = {}) {
  const cards = tasks.filter(t => t.status === 'active').map(t => ({
    task_id: normalizeTaskId(t.id), project_id: t.project_id ?? null, project_name: t.project_name ?? (t.project_id ?? 'general'),
    title: String(t.title ?? '').trim(), preview: String(t.preview ?? '').slice(0, 200)
  })).sort((a, b) => a.task_id - b.task_id);
  return `Route the opening request to an active task, or classify as new/ambiguous. cwdProjectHint is only a soft prior, never a forced match. Return strict JSON: {"decision":"match|new|ambiguous","task_id":number|null,"project_id":string|null,"candidates":[number],"reason":"short"}. Match requires unique semantic evidence; ambiguity must not default.\ncwdProjectHint=${JSON.stringify(cwdProjectHint)}\nCandidates (no timestamps or turn counts):\n${JSON.stringify(cards)}`;
}

export async function runHubColdRouter({ hubRoot, userPrompt = '', cwdProjectHint = null, llmClient = null, signal } = {}) {
  const tasks = readHubTasksIndex(hubRoot).tasks.filter(t => t.status === 'active');
  if (!tasks.length) return { ok: true, decision: 'new', task_id: null, project_id: null, candidates: [], reason: 'empty_task_catalog', llm_called: false };
  const projects = new Map();
  // Reading the index is side-effect free; no project is registered here.
  try { for (const p of (await import('../kernel/hub-store.mjs')).readProjectsIndex(hubRoot).projects) projects.set(p.project_id, p.name); } catch {}
  const cards = tasks.map(t => {
    let preview = '';
    const compact = readHubTaskCompaction(hubRoot, t.id);
    if (compact) preview = compact;
    else {
      const thread = readHubTaskThread(hubRoot, t.id);
      preview = thread.slice(-2).map(r => r.content ?? '').join(' | ');
    }
    return { ...t, project_name: projects.get(t.project_id) ?? t.project_id ?? 'general', preview: truncateHeadTail(preview, 200) };
  });
  const client = llmClient ?? createOpenAICompatibleClient();
  const result = await client.complete({ system: buildHubColdRouterPrompt(cards, { cwdProjectHint }), messages: [{ role: 'user', content: String(userPrompt) }], temperature: 0, signal });
  if (!result.ok) return { ok: false, decision: null, task_id: null, project_id: null, candidates: [], reason: null, llm_called: true, error_code: result.error_code };
  let parsed;
  try { parsed = JSON.parse(String(result.content ?? '').trim()); } catch { return { ok: false, decision: null, task_id: null, project_id: null, candidates: [], reason: null, llm_called: true, error_code: 'strict_json_parse_failed' }; }
  if (parsed.decision === 'new' && parsed.task_id == null) return { ok: true, decision: 'new', task_id: null, project_id: null, candidates: [], reason: String(parsed.reason ?? ''), llm_called: true };
  const id = Number(parsed.task_id);
  const task = tasks.find(t => t.id === id);
  if (parsed.decision === 'match' && task && (parsed.project_id ?? null) === (task.project_id ?? null)) return { ok: true, decision: 'match', task_id: id, project_id: task.project_id ?? null, candidates: [id], reason: String(parsed.reason ?? ''), llm_called: true };
  if (parsed.decision === 'ambiguous' && parsed.task_id == null && Array.isArray(parsed.candidates) && parsed.candidates.length >= 2 && parsed.candidates.every(candidate => tasks.some(t => t.id === candidate))) return { ok: true, decision: 'ambiguous', task_id: null, project_id: null, candidates: [...new Set(parsed.candidates)], reason: String(parsed.reason ?? ''), llm_called: true };
  return { ok: false, decision: null, task_id: null, project_id: null, candidates: [], reason: null, llm_called: true, error_code: 'invalid_router_decision' };
}
