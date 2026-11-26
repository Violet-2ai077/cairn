import { createHubTurnRuntime, resolveMidSessionPolicy } from '../src/hosts/dsh/hub-turn-runtime.mjs';
import { recoverJournalText } from '../src/hosts/dsh/turn-journal.mjs';
import { readTurnReceipts, turnSourceDigest, upsertHubTask } from '../src/kernel/hub-store.mjs';
import { resolveTaskHeatPolicy } from '../src/kernel/task-heat.mjs';
import { markerCases } from './fixtures/reliability-corpus.mjs';

// A uses the production turn runtime on a scratch Hub. B is numerical only:
// never call recoverMarkerlessTurn or publish a second archive with a weaker policy.
export async function evaluateAttribution(hub) {
  upsertHubTask(hub, { id: 1, title: 'Invoice reconciliation' });
  upsertHubTask(hub, { id: 2, title: 'CSV header export regression' });
  const runtime = createHubTurnRuntime({ hubRoot: hub, policy: resolveMidSessionPolicy({ enabled: true }),
    taskHeat: resolveTaskHeatPolicy({ enabled: true }), maxTailChars: 1000, stripReminders: s => s,
    onArchive() {}, clientFor() { return { async complete({ messages }) {
      if (messages.at(-1)?.content !== 'Fix the dropped header in the CSV export.') throw new Error('unexpected_fixture_route');
      return { ok: true, content: '{"decision":"match","task_id":1,"project_id":null}' };
    } }; } });
  const rows = [];
  for (const c of markerCases) {
    const id = c.id, text = c.truth === 2 ? 'Fix the dropped header in the CSV export.' : 'Continue task #1';
    const message = { source: { kind: 'user' }, content: text };
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', surfaceOp: 'append', data: { turn: 1, message } },
      { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: c.text } } },
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: c.interrupted ? 'interrupted' : 'completed' } } }
    ];
    runtime.event(id, events[0]);
    await runtime.preStep(id, { turn: 1, step: 1, messages: [message], signal: new AbortController().signal }, null);
    const selected = runtime.turns.get(id)?.scope?.taskId;
    for (const e of events.slice(1)) runtime.event(id, e);
    const r = readTurnReceipts(hub, id, 1);
    if (c.tamper) events[2] = { ...events[2], data: { ...events[2].data, message: { content: 'Different' } } };
    const source = recoverJournalText({ eventAt: seq => events[seq] }, r, s => s);
    const eligible = r.reason === 'marker_missing' && source && turnSourceDigest(source.user, source.assistant) === r.source_digest;
    rows.push({ id, reason: r.reason, truth: c.truth, strict: r.status === 'archived' ? r.task_id : null,
      shadow: r.status === 'archived' ? r.task_id : eligible ? selected : null, manually_recoverable: Boolean(eligible) });
  }
  const metrics = key => {
    const archived = rows.filter(row => row[key] != null), count = reason => rows.filter(r => r.reason === reason).length;
    return { archived: archived.length, archive_success_rate: archived.length / rows.length,
      false_attribution_per_archive: archived.length ? archived.filter(r => r[key] !== r.truth).length / archived.length : null,
      marker_missing_per_turn: count('marker_missing') / rows.length, marker_mismatch_per_turn: count('marker_mismatch') / rows.length,
      manual_recovery_eligible_per_turn: rows.filter(r => r.manually_recoverable && r[key] == null).length / rows.length,
      observed_human_recovery_rate: null };
  };
  return { turns: rows.length, strict: metrics('strict'), evidence_only_shadow: metrics('shadow'), rows };
}
