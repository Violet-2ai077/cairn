import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withHubWriteLock } from './hub-write-lock.mjs';
import { writeJsonAtomic } from './store.mjs';
import { commitScopedStaged, dropScopedStaged, readScopedHead, readScopedLedgerLog, readScopedStaged,
  readSessionBinding, resolveHubPaths, stageScopedOperators } from './hub-store.mjs';

function directory(root, session) {
  const binding = resolveHubPaths(root).sessionBindingFile(session);
  return path.join(path.dirname(binding), 'memory', path.basename(binding, '.json'));
}
function file(root, session, id) {
  if (!/^\d{1,12}\.[1-8]$/u.test(id)) throw new Error('invalid_memory_id');
  return path.join(directory(root, session), id + '.json');
}
export function readMemoryReview(root, session, id) {
  const name = file(root, session, id);
  return fs.existsSync(name) ? JSON.parse(fs.readFileSync(name, 'utf8')) : null;
}
export function listMemoryReviews(root, session) {
  const dir = directory(root, session);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^\d+\.[1-8]\.json$/u.test(n))
    .map(n => readMemoryReview(root, session, n.slice(0, -5))).filter(r => ['pending', 'applying', 'preparing'].includes(r.status));
}
function scoped(row, scope) { return { scope, projectId: scope === 'project' ? row.projectId : null }; }

export function openMemoryReview(root, session, id, card, projectId) {
  return withHubWriteLock(root, () => {
    const existing = readMemoryReview(root, session, id);
    if (existing) return existing;
    const row = { id, quote: card.quote, scopes: card.scopes, projectId, status: 'preparing',
      source: 'memory_' + createHash('sha256').update(JSON.stringify([session, id])).digest('hex'), bases: {} };
    for (const scope of row.scopes) row.bases[scope] = readScopedHead(root, scoped(row, scope)).revision;
    writeJsonAtomic(file(root, session, id), row);
    return row;
  });
}

function stage(root, row, scope) {
  const target = scoped(row, scope);
  const existing = readScopedStaged(root, target).proposals.find(p => p.source_step === row.source);
  return existing ?? stageScopedOperators(root, { ...target, source_step: row.source, actor_id: 'dsh-memory',
    base_revision: row.bases[scope], ops: [{ ...row.op, scope }], admission: { eligible: false, review_key: row.source } }).proposal;
}
export function prepareMemoryReview(root, session, id, op, failure = 'no_proposal') {
  return withHubWriteLock(root, () => {
    const row = readMemoryReview(root, session, id);
    if (!row || row.status !== 'preparing') return row;
    if (op) {
      if (op.op !== 'ASSERT') throw new Error('invalid_preference_operator');
      row.op = op;
      if (row.scopes.length === 1) {
        const proposal = stage(root, row, row.scopes[0]);
        row.proposal = proposal.proposal_id;
        const { key, option_code, summary } = proposal.ops[0];
        row.op = { op: op.op, key, option_code, summary };
      }
    }
    row.status = op ? 'pending' : failure;
    writeJsonAtomic(file(root, session, id), row);
    return row;
  });
}

export function resolveMemoryReview(root, session, id, choice) {
  return withHubWriteLock(root, () => {
    const row = readMemoryReview(root, session, id);
    if (!row) throw new Error('memory_not_found');
    if (row.chosen && row.chosen !== choice) throw new Error('memory_choice_locked');
    if (!['pending', 'applying'].includes(row.status) && !(row.status === 'preparing' && choice === 'skip')) return row;
    const persist = status => { row.status = status; writeJsonAtomic(file(root, session, id), row); return row; };
    if (choice === 'skip') {
      if (row.scopes.length === 1) {
        const target = scoped(row, row.scopes[0]);
        const id = row.proposal ?? readScopedStaged(root, target).proposals.find(p => p.source_step === row.source)?.proposal_id;
        if (id) dropScopedStaged(root, { ...target, proposal_id: id, reviewKey: row.source });
      }
      return persist('skipped');
    }
    if (!row.scopes.includes(choice)) throw new Error('memory_scope_not_offered');
    if (choice === 'project' && readSessionBinding(root, session)?.project_id !== row.projectId) throw new Error('memory_project_changed');
    const target = scoped(row, choice);
    if (row.status === 'applying' && readScopedLedgerLog(root, target).some(c => c.source_step === row.source)) return persist('committed');
    if (readScopedHead(root, target).revision !== row.bases[choice]) {
      const old = readScopedStaged(root, target).proposals.find(p => p.source_step === row.source);
      if (old) dropScopedStaged(root, { ...target, proposal_id: old.proposal_id, reviewKey: row.source });
      return persist('conflict');
    }
    row.chosen = choice;
    persist('applying');
    const proposalId = row.proposal ?? stage(root, row, choice).proposal_id;
    const result = commitScopedStaged(root, { ...target, proposal_id: proposalId, reviewKey: row.source });
    if (!result.committed) dropScopedStaged(root, { ...target, proposal_id: proposalId, reviewKey: row.source });
    return persist(result.committed ? 'committed' : result.reason === 'proposal_not_found' ? 'discarded' : 'conflict');
  });
}
