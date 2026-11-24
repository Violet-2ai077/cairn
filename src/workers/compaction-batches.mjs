import { distillTaskThread } from './distill.mjs';

// The checkout preview can be lossy; the input covered by a durable cursor cannot.
export function* compactionBatches(records, { maxThreadChars = 12000, ...options } = {}) {
  if (maxThreadChars !== Infinity && (!Number.isSafeInteger(maxThreadChars) || maxThreadChars < 2)) throw new RangeError('invalid_compaction_batch_size');
  let batch = '';
  for (const record of records) {
    const { distilled_text } = distillTaskThread([{ ...record, meta: { attribution: record.meta?.attribution } }], {
      ...options, maxThreadChars: Infinity, maxPerRecordChars: Infinity, maxCodeBlockChars: Infinity
    });
    const text = record.meta?.tools?.length ? distilled_text + '\nTool evidence: ' + JSON.stringify(record.meta.tools) : distilled_text;
    if (batch && batch.length + 2 + text.length > maxThreadChars) {
      yield batch;
      batch = '';
    }
    if (batch) batch += '\n\n';
    let offset = 0;
    while (text.length - offset > maxThreadChars) {
      let end = offset + maxThreadChars;
      const middle = offset + Math.ceil(maxThreadChars / 2);
      const newline = text.slice(middle, end).lastIndexOf('\n');
      if (newline >= 0) end = middle + newline + 1;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
      yield text.slice(offset, end);
      offset = end;
    }
    batch += text.slice(offset);
  }
  if (batch) yield batch;
}

export async function summarizeBatches({ records, previous, client, system, signal, reasoningEffort, maxEmptyRetries, options }) {
  let summary = previous?.trim();
  let response;
  let attempts = 0;
  const retries = Number.isSafeInteger(maxEmptyRetries) ? Math.max(0, maxEmptyRetries) : 1;
  for (const batch of compactionBatches(records, options)) {
    const message = summary
      ? `### Previous task-local summary (previous_compact_note)\n${summary}\n\n### New task records (new_task_records)\n${batch}\n\nMerge without adding global rules.`
      : `### Task records (task_records)\n${batch}`;
    for (let retry = 0; retry <= retries; retry++) {
      if (signal?.aborted) return { attempts, response: { ok: false, error_code: 'aborted' } };
      attempts++;
      try {
        response = await client.complete({ system, messages: [{ role: 'user', content: message }], temperature: 0, reasoningEffort, signal });
      } catch {
        return { attempts, response: { ok: false, error_code: signal?.aborted ? 'aborted' : 'llm_error' } };
      }
      summary = String(response.content ?? '').trim();
      if (!response.ok || summary) break;
    }
    if (!response.ok || !summary || signal?.aborted) break;
  }
  return { attempts, response };
}
