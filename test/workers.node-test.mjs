import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initCairnStore,
  readStaged,
  commitStaged,
  readTasksIndex,
  appendTaskTurn,
  readTaskCompaction,
  writeTaskCompaction,
  upsertTask
} from '../src/kernel/index.mjs';

import {
  createOpenAICompatibleClient,
  createMockLlmClient,
  distillTurnTrajectory,
  runStagingExtractor,
  runStrictCompactor,
  compileTaskCheckout,
  buildColdRouterPrompt,
  runColdRouter
} from '../src/workers/index.mjs';

async function withTempWorkspace(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-m1-workers-'));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Cairn Milestone 1 Slice 2: Asynchronous Workers Layer (src/workers/)', () => {
  test('6. task checkout compiles compact plus uncaptured tail, retains newest text, clamps stale cursors, and stays read-only', async () => {
    await withTempWorkspace(async tmpDir => {
      initCairnStore(tmpDir);
      upsertTask(tmpDir, { id: 1, title: 'Task one' });
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'old request' });
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'assistant', content: 'old answer' });
      writeTaskCompaction(tmpDir, 1, 'task-local compact summary', { compactedRecordCount: 2 });
      appendTaskTurn(tmpDir, { task_id: 1, turn: 2, role: 'user', content: 'recent request' });
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 2,
        role: 'assistant',
        content: `${'routine '.repeat(100)}LATEST_TAIL_MARKER`
      });

      const result = compileTaskCheckout({ workspaceRoot: tmpDir, taskId: 1, maxTailChars: 180 });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'ready');
      assert.equal(result.compacted_record_count, 2);
      assert.equal(result.total_record_count, 4);
      assert.equal(result.included_tail_record_count, 2);
      assert.ok(result.text.includes('task-local compact summary'));
      assert.ok(result.text.includes('LATEST_TAIL_MARKER'));
      assert.ok(result.text.includes('全局 Ledger / Tombstone'));
      assert.equal(result.text.includes('old request'), false);

      writeTaskCompaction(tmpDir, 1, 'cursor ahead summary', { compactedRecordCount: 99 });
      const clamped = compileTaskCheckout({ workspaceRoot: tmpDir, taskId: 1 });
      assert.equal(clamped.status, 'compact_only');
      assert.equal(clamped.included_tail_record_count, 0);

      const before = readTasksIndex(tmpDir);
      const missing = compileTaskCheckout({ workspaceRoot: tmpDir, taskId: 9 });
      assert.equal(missing.ok, false);
      assert.equal(missing.status, 'not_found');
      assert.equal(missing.text, '');
      assert.deepEqual(readTasksIndex(tmpDir), before);
    });
  });

  test('1. llm-client: defaults to stream:false, redacts Authorization, combines timeout & caller signal, and retries only transport errors', async () => {
    const logs = [];
    let fetchAttempts = 0;

    const client = createOpenAICompatibleClient({
      apiBase: 'https://example.invalid/v1',
      apiKey: 'sk-secret-do-not-leak',
      model: 'deepseek-v4.1-flash',
      retryDelayMs: 5,
      maxTransportRetries: 2,
      onLog: entry => logs.push(entry),
      fetchImpl: async (url, init) => {
        fetchAttempts++;
        const parsedBody = JSON.parse(init.body);
        assert.equal(parsedBody.stream, false);
        assert.equal(init.headers.Authorization, 'Bearer sk-secret-do-not-leak');

        if (fetchAttempts === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => 'Service temporarily unavailable'
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek-v4.1-flash',
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            choices: [
              {
                message: {
                  content: '{"ops":[]}',
                  reasoning_content: 'checked authority gate'
                }
              }
            ]
          })
        };
      }
    });

    const res = await client.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'low'
    });

    assert.equal(res.ok, true);
    assert.equal(res.content, '{"ops":[]}');
    assert.equal(res.reasoning_content, 'checked authority gate');
    assert.equal(res.transport_retries, 1);
    assert.equal(fetchAttempts, 2);
    assert.equal(res.raw_request.headers.Authorization, 'Bearer [REDACTED]');
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs).includes('sk-secret-do-not-leak'), false);

    // Timeout retries & fails cleanly with timeout_error
    let timeoutCalls = 0;
    const timeoutClient = createOpenAICompatibleClient({
      apiKey: 'sk-test',
      timeoutMs: 25,
      maxTransportRetries: 1,
      retryDelayMs: 5,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          timeoutCalls++;
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason ?? new DOMException('Timed out', 'TimeoutError'));
          });
        })
    });
    const timeoutRes = await timeoutClient.complete({
      messages: [{ role: 'user', content: 'slow' }]
    });
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.error_code, 'timeout_error');
    assert.equal(timeoutRes.transport_retries, 1);
    assert.equal(timeoutCalls, 2);

    // External caller AbortSignal aborts immediately without transport retry
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const abortedRes = await timeoutClient.complete({
      messages: [{ role: 'user', content: 'aborted' }],
      signal: abortCtrl.signal
    });
    assert.equal(abortedRes.ok, false);
    assert.equal(abortedRes.error_code, 'aborted');
    assert.equal(abortedRes.transport_retries, 0);
  });

  test('2. distill: strips <|task:N|> markers, folds oversized code blocks, and preserves high-signal tool metrics within budget', () => {
    const noisyStdout = [
      ...Array.from({ length: 120 }, (_, i) => `info: scanning module_${i}.mjs ... ok`),
      'FAIL: multi-replica write consistency check failed (exit_code=1)',
      'metric: stale_read_14pct observed at p99 latency 840ms under 1200 QPS',
      ...Array.from({ length: 80 }, (_, i) => `debug: cleanup step_${i}`)
    ].join('\n');

    const longCode = Array.from({ length: 40 }, (_, i) => `const line_${i} = ${i};`).join('\n');
    const assistantRaw = `根据压测结果，建议切换至 Redis TTL 方案：\n\`\`\`javascript\n${longCode}\n\`\`\`\n<|task:2|>`;

    const distilled = distillTurnTrajectory({
      turn: 4,
      user: '压测一下当前 local_lru 缓存，如果 stale_read 超过 10% 我们就正式拍板切到 redis_ttl。',
      assistant: assistantRaw,
      tools: [
        {
          name: 'bash',
          target: 'npm run bench:cache',
          ok: false,
          exit_code: 1,
          output: noisyStdout
        }
      ]
    });

    assert.ok(distilled.distilled_text.includes('[Turn 4]'));
    assert.ok(distilled.distilled_text.includes('stale_read_14pct observed at p99 latency 840ms'));
    assert.ok(distilled.distilled_text.includes('[omitted 200 lines of routine output]'));
    assert.ok(distilled.distilled_text.includes('[code block (javascript, 40 lines) omitted]'));
    assert.equal(distilled.distilled_text.includes('<|task:2|>'), false);
    assert.equal(distilled.stats.compressed_code_blocks, 1);
    assert.ok(distilled.stats.distilled_chars < distilled.stats.raw_chars);
  });

  test('3. staging-extractor: enforces strict JSON.parse (rejecting markdown fences), sanitizes partially valid batches, and rejects all-illegal batches without polluting staged.json', async () => {
    await withTempWorkspace(async tmpDir => {
      initCairnStore(tmpDir);

      // (a) Markdown-fenced JSON must be strictly rejected without touching staged.json
      const fencedClient = createMockLlmClient(
        '```json\n{"ops":[{"op":"ASSERT","scope":"global","key":"k","option_code":"v","summary":"s"}]}\n```'
      );
      const fencedRes = await runStagingExtractor({
        workspaceRoot: tmpDir,
        turnInput: { turn: 1, user: 'Use v for k', assistant: 'Done.\n<|task:1|>' },
        llmClient: fencedClient
      });
      assert.equal(fencedRes.ok, false);
      assert.equal(fencedRes.stage_status, 'invalid_json_output');
      assert.equal(fencedRes.error_code, 'markdown_fence_forbidden');
      assert.equal(readStaged(tmpDir).proposals.length, 0);

      // (b) All-illegal operators rejected by kernel pre-check must NOT pollute staged.json
      const allIllegalClient = createMockLlmClient(
        JSON.stringify({
          ops: [
            {
              op: 'ASSERT',
              id: 'D1',
              scope: 'global',
              key: 'cache_strategy',
              option_code: 'local_lru',
              summary: 'Invented ID'
            }
          ]
        })
      );
      const illegalRes = await runStagingExtractor({
        workspaceRoot: tmpDir,
        turnInput: { turn: 2, user: 'Use local_lru', assistant: 'Done.\n<|task:1|>' },
        llmClient: allIllegalClient
      });
      assert.equal(illegalRes.ok, false);
      assert.equal(illegalRes.stage_status, 'operators_rejected_by_kernel');
      assert.equal(illegalRes.precheck_rejected_ops.length, 1);
      assert.equal(readStaged(tmpDir).proposals.length, 0);

      // (c) Partially valid batch: 1 legal global ASSERT + 1 illegal local ASSERT -> stages ONLY the legal op
      const partialClient = createMockLlmClient(
        JSON.stringify({
          ops: [
            {
              op: 'ASSERT',
              scope: 'global',
              key: 'cache_strategy',
              option_code: 'local_lru',
              summary: 'In-process LRU cache'
            },
            {
              op: 'ASSERT',
              scope: 'local',
              key: 'dev_port',
              option_code: '9229',
              summary: 'Local debugger port'
            }
          ]
        })
      );
      const partialRes = await runStagingExtractor({
        workspaceRoot: tmpDir,
        turnInput: { turn: 3, user: 'Confirm local_lru globally', assistant: 'OK.\n<|task:1|>' },
        llmClient: partialClient
      });
      assert.equal(partialRes.ok, true);
      assert.equal(partialRes.stage_status, 'staged');
      assert.equal(partialRes.staged, true);
      assert.equal(partialRes.ops.length, 1);
      assert.equal(partialRes.ops[0].key, 'cache_strategy');
      assert.equal(partialRes.precheck_rejected_ops.length, 1);
      assert.equal(partialRes.precheck_rejected_ops[0].error, 'assert_non_global_scope_rejected');
      assert.equal(partialRes.base_revision, 0);

      const staged = readStaged(tmpDir);
      assert.equal(staged.proposals.length, 1);
      assert.equal(staged.proposals[0].ops.length, 1);
    });
  });

  test('4. strict-compactor: tracks compacted_record_count cursor, short-circuits on no_new_turns, and injects Global Ledger Exclusion Watchlist on incremental compaction', async () => {
    await withTempWorkspace(async tmpDir => {
      initCairnStore(tmpDir);

      // Commit a global decision D1 (cache_strategy = redis_ttl) so it enters the Global Exclusion Watchlist
      const stageClient = createMockLlmClient(
        JSON.stringify({
          ops: [
            {
              op: 'ASSERT',
              scope: 'global',
              key: 'cache_strategy',
              option_code: 'redis_ttl',
              summary: 'Global Redis TTL cache'
            }
          ]
        })
      );
      await runStagingExtractor({
        workspaceRoot: tmpDir,
        turnInput: { turn: 1, user: 'Establish redis_ttl', assistant: 'OK.\n<|task:1|>' },
        llmClient: stageClient
      });
      commitStaged(tmpDir);

      // Append 2 turns to Task 1
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 1,
        role: 'user',
        content: 'Set up order export CSV delimiter to semicolon.'
      });
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 1,
        role: 'assistant',
        content: 'Configured CSV delimiter to `;` in export-orders.mjs.\n<|task:1|>'
      });

      const compactorClient = createMockLlmClient((req, callIdx) => {
        if (callIdx === 0) {
          return '- Order export CSV delimiter configured to `;` in `export-orders.mjs`.';
        }
        return '- Order export CSV delimiter configured to `;` in `export-orders.mjs`.\n- Added UTF-8 BOM header for Excel compatibility.';
      });

      // First incremental compaction compacts records 1..2 and sets compacted_record_count = 2
      const c1 = await runStrictCompactor({
        workspaceRoot: tmpDir,
        taskId: 1,
        mode: 'incremental',
        llmClient: compactorClient
      });
      assert.equal(c1.ok, true);
      assert.equal(c1.skipped, false);
      assert.equal(c1.llm_called, true);
      assert.equal(c1.compacted_record_count, 2);
      assert.equal(compactorClient.calls.length, 1);
      assert.ok(compactorClient.calls[0].system.includes('cache_strategy'));
      assert.ok(compactorClient.calls[0].system.includes('redis_ttl'));
      assert.equal(readTasksIndex(tmpDir).tasks[0].compacted_record_count, 2);

      // Re-running incremental compaction with ZERO new turns must deterministically short-circuit without calling LLM
      const c2ShortCircuit = await runStrictCompactor({
        workspaceRoot: tmpDir,
        taskId: 1,
        mode: 'incremental',
        llmClient: compactorClient
      });
      assert.equal(c2ShortCircuit.ok, true);
      assert.equal(c2ShortCircuit.skipped, true);
      assert.equal(c2ShortCircuit.reason, 'no_new_turns');
      assert.equal(c2ShortCircuit.llm_called, false);
      assert.equal(compactorClient.calls.length, 1);

      // Append 1 new turn -> incremental compaction slices only the new record (#3) and merges with previous_compact_note
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 2,
        role: 'assistant',
        content: 'Added UTF-8 BOM header to export-orders.mjs.\n<|task:1|>'
      });

      const c3 = await runStrictCompactor({
        workspaceRoot: tmpDir,
        taskId: 1,
        mode: 'incremental',
        llmClient: compactorClient
      });
      assert.equal(c3.ok, true);
      assert.equal(c3.skipped, false);
      assert.equal(c3.llm_called, true);
      assert.equal(c3.compacted_record_count, 3);
      assert.equal(compactorClient.calls.length, 2);

      const secondCallUserMsg = compactorClient.calls[1].messages[0].content;
      assert.ok(secondCallUserMsg.includes('previous_compact_note'));
      assert.ok(secondCallUserMsg.includes('[#3 turn=2 assistant]'));
      assert.equal(secondCallUserMsg.includes('[#1 turn=1 user]'), false);
      assert.ok(readTaskCompaction(tmpDir, 1).includes('UTF-8 BOM header'));
    });
  });

  test('strict-compactor retries empty output once, preserves state on repeated empties, and stops retrying on abort', async () => {
    await withTempWorkspace(async tmpDir => {
      initCairnStore(tmpDir);
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'Initial request' });
      writeTaskCompaction(tmpDir, 1, 'Existing compact', { compactedRecordCount: 1 });
      appendTaskTurn(tmpDir, { task_id: 1, turn: 2, role: 'assistant', content: 'New task detail' });

      const retryClient = {
        calls: [],
        async complete(request) {
          this.calls.push(request);
          return this.calls.length === 1
            ? { ok: true, content: '', raw_response: { choices: [{ finish_reason: 'length' }] } }
            : { ok: true, content: 'Updated compact summary' };
        }
      };
      const retried = await runStrictCompactor({ workspaceRoot: tmpDir, taskId: 1, llmClient: retryClient });
      assert.equal(retryClient.calls.length, 2);
      assert.equal(retried.ok, true);
      assert.equal(retried.attempts, 2);
      assert.equal(retried.compacted_record_count, 2);
      assert.equal(readTaskCompaction(tmpDir, 1), 'Updated compact summary\n');

      appendTaskTurn(tmpDir, { task_id: 1, turn: 3, role: 'assistant', content: 'Another new detail' });
      const beforeCompact = readTaskCompaction(tmpDir, 1);
      const beforeCursor = readTasksIndex(tmpDir).tasks[0].compacted_record_count;
      const emptyClient = {
        calls: 0,
        async complete() {
          this.calls++;
          return { ok: true, content: '', raw_response: { choices: [{ finish_reason: 'length' }] } };
        }
      };
      const empty = await runStrictCompactor({ workspaceRoot: tmpDir, taskId: 1, llmClient: emptyClient });
      assert.equal(emptyClient.calls, 2);
      assert.equal(empty.ok, false);
      assert.equal(empty.reason, 'empty_compaction_output');
      assert.equal(empty.attempts, 2);
      assert.equal(empty.raw_response_length, 0);
      assert.equal(empty.finish_reason, 'length');
      assert.equal(readTaskCompaction(tmpDir, 1), beforeCompact);
      assert.equal(readTasksIndex(tmpDir).tasks[0].compacted_record_count, beforeCursor);

      const abortController = new AbortController();
      const abortClient = {
        calls: 0,
        async complete() {
          this.calls++;
          abortController.abort(new Error('stop compaction'));
          return { ok: true, content: '' };
        }
      };
      const aborted = await runStrictCompactor({
        workspaceRoot: tmpDir,
        taskId: 1,
        llmClient: abortClient,
        signal: abortController.signal
      });
      assert.equal(abortClient.calls, 1);
      assert.equal(aborted.reason, 'aborted');
      assert.equal(aborted.attempts, 1);
      assert.equal(readTaskCompaction(tmpDir, 1), beforeCompact);
      assert.equal(readTasksIndex(tmpDir).tasks[0].compacted_record_count, beforeCursor);
    });
  });

  test('5. cold-router: short-circuits on empty catalog, physically excludes updated_at/turn_count from prompt cards, and validates match/ambiguous/new decisions', async () => {
    await withTempWorkspace(async tmpDir => {
      initCairnStore(tmpDir);

      const neverCalledClient = createMockLlmClient(() => {
        throw new Error('Should not be called on empty task catalog');
      });

      // (a) Empty catalog short-circuit
      const emptyRes = await runColdRouter({
        workspaceRoot: tmpDir,
        userPrompt: 'Start new feature',
        llmClient: neverCalledClient
      });
      assert.equal(emptyRes.ok, true);
      assert.equal(emptyRes.decision, 'new');
      assert.equal(emptyRes.llm_called, false);

      // Populate Tasks 1 and 2 with timestamps and turn counts
      appendTaskTurn(tmpDir, {
        task_id: 2,
        turn: 5,
        role: 'user',
        title: 'Webhook signature verification',
        content: 'Verify HMAC-SHA256 webhook signature header',
        timestamp: '2026-11-22T14:00:00.000Z'
      });
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 1,
        role: 'user',
        title: 'CSV export delimiter',
        content: 'Export order report with semicolon delimiter',
        timestamp: '2026-11-20T08:00:00.000Z'
      });

      // (b) Physical exclusion of updated_at, turn_count, and birth_turn in buildColdRouterPrompt
      const rawTasks = readTasksIndex(tmpDir).tasks;
      const routerPrompt = buildColdRouterPrompt(rawTasks);
      assert.equal(routerPrompt.includes('updated_at'), false);
      assert.equal(routerPrompt.includes('turn_count'), false);
      assert.equal(routerPrompt.includes('birth_turn'), false);
      assert.equal(routerPrompt.includes('2026-11-22'), false);
      assert.equal(routerPrompt.includes('2026-11-20'), false);

      // (c) Ambiguous routing on underspecified prompt ("继续上次那个任务")
      const ambigClient = createMockLlmClient(
        JSON.stringify({
          decision: 'ambiguous',
          task_id: null,
          candidates: [1, 2],
          reason: 'Opening request is a generic continuation matching multiple established tasks'
        })
      );
      const ambigRes = await runColdRouter({
        workspaceRoot: tmpDir,
        userPrompt: '继续上次那个任务',
        llmClient: ambigClient
      });
      assert.equal(ambigRes.ok, true);
      assert.equal(ambigRes.decision, 'ambiguous');
      assert.equal(ambigRes.task_id, null);
      assert.deepEqual(ambigRes.candidates, [1, 2]);
      assert.equal(ambigClient.calls[0].system.includes('updated_at'), false);
      assert.equal(ambigClient.calls[0].system.includes('turn_count'), false);

      // (d) Unique match with applyWorkAnchor: true
      const matchClient = createMockLlmClient(
        JSON.stringify({
          decision: 'match',
          task_id: 2,
          candidates: [2],
          reason: 'Explicitly references HMAC-SHA256 webhook signature'
        })
      );
      const matchRes = await runColdRouter({
        workspaceRoot: tmpDir,
        userPrompt: '给 HMAC-SHA256 webhook 验签加上重放时间戳校验',
        applyWorkAnchor: true,
        llmClient: matchClient
      });
      assert.equal(matchRes.ok, true);
      assert.equal(matchRes.decision, 'match');
      assert.equal(matchRes.task_id, 2);
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, 2);

      // (e) Rejects hallucinated non-existent task_id
      const hallucinatedClient = createMockLlmClient(
        JSON.stringify({
          decision: 'match',
          task_id: 99,
          candidates: [99],
          reason: 'Hallucinated task ID'
        })
      );
      const badMatchRes = await runColdRouter({
        workspaceRoot: tmpDir,
        userPrompt: 'Something else',
        llmClient: hallucinatedClient
      });
      assert.equal(badMatchRes.ok, false);
      assert.equal(badMatchRes.error_code, 'invalid_routed_task_id');

      const newClient = createMockLlmClient(JSON.stringify({ decision: 'new', task_id: null, candidates: [], reason: 'unrelated objective' }));
      const newRes = await runColdRouter({ workspaceRoot: tmpDir, userPrompt: 'A distinct new task', llmClient: newClient });
      assert.equal(newRes.ok, true);
      assert.equal(newRes.decision, 'new');

      const failedClient = { async complete() { return { ok: false, error_code: 'offline', error_message: 'offline' }; } };
      const failedRes = await runColdRouter({ workspaceRoot: tmpDir, userPrompt: 'Continuation', llmClient: failedClient });
      assert.equal(failedRes.ok, false);
      assert.equal(failedRes.error_code, 'offline');
    });
  });
});
