import { distillToolEvent } from '../../workers/distill.mjs';

export const textOf = msg => typeof msg?.content === 'string' ? msg.content
  : Array.isArray(msg?.content) ? msg.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

export function collectToolEvidence(entry, event) {
  const data = event.data ?? {};
  if (event.type === 'tool/call') entry.toolNames.set(data.callId, data.name ?? data.toolName);
  if (event.type !== 'tool/result') return;
  const msg = data.message ?? data;
  const name = entry.toolNames.get(msg.toolCallId ?? data.callId) ?? msg.name ?? 'tool';
  const ok = !(msg.isError || data.error);
  const snippet = distillToolEvent({ name, ok, output: textOf(msg) }, { maxPerToolChars: 500 });
  entry.tools.push({ name, ok, seq: event.seq, output: snippet.split('\n').slice(1).join('\n').trim() });
  if (entry.tools.length > 8) entry.tools.splice(Math.max(0, entry.tools.findIndex(tool => tool.ok)), 1);
}

// Only the original native session supplies text; receipts never duplicate unassigned turns.
export function recoverJournalText(session, receipt, stripReminders) {
  const end = receipt.end_seq;
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
  const evidence = { toolNames: new Map(), tools: [] };
  const authored = [];
  let assistant = '';
  for (const event of events.reverse()) {
    collectToolEvidence(evidence, event);
    const msg = event.data?.message ?? event.data;
    if (event.surfaceOp !== 'append') continue;
    if (event.type === 'user/message' && msg.source?.kind === 'user') authored.push(stripReminders(textOf(msg)));
    if (event.type === 'assistant/message' && event.seq === receipt.final_seq) assistant = textOf(msg).trim();
  }
  const user = authored.filter(Boolean).join('\n\n');
  return user && assistant ? { user, assistant, tools: evidence.tools } : null;
}
