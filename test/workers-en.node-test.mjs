import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as kernel from '../src/kernel/contracts.mjs';
import { appendTaskTurn, initCairnStore, writeTaskCompaction } from '../src/kernel/index.mjs';

// Select English before loading runtime modules, regardless of the developer's OS.
process.env.CAIRN_LOCALE = 'en';
const runtime = await import('../src/i18n/contracts.mjs');
const { runColdRouter, compileTaskCheckout, runStagingExtractor } = await import('../src/workers/index.mjs');

test('all six English runtime contracts retain the kernel protocols without localizing input data', () => {
  const original = '原始记录';
  const snapshot = { original };
  const inputs = [
    ['buildAntiRecencyContract', [{ tasks: [{ id: 2, title: original }], workAnchorTaskId: 2 }], [original, '<|task:2|>', '<|task:UNRESOLVED|>', 'Anti-Recency / Anti-Primacy']],
    ['buildStagingExtractorPrompt', [snapshot], [original, 'ASSERT', 'SUPERSEDE', 'OPEN_QUESTION', 'RESOLVE_QUESTION', '{"ops":[]}']],
    ['buildStrictCompactorPrompt', [{ taskId: 2 }], ['<|task:2|>', 'COMPRESSOR_STRICT', 'Never include workspace-global']],
    ['buildAuthorityCheckoutContract', [snapshot], [original, 'workspace_ledger.active', 'workspace_ledger.tombstones', 'UNKNOWN', 'status === "resolved"']],
    ['buildScopedAuthorityContract', [{ projectName: original, userLedgerSnapshot: snapshot }], [original, 'User Ledger', 'Project Ledger', 'cwd']],
    ['buildScopedStagingExtractorPrompt', ['project', snapshot, { withEvidence: true }], [original, '"scope":"project"', 'falsification_quote', 'op_index']]
  ];
  for (const [name, args, expected] of inputs) {
    const output = runtime[name](...args);
    assert.equal(output, kernel[name](...args, 'en'), name);
    assert.match(kernel[name](...args).replaceAll(original, ''), /\p{Script=Han}/u, name);
    assert.doesNotMatch(output.replaceAll(original, ''), /\p{Script=Han}/u, name);
    for (const part of expected) assert.ok(output.includes(part), name + ': ' + part);
  }
  const user = runtime.buildScopedStagingExtractorPrompt('user');
  assert.ok(user.includes('"scope":"user"'));
  assert.ok(!user.includes('"scope":"global"'));
  assert.ok(!user.includes('falsification_quote'));
});

test('workspace checkout, cold routing and staging localize the frame but not the stored or incoming text', async t => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-workers-en-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  initCairnStore(workspaceRoot);
  const original = '保留用户原文';
  appendTaskTurn(workspaceRoot, { task_id: 1, role: 'user', content: original });
  writeTaskCompaction(workspaceRoot, 1, original, { compactedRecordCount: 1 });
  appendTaskTurn(workspaceRoot, { task_id: 1, role: 'user', content: original });
  const checkout = compileTaskCheckout({ workspaceRoot, taskId: 1 });
  assert.match(checkout.text, /Compressed task-local summary/u);
  assert.match(checkout.text, /Uncompressed recent task records/u);
  assert.ok(checkout.text.includes(original));
  assert.doesNotMatch(checkout.text.replaceAll(original, ''), /\p{Script=Han}/u);

  async function capture(run, options, response) {
    let request;
    await run({ workspaceRoot, ...options, llmClient: { complete: async input => {
      request = input;
      return { ok: true, content: JSON.stringify(response) };
    } } });
    assert.ok(request.messages[0].content.includes(original));
    assert.doesNotMatch(request.messages[0].content.replaceAll(original, ''), /\p{Script=Han}/u);
    assert.doesNotMatch(request.system.replaceAll(original, ''), /\p{Script=Han}/u);
    return request.system;
  }
  assert.match(await capture(runColdRouter, { userPrompt: original }, { decision: 'new', task_id: null, candidates: [] }), /Anti-Primacy/u);
  assert.match(await capture(runStagingExtractor, { turnInput: { user: original } }, { ops: [] }), /current_ledger_head/u);
});
