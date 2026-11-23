import { isDeepStrictEqual } from 'node:util';
import { createEmptyLedger } from './ledger.mjs';
import { foldScopedLedger } from './scoped-ledger.mjs';

export function planDecisionRevert(history, ledger, seq, reason) {
  const target = history[seq - 1];
  if (!target) return { status: 'commit_not_found' };
  if (target.record.kind === 'revert' || !target.decisionsOnly) return { status: 'unsupported_commit' };
  const subsequent = history.slice(seq);
  if (subsequent.some(entry => entry.record.reverts_commit_seq === seq)) return { status: 'already_reverted' };
  const changed = new Set(subsequent.flatMap(entry => [...entry.keys]));
  const blockers = [...target.keys].filter(key => changed.has(key));
  if (blockers.length) return { status: 'key_changed', blockers };
  const ops = [...target.keys].map(key => {
    const before = target.before.get(key);
    const current = ledger.active.find(entry => entry.key === key);
    if (!current) throw new Error('revert_target_not_active');
    return before
      ? { op: 'SUPERSEDE', target_id: current.id, option_code: before.option_code, summary: before.summary, reason }
      : { op: 'RETRACT_DECISION', target_id: current.id, reason };
  });
  return { status: 'ready', ops };
}

export function replayHubRecords(records, disk, { scope, projectId }) {
  let ledger = createEmptyLedger();
  let headIsPrefix = isDeepStrictEqual(ledger, disk);
  const history = [];
  const consumed = new Set();
  const fail = reason => ({ valid: false, head_matches: false, commit_count: history.length, mismatch_reason: reason });
  for (const [index, record] of records.entries()) {
    const seq = index + 1;
    if (!record || record.scope !== scope || record.project_id !== projectId) return fail(`scope_mismatch_at_commit_${seq}`);
    if (record.commit_seq !== seq || record.base_revision !== ledger.revision) return fail(`chain_mismatch_at_commit_${seq}`);
    if (!Array.isArray(record.ops) || typeof record.actor_id !== 'string' || !record.actor_id.trim() ||
        typeof record.source_step !== 'string' || !record.source_step.trim()) return fail(`invalid_commit_${seq}`);
    const isRevert = record.kind === 'revert';
    if (isRevert) {
      if (record.version !== 1 || record.proposal_id !== null ||
          !Number.isSafeInteger(record.reverts_commit_seq) || record.reverts_commit_seq <= 0 ||
          typeof record.reason !== 'string' || !record.reason.trim()) return fail(`invalid_revert_${seq}`);
      const planned = planDecisionRevert(history, ledger, record.reverts_commit_seq, record.reason);
      if (planned.status !== 'ready' || !isDeepStrictEqual(planned.ops, record.ops)) return fail(`invalid_revert_${seq}`);
    } else {
      if (record.kind !== undefined || typeof record.proposal_id !== 'string' ||
          !/^stg_\d+$/u.test(record.proposal_id) || consumed.has(record.proposal_id)) return fail(`invalid_proposal_at_commit_${seq}`);
      consumed.add(record.proposal_id);
    }
    const result = foldScopedLedger(ledger, record.ops, {
      scope, project_id: projectId, source_step: record.source_step, actor_id: record.actor_id,
      base_revision: record.base_revision, allowDecisionRetraction: isRevert
    });
    if (result.conflict || !result.accepted_ops.length || (isRevert && result.rejected_count) ||
        result.ledger.revision !== record.new_revision || !isDeepStrictEqual(result.accepted_ops, record.accepted_ops) ||
        !isDeepStrictEqual(result.rejected_ops, record.rejected_ops)) return fail(`fold_mismatch_at_commit_${seq}`);

    const decisionsOnly = record.ops.every(op => op?.op === 'ASSERT' || op?.op === 'SUPERSEDE');
    const after = new Map([...result.ledger.active, ...result.ledger.tombstones].map(entry => [entry.id, entry.key]));
    const keys = new Set(result.accepted_ops.flatMap(effect => {
      const key = after.get(effect.allocated_id ?? effect.retracted_id);
      return key === undefined ? [] : [key];
    }));
    history.push({ record, decisionsOnly, keys, before: new Map(ledger.active.filter(entry => keys.has(entry.key)).map(entry => [entry.key, entry])) });
    ledger = result.ledger;
    headIsPrefix ||= isDeepStrictEqual(ledger, disk);
  }
  const headMatches = isDeepStrictEqual(ledger, disk);
  return {
    valid: headMatches, head_matches: headMatches, commit_count: records.length,
    mismatch_reason: headMatches ? null : headIsPrefix ? 'materialization_pending' : 'head_mismatch',
    ledger, history, consumed
  };
}
