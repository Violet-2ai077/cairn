// Cairn Kernel: Pure Deterministic Workspace State Ledger & Folding Engine (src/kernel/ledger.mjs)
// Zero LLM dependencies, zero host dependencies.
// Host exclusively allocates short handles (D1, D2... / Q1, Q2...).
// Supports multi-agent metadata (`actor_id`, default "default") and optimistic concurrency (`base_revision`).

export function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      freezeDeep(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const VALID_OP_TYPES = Object.freeze([
  'ASSERT',
  'SUPERSEDE',
  'OPEN_QUESTION',
  'RESOLVE_QUESTION'
]);

export function createEmptyLedger() {
  return freezeDeep({
    revision: 0,
    last_actor_id: null,
    next_decision_num: 1,
    next_question_num: 1,
    active: [],
    tombstones: [],
    open_questions: []
  });
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Deterministically folds an array of staging operators into a new immutable ledger snapshot.
 *
 * @param {object} currentLedger - Current immutable ledger state.
 * @param {Array<object>} ops - Candidate delta operators extracted by the staging worker.
 * @param {object} [stepMeta] - Commit metadata.
 * @param {string} [stepMeta.source_step] - Monotonic step or turn identifier.
 * @param {string} [stepMeta.actor_id="default"] - Agent/worker identifier committing this fold.
 * @param {number} [stepMeta.base_revision] - Optional optimistic concurrency base revision check.
 */
export function foldLedger(currentLedger, ops, stepMeta = {}) {
  const sourceStep = stepMeta.source_step ?? `step_${currentLedger.revision + 1}`;
  const actorId =
    typeof stepMeta.actor_id === 'string' && stepMeta.actor_id.trim().length > 0
      ? stepMeta.actor_id.trim()
      : 'default';

  // Optimistic concurrency guard (`base_revision`) for multi-agent safety
  if (
    stepMeta.base_revision !== undefined &&
    stepMeta.base_revision !== null &&
    stepMeta.base_revision !== currentLedger.revision
  ) {
    const conflictError = `base_revision_conflict:expected_${stepMeta.base_revision}_actual_${currentLedger.revision}`;
    const rejectedOps = Array.isArray(ops)
      ? ops.map((op, index) => ({ index, op, error: conflictError }))
      : [{ index: 0, op: ops, error: conflictError }];

    return freezeDeep({
      ledger: currentLedger,
      conflict: true,
      conflict_error: conflictError,
      actor_id: actorId,
      accepted_ops: [],
      rejected_ops: rejectedOps,
      rejected_count: rejectedOps.length
    });
  }

  let revision = currentLedger.revision;
  let lastActorId = currentLedger.last_actor_id ?? null;
  let nextDecisionNum = currentLedger.next_decision_num ?? 1;
  let nextQuestionNum = currentLedger.next_question_num ?? 1;

  const active = currentLedger.active.map(item => ({ ...item }));
  const tombstones = currentLedger.tombstones.map(item => ({ ...item }));
  const openQuestions = currentLedger.open_questions.map(item => ({ ...item }));

  const acceptedOps = [];
  const rejectedOps = [];

  if (!Array.isArray(ops)) {
    rejectedOps.push({
      index: 0,
      op: ops,
      error: 'ops_not_array'
    });
    return freezeDeep({
      ledger: {
        revision,
        last_actor_id: lastActorId,
        next_decision_num: nextDecisionNum,
        next_question_num: nextQuestionNum,
        active,
        tombstones,
        open_questions: openQuestions
      },
      conflict: false,
      conflict_error: null,
      actor_id: actorId,
      accepted_ops: acceptedOps,
      rejected_ops: rejectedOps,
      rejected_count: rejectedOps.length
    });
  }

  for (let i = 0; i < ops.length; i++) {
    const rawOp = ops[i];
    if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
      rejectedOps.push({ index: i, op: rawOp, error: 'op_not_object' });
      continue;
    }

    const opType = rawOp.op;
    if (!VALID_OP_TYPES.includes(opType)) {
      rejectedOps.push({ index: i, op: rawOp, error: `invalid_op_type:${String(opType)}` });
      continue;
    }

    // Model is strictly forbidden from inventing or supplying its own primary `id` handle
    if (rawOp.id !== undefined) {
      rejectedOps.push({ index: i, op: rawOp, error: 'model_invented_id_forbidden' });
      continue;
    }

    if (opType === 'ASSERT') {
      const scope = rawOp.scope;
      const key = typeof rawOp.key === 'string' ? rawOp.key.trim() : '';
      const optionCode = typeof rawOp.option_code === 'string' ? rawOp.option_code.trim() : '';
      const summary = typeof rawOp.summary === 'string' ? rawOp.summary.trim() : '';

      if (scope !== 'global') {
        rejectedOps.push({ index: i, op: rawOp, error: 'assert_non_global_scope_rejected' });
        continue;
      }
      if (!isNonEmptyString(key) || !isNonEmptyString(optionCode) || !isNonEmptyString(summary)) {
        rejectedOps.push({ index: i, op: rawOp, error: 'assert_missing_required_fields' });
        continue;
      }
      if (active.some(d => d.key === key)) {
        rejectedOps.push({ index: i, op: rawOp, error: `assert_duplicate_active_key:${key}` });
        continue;
      }

      const newId = `D${nextDecisionNum++}`;
      revision++;
      lastActorId = actorId;
      const entry = {
        id: newId,
        scope: 'global',
        key,
        option_code: optionCode,
        summary,
        source_step: sourceStep,
        actor_id: actorId
      };
      active.push(entry);
      acceptedOps.push({ index: i, op: rawOp, allocated_id: newId, actor_id: actorId });
      continue;
    }

    if (opType === 'SUPERSEDE') {
      const targetId = typeof rawOp.target_id === 'string' ? rawOp.target_id.trim() : '';
      const optionCode = typeof rawOp.option_code === 'string' ? rawOp.option_code.trim() : '';
      const summary = typeof rawOp.summary === 'string' ? rawOp.summary.trim() : '';
      const reason = typeof rawOp.reason === 'string' ? rawOp.reason.trim() : '';

      if (
        !isNonEmptyString(targetId) ||
        !isNonEmptyString(optionCode) ||
        !isNonEmptyString(summary) ||
        !isNonEmptyString(reason)
      ) {
        rejectedOps.push({ index: i, op: rawOp, error: 'supersede_missing_required_fields' });
        continue;
      }
      if (rawOp.scope !== undefined && rawOp.scope !== 'global') {
        rejectedOps.push({ index: i, op: rawOp, error: 'supersede_non_global_scope_rejected' });
        continue;
      }

      const activeIdx = active.findIndex(d => d.id === targetId);
      if (activeIdx === -1) {
        const inTombstones = tombstones.some(t => t.id === targetId);
        rejectedOps.push({
          index: i,
          op: rawOp,
          error: inTombstones
            ? `supersede_target_already_tombstoned:${targetId}`
            : `supersede_target_not_found:${targetId}`
        });
        continue;
      }

      const targetEntry = active[activeIdx];
      active.splice(activeIdx, 1);

      const newId = `D${nextDecisionNum++}`;
      revision++;
      lastActorId = actorId;

      tombstones.push({
        id: targetEntry.id,
        scope: targetEntry.scope,
        key: targetEntry.key,
        option_code: targetEntry.option_code,
        superseded_by: newId,
        reason,
        source_step: sourceStep,
        actor_id: actorId
      });

      active.push({
        id: newId,
        scope: 'global',
        key: targetEntry.key,
        option_code: optionCode,
        summary,
        source_step: sourceStep,
        actor_id: actorId
      });

      acceptedOps.push({
        index: i,
        op: rawOp,
        superseded_id: targetEntry.id,
        allocated_id: newId,
        actor_id: actorId
      });
      continue;
    }

    if (opType === 'OPEN_QUESTION') {
      const key = typeof rawOp.key === 'string' ? rawOp.key.trim() : '';
      const summary = typeof rawOp.summary === 'string' ? rawOp.summary.trim() : '';

      if (!isNonEmptyString(key) || !isNonEmptyString(summary)) {
        rejectedOps.push({ index: i, op: rawOp, error: 'open_question_missing_required_fields' });
        continue;
      }

      const newQId = `Q${nextQuestionNum++}`;
      revision++;
      lastActorId = actorId;
      openQuestions.push({
        id: newQId,
        key,
        summary,
        status: 'open',
        resolution: null,
        source_step: sourceStep,
        actor_id: actorId
      });
      acceptedOps.push({ index: i, op: rawOp, allocated_id: newQId, actor_id: actorId });
      continue;
    }

    if (opType === 'RESOLVE_QUESTION') {
      const targetId = typeof rawOp.target_id === 'string' ? rawOp.target_id.trim() : '';
      const resolution = typeof rawOp.resolution === 'string' ? rawOp.resolution.trim() : '';

      if (!isNonEmptyString(targetId) || !isNonEmptyString(resolution)) {
        rejectedOps.push({ index: i, op: rawOp, error: 'resolve_question_missing_required_fields' });
        continue;
      }

      const qIdx = openQuestions.findIndex(q => q.id === targetId);
      if (qIdx === -1) {
        rejectedOps.push({
          index: i,
          op: rawOp,
          error: `resolve_question_target_not_found:${targetId}`
        });
        continue;
      }

      const targetQ = openQuestions[qIdx];
      if (targetQ.status !== 'open') {
        rejectedOps.push({
          index: i,
          op: rawOp,
          error: `resolve_question_already_resolved:${targetId}`
        });
        continue;
      }

      revision++;
      lastActorId = actorId;
      openQuestions[qIdx] = {
        ...targetQ,
        status: 'resolved',
        resolution,
        source_step: sourceStep,
        actor_id: actorId
      };
      acceptedOps.push({ index: i, op: rawOp, resolved_id: targetId, actor_id: actorId });
      continue;
    }
  }

  return freezeDeep({
    ledger: {
      revision,
      last_actor_id: lastActorId,
      next_decision_num: nextDecisionNum,
      next_question_num: nextQuestionNum,
      active,
      tombstones,
      open_questions: openQuestions
    },
    conflict: false,
    conflict_error: null,
    actor_id: actorId,
    accepted_ops: acceptedOps,
    rejected_ops: rejectedOps,
    rejected_count: rejectedOps.length
  });
}

/**
 * Projects a clean read-only Workspace State Ledger snapshot for prompt injection.
 */
export function projectReadOnlyLedger(ledger, { includeTombstones = true } = {}) {
  const view = {
    revision: ledger.revision,
    ...(ledger.last_actor_id ? { last_actor_id: ledger.last_actor_id } : {}),
    active: ledger.active.map(d => ({
      id: d.id,
      scope: d.scope,
      key: d.key,
      option_code: d.option_code,
      summary: d.summary,
      source_step: d.source_step,
      ...(d.actor_id ? { actor_id: d.actor_id } : {})
    })),
    ...(includeTombstones
      ? {
          tombstones: ledger.tombstones.map(t => ({
            id: t.id,
            scope: t.scope,
            key: t.key,
            option_code: t.option_code,
            superseded_by: t.superseded_by,
            reason: t.reason,
            source_step: t.source_step,
            ...(t.actor_id ? { actor_id: t.actor_id } : {})
          }))
        }
      : {}),
    open_questions: ledger.open_questions.map(q => ({
      id: q.id,
      key: q.key,
      summary: q.summary,
      status: q.status,
      resolution: q.resolution,
      source_step: q.source_step,
      ...(q.actor_id ? { actor_id: q.actor_id } : {})
    }))
  };
  return freezeDeep(view);
}
