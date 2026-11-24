// This provider is loaded only in the isolated smoke profile, not by Cairn.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const resolve = createRequire(process.env.CAIRN_DSH_BIN).resolve;
const { LlmAdapter } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-llm')));
const phase = process.env.CAIRN_SMOKE_PHASE;
const log = data => fs.appendFileSync(process.env.CAIRN_SMOKE_TRACE, JSON.stringify({ phase, ...data }) + '\n');
const body = msg => (msg?.content ?? []).map(b => b.text ?? '').join('\n');
const reason = 'npm fails the workspace install';
export const name = 'cairn-smoke-provider';
export const inject = ['llm', 'compaction', 'tools', 'commands'];
export function apply(ctx) {
  ctx.tools.register({ name: 'probe_csv', description: 'Run the smoke CSV test', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    execute() {
      const result = spawnSync(process.execPath, ['--test', 'csv.test.cjs'], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 1 || !result.stdout.includes('CSV_HEADER_EXPECTED')) throw Error('Unexpected fixture output');
      throw Error('FAIL csv-header: CSV_HEADER_EXPECTED');
    } });
  if (phase === 'compact') {
    let active, completed = false, started = false;
    ctx.on('agent/created', ({ agent }) => { active = agent; }, { global: true });
    ctx.on('session/event', (session, event) => {
      if (session === active?.session && event.type === 'turn/end') completed = true;
    }, { global: true });
    ctx.on('session/flush', async session => {
      if (!completed || started || active?.status !== 'idle' || session !== active.session) return;
      started = true;
      const claim = await ctx.commands.execute(active, '/cairn recover 3 2', [], new AbortController().signal);
      log({ recovered: claim?.result.kind, recoveryMessage: claim?.result.text });
      const result = await ctx.compaction.compactNow(active, new AbortController().signal);
      log({ shadowed: result?.shadowedSeqs.length ?? 0 });
    }, { global: true });
  }
  let calledTool = false;
  ctx.llm.registerAdapter(['cairn-offline'], new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(req) {
      let text;
      const system = body(req.messages[0]);
      const snapshot = body(req.messages.findLast(m => m.source?.kind === 'runtime-context'));
      if (req.purpose === 'compaction') {
        const directive = body(req.messages.at(-1));
        log({ nativeBoundary: directive.includes('Do not merge task progress') && directive.includes('test_runner') });
        text = 'Historical conversation compacted.';
      } else if (req.purpose === 'cairn-worker' && system.startsWith('Route the opening')) {
        const projectId = /"project_id"\s*:\s*"([^"]+)"/u.exec(system)?.[1];
        text = JSON.stringify(phase === 'resume' ? { decision: 'match', task_id: 1, project_id: projectId } : { decision: 'new', task_id: null });
      } else if (req.purpose === 'cairn-worker') {
        const op = phase === 'a' ? { op: 'ASSERT', key: 'test_runner', option_code: 'npm', summary: 'Use npm' }
          : { op: 'SUPERSEDE', target_id: 'D1', option_code: 'pnpm', summary: 'Use pnpm', reason };
        text = JSON.stringify(['a', 'b'].includes(phase) ? { ops: [op], evidence: [{ op_index: 0,
          user_quote: 'Use ' + op.option_code, ...(phase === 'b' && { falsification_quote: reason }) }] } : { ops: [] });
      } else if (req.purpose) text = 'CSV work';
      else {
        const task = Number(/Required tail marker for this request: <\|task:(\d+)\|>/u.exec(snapshot)?.[1]);
        const ledger = JSON.parse(/### Current Project Ledger[^\n]*\n(\{[\s\S]*?\n\})/u.exec(snapshot)?.[1] ?? '{}');
        const checkout = /<cairn_task_checkout [^>]+>([\s\S]*?)<\/cairn_task_checkout>/u.exec(snapshot)?.[1] ?? '';
        log({ sessionId: req.sessionId, snapshot: { task, blocker: checkout.includes('CSV_HEADER_EXPECTED'),
          current: ledger.active?.some(d => d.option_code === 'pnpm') ?? false,
          superseded: ledger.tombstones?.some(d => d.option_code === 'npm') ?? false } });
        if (phase === 'a' && !calledTool) {
          calledTool = true;
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'smoke-csv', name: 'probe_csv', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'smoke-csv', name: 'probe_csv', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        text = phase === 'compact' ? 'Confirmed with no marker' : (phase === 'b' ? reason : 'Done') + '\n<|task:' + task + '|>';
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
}
