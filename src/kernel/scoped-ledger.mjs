import { createEmptyLedger, foldLedger, freezeDeep } from './ledger.mjs';

function validateScope(scope, rawProjectId) {
  if (scope !== 'user' && scope !== 'project') throw new Error('invalid_scope');
  const projectId = rawProjectId === 'general' || rawProjectId === '' ? null : rawProjectId;
  if (scope === 'project' && (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(projectId))) {
    throw new Error('project_id_required');
  }
  if (scope === 'user' && projectId !== null && projectId !== undefined) throw new Error('user_scope_project_id_forbidden');
  return projectId ?? null;
}

function inScope(entry, scope, projectId) {
  return {
    ...entry,
    scope,
    ...(scope === 'project' ? { project_id: projectId } : { project_id: null })
  };
}

export function foldScopedLedger(currentLedger = null, ops = [], stepMeta = {}) {
  const scope = stepMeta.scope;
  const projectId = validateScope(scope, stepMeta.project_id ?? null);
  const current = currentLedger ?? createEmptyLedger();
  const acceptedCandidates = [];
  const rejected = [];

  for (let index = 0; index < (Array.isArray(ops) ? ops.length : 0); index++) {
    const op = ops[index];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      rejected.push({ index, op, error: 'op_not_object' });
      continue;
    }
    if (op.scope !== undefined && op.scope !== scope && op.scope !== 'global') {
      rejected.push({ index, op, error: 'operator_scope_mismatch' });
      continue;
    }
    if (scope === 'user' && op.project_id !== undefined && op.project_id !== null) {
      rejected.push({ index, op, error: 'user_scope_project_id_forbidden' });
      continue;
    }
    if (scope === 'project' && op.project_id !== undefined && op.project_id !== projectId) {
      rejected.push({ index, op, error: 'operator_project_id_mismatch' });
      continue;
    }
    acceptedCandidates.push({ originalIndex: index, op: { ...op, scope: 'global' } });
  }

  if (!Array.isArray(ops)) {
    const result = foldLedger(current, ops, stepMeta);
    return result;
  }
  const folded = foldLedger(current, acceptedCandidates.map(candidate => candidate.op), stepMeta);
  const accepted = folded.accepted_ops.map(item => {
    const candidate = acceptedCandidates[item.index];
    return { ...item, index: candidate.originalIndex, op: ops[candidate.originalIndex] };
  });
  const rejectedFolded = folded.rejected_ops.map(item => {
    const candidate = acceptedCandidates[item.index];
    return { ...item, index: candidate.originalIndex, op: ops[candidate.originalIndex] };
  });
  const next = {
    ...folded.ledger,
    active: folded.ledger.active.map(item => inScope(item, scope, projectId)),
    tombstones: folded.ledger.tombstones.map(item => inScope(item, scope, projectId)),
    open_questions: folded.ledger.open_questions.map(item => inScope(item, scope, projectId))
  };
  return freezeDeep({
    ...folded,
    ledger: next,
    accepted_ops: accepted,
    rejected_ops: [...rejected, ...rejectedFolded],
    rejected_count: rejected.length + rejectedFolded.length
  });
}
