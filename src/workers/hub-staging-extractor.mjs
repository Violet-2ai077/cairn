import { buildScopedStagingExtractorPrompt, commitScopedStaged, foldScopedLedger, projectReadOnlyLedger, readScopedHead, stageScopedOperators } from '../kernel/index.mjs';
import { distillTurnTrajectory } from './distill.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';
import { evaluateAutoCommit } from './hub-auto-commit.mjs';

export async function runHubStagingExtractor({ hubRoot, scope = 'user', projectId = null, turnInput = {}, authoredUserText = '', autopilot = null, source_step = null, actor_id = 'default', llmClient = null, signal, project = null } = {}) {
  if (scope === 'user') projectId = null;
  if (scope === 'project' && !projectId) throw new Error('project_id_required');
  const head = readScopedHead(hubRoot, { scope, projectId });
  const snapshot = projectReadOnlyLedger(head, { includeTombstones: true });
  const distilled = distillTurnTrajectory(turnInput);
  const client = llmClient ?? createOpenAICompatibleClient();
  const withEvidence = scope === 'project' && autopilot?.enabled === true && autopilot.autoCommit?.project !== false;
  const system = buildScopedStagingExtractorPrompt(scope, snapshot, { withEvidence });
  const result = await client.complete({ system, messages: [{ role: 'user', content: distilled.distilled_text }], temperature: 0, signal });
  if (!result.ok) return { ok: false, staged: false, error_code: result.error_code ?? 'transport_error', base_revision: head.revision };
  let parsed;
  try { parsed = JSON.parse(String(result.content ?? '').trim()); } catch { return { ok: false, staged: false, error_code: 'strict_json_parse_failed', base_revision: head.revision }; }
  if (!parsed || !Array.isArray(parsed.ops)) return { ok: false, staged: false, error_code: 'missing_ops_array', base_revision: head.revision };
  if (!parsed.ops.length) return { ok: true, staged: false, reason: 'no_ops', base_revision: head.revision };
  const normalizedOps = parsed.ops.map(op => {
    if (!op || typeof op !== 'object' || Array.isArray(op) ||
        (op.scope !== undefined && op.scope !== scope) || op.project_id !== undefined) return null;
    return { ...op, scope, ...(scope === 'project' ? { project_id: projectId } : {}) };
  });
  const precheck = foldScopedLedger(head, normalizedOps, { scope, project_id: projectId, base_revision: head.revision, actor_id });
  const accepted = precheck.accepted_ops.map(item => item.op);
  if (!accepted.length) return { ok: false, staged: false, error_code: 'all_ops_rejected', rejected_ops: precheck.rejected_ops, base_revision: head.revision };
  const admission = evaluateAutoCommit({
    scope, rejectedCount: precheck.rejected_count, ops: accepted, evidence: parsed.evidence,
    authoredUserText, assistantText: turnInput.assistant, autopilot
  });
  const proposal = stageScopedOperators(hubRoot, { scope, projectId, project, ops: accepted, source_step: source_step ?? `turn_${turnInput.turn ?? 1}`, actor_id, base_revision: head.revision, admission: withEvidence ? admission : null });
  const autoCommit = admission.eligible
    ? commitScopedStaged(hubRoot, { scope, projectId, proposal_id: proposal.proposal.proposal_id, mode: 'auto' })
    : null;
  return { ok: true, staged: true, proposal, rejected_ops: precheck.rejected_ops, base_revision: head.revision, admission, autoCommit };
}
