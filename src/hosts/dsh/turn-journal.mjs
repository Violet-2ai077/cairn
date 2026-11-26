import { distillToolEvent } from '../../workers/distill.mjs';
import { redactToolOutput } from '../../kernel/tool-evidence.mjs';
import { recordToolFact } from '../../kernel/tool-timeline.mjs';

export const textOf = msg => typeof msg?.content === 'string' ? msg.content
  : Array.isArray(msg?.content) ? msg.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

export function collectToolEvidence(entry, event) {
  const data = event.data ?? {};
  if (event.type === 'tool/call') {
    const id = data.callId ?? data.id;
    const name = data.name ?? data.toolName;
    if (typeof id === 'string' && id) entry.toolNames.set(id, name);
    if (Number.isSafeInteger(event.seq)) (entry.toolCallsBySeq ??= new Map()).set(event.seq, { id, name });
  }
  if (event.type !== 'tool/result' || (event.surfaceOp && event.surfaceOp !== 'append')) return;
  if (Number.isSafeInteger(event.seq)) {
    if (event.seq <= (entry.lastToolSeq ?? -1)) return;
    entry.lastToolSeq = event.seq;
  }
  const msg = data.message ?? data;
  const linked = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.map(seq => entry.toolCallsBySeq?.get(seq)).filter(Boolean) : [];
  const call = linked.length === 1 ? linked[0] : null;
  const callId = msg.toolCallId ?? msg.source?.callId ?? data.callId ?? call?.id;
  const name = entry.toolNames.get(callId) ?? (call?.id === callId ? call?.name : null) ?? msg.name ?? 'tool';
  const ok = !(msg.isError || data.error);
  const snippet = distillToolEvent({ name, ok, output: redactToolOutput(textOf(msg)) }, { maxPerToolChars: 500 });
  const evidence = { name, ok, seq: event.seq, ...(typeof callId === 'string' && callId && { call_id: callId }),
    output: snippet.split('\n').slice(1).join('\n').trim() };
  entry.tools.push(evidence);
  if (entry.tools.length > 8) entry.tools.splice(Math.max(0, entry.tools.findIndex(tool => tool.ok)), 1);
  return evidence;
}

export function persistToolFact(root, sessionId, entry, scope, event) {
  const d = event.data ?? {};
  if (!scope?.taskId || d.turn !== entry.turn || !['tool/call', 'tool/result'].includes(event.type) ||
      (event.surfaceOp && event.surfaceOp !== 'append') || (event.type === 'tool/result' && event.surfaceOp !== 'append')) return;
  const msg = d.message ?? d;
  const links = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.filter(seq => entry.toolCallsBySeq?.has(seq)) : [];
  const callSeq = links.length === 1 ? links[0] : undefined;
  const isCall = event.type === 'tool/call';
  const callId = isCall ? d.callId ?? d.id : msg.toolCallId ?? msg.source?.callId ?? d.callId ?? entry.toolCallsBySeq?.get(callSeq)?.id;
  return recordToolFact(root, { sessionId, turn: d.turn, taskId: scope.taskId, projectId: scope.projectId, bindingEpoch: scope.bindingEpoch,
    step: d.step ?? entry.step, journalSeq: event.seq, kind: isCall ? 'call' : 'result', callId, callSeq,
    name: isCall ? d.name ?? d.toolName : entry.toolNames.get(callId) ?? msg.name, ok: !(msg.isError || d.error) });
}

export function resumeUserText(original, selection, authored) {
  if (!authored || authored === selection) return original;
  return original + '\n\n' + (authored.startsWith(selection + '\n\n') ? authored.slice(selection.length + 2) : authored);
}

function completedEvents(session, receipt) {
  const end = receipt?.end_seq;
  if (!Number.isSafeInteger(end) || typeof session?.eventAt !== 'function') return null;
  const terminal = session.eventAt(end);
  if (terminal?.type !== 'turn/end' || terminal.data?.turn !== receipt.turn || terminal.data.reason?.kind !== 'completed') return null;
  const events = [];
  for (let i = end - 1; i >= 0; i--) {
    if (session.isOwnSeq && !session.isOwnSeq(i)) break;
    const event = session.eventAt(i);
    if (!event || event.type === 'turn/end') break;
    if (event.data?.turn == null || event.data.turn === receipt.turn) events.push(event);
  }
  return events.reverse();
}

// Only the original native session supplies text; receipts never duplicate unassigned turns.
export function recoverJournalText(session, receipt, stripReminders, originalReceipt) {
  const events = completedEvents(session, receipt);
  if (!events) return null;
  const evidence = { toolNames: new Map(), tools: [] };
  const authored = [];
  let assistant = '';
  for (const event of events) {
    collectToolEvidence(evidence, event);
    const msg = event.data?.message ?? event.data;
    if (event.surfaceOp !== 'append') continue;
    if (event.type === 'user/message' && msg.source?.kind === 'user') authored.push(stripReminders(textOf(msg)));
    if (event.type === 'assistant/message' && event.seq === receipt.final_seq) assistant = textOf(msg).trim();
  }
  let user = authored.filter(Boolean).join('\n\n');
  if (receipt.original_turn != null) {
    if (originalReceipt?.turn !== receipt.original_turn || originalReceipt.reason !== 'awaiting_choice') return null;
    const original = completedEvents(session, originalReceipt)?.filter(e => e.type === 'user/message' && e.surfaceOp === 'append')
      .map(e => e.data.message ?? e.data).filter(m => m.source?.kind === 'user')
      .map(m => stripReminders(textOf(m))).filter(Boolean).join('\n\n');
    if (!original || !Number.isSafeInteger(receipt.selection_messages) || receipt.selection_messages < 1) return null;
    user = resumeUserText(original, authored.filter(Boolean).slice(0, receipt.selection_messages).join('\n\n'), user);
  }
  return user && assistant ? { user, assistant, tools: evidence.tools } : null;
}
