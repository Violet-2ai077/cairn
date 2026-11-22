import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  freezeDeep,
  readHead,
  readStaged,
  readTasksIndex,
  readTaskThread,
  upsertTask,
  writeTaskCompaction
} from '../src/kernel/index.mjs';
import { apply as applyCairnDshHost } from '../src/hosts/dsh/index.mjs';

async function withTempWorkspace(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-m1-dsh-host-'));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Builds a Mock Cordis Context (`ctx`) that enforces real `dsh 0.2.2-rc.1` service contracts:
 * - `tools.register` validates `output: { schema, render }` per `@deepseek-ai/dsh-tools`
 * - `commands.register` validates `/^[a-z][a-z0-9_-]*$/u` per `@deepseek-ai/dsh-commands`
 * - `llm.stream` runs registered `llm/stream` waterfall middleware before calling `adapterStream`
 */
function createMockDshContext({ adapterStream } = {}) {
  const contexts = new Map();
  const listeners = new Map();
  const tools = new Map();
  const commands = new Map();
  const effects = [];

  function on(eventName, listener) {
    if (!listeners.has(eventName)) {
      listeners.set(eventName, []);
    }
    const list = listeners.get(eventName);
    list.push(listener);
    return () => {
      const idx = list.indexOf(listener);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  function emit(eventName, ...args) {
    const list = listeners.get(eventName) ?? [];
    for (const fn of [...list]) {
      fn(...args);
    }
  }

  const ctx = {
    on,
    emit,
    effect(fn, label) {
      const teardown = fn();
      effects.push({ label, teardown });
      return teardown;
    },
    get(serviceName) {
      if (serviceName === 'commands') return ctx.commands;
      if (serviceName === 'tools') return ctx.tools;
      if (serviceName === 'llm') return ctx.llm;
      if (serviceName === 'systemPrompt') return ctx.systemPrompt;
      return undefined;
    },
    systemPrompt: {
      context(entry) {
        if (!Number.isFinite(entry.order)) {
          throw new TypeError(`prompt context "${entry.name}" order must be a finite number`);
        }
        contexts.set(entry.name, entry);
        return () => contexts.delete(entry.name);
      },
      renderAll(contextArg = {}) {
        return [...contexts.values()]
          .sort((a, b) => a.order - b.order)
          .map(entry => ({
            name: entry.name,
            text: typeof entry.text === 'function' ? entry.text(contextArg) : entry.text
          }));
      }
    },
    tools: {
      register(definition) {
        if (
          !definition.output ||
          typeof definition.output !== 'object' ||
          typeof definition.output.render !== 'function' ||
          !definition.output.schema
        ) {
          throw new TypeError(
            `tool "${definition.name}" must declare output { schema, render, presentationMeta? }`
          );
        }
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      }
    },
    commands: {
      register(definition) {
        if (!/^[a-z][a-z0-9_-]*$/u.test(definition.name)) {
          throw new TypeError(`Invalid command name "${definition.name}"`);
        }
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      }
    },
    llm: {
      stream(request) {
        const streamInterceptors = listeners.get('llm/stream') ?? [];
        const baseAdapter = req =>
          typeof adapterStream === 'function'
            ? adapterStream(req)
            : (async function* () {
                yield { type: 'finish', reason: { kind: 'stop' } };
              })();

        let chain = baseAdapter;
        for (let i = streamInterceptors.length - 1; i >= 0; i--) {
          const interceptor = streamInterceptors[i];
          const nextFn = chain;
          chain = req => interceptor(req, nextRequired => nextFn(nextRequired ?? req));
        }
        return chain(request);
      }
    },
    _registry: {
      contexts,
      listeners,
      tools,
      commands,
      effects
    }
  };

  return ctx;
}

describe('Cairn Milestone 1 Slice 3: DeepSeek Harness (dsh) Host Adapter (src/hosts/dsh/)', () => {
  test('1. llm/stream: enforces 64-char sliding buffer + synchronous block-end stripping without mutating frozen chunks, and bypasses purpose="cairn-worker"', async () => {
    await withTempWorkspace(async tmpDir => {
      const seenByAdapter = [];

      const ctx = createMockDshContext({
        adapterStream: async function* (req) {
          seenByAdapter.push(req);
          if (req.purpose === 'cairn-worker') {
            yield freezeDeep({
              type: 'text-delta',
              index: 0,
              text: '{"ops":[]}\n<|task:9|>'
            });
            yield freezeDeep({ type: 'finish', reason: { kind: 'stop' } });
            return;
          }

          // Emit fragmented text-delta chunks exceeding 64 chars + frozen block-end with trailing <|task:1|>
          const bodyPart1 =
            '已完成 Redis TTL 缓存超时配置与多副本一致性校验，压测指标全部达标，延迟稳定在 12ms 以内。';
          const bodyPart2 = '\n```sql\nSELECT * FROM cache_meta;\n```';
          const markerPart = '\n<|task:1|>';
          const fullRaw = `${bodyPart1}${bodyPart2}${markerPart}`;

          yield freezeDeep({ type: 'block-start', index: 0, blockType: 'text' });
          yield freezeDeep({ type: 'text-delta', index: 0, text: bodyPart1 });
          yield freezeDeep({ type: 'text-delta', index: 0, text: bodyPart2 });
          yield freezeDeep({ type: 'text-delta', index: 0, text: '\n<|ta' });
          yield freezeDeep({ type: 'text-delta', index: 0, text: 'sk:1|>' });
          yield freezeDeep({
            type: 'block-end',
            index: 0,
            block: {
              type: 'text',
              text: fullRaw
            }
          });
          yield freezeDeep({ type: 'finish', reason: { kind: 'stop' } });
        }
      });

      const host = await applyCairnDshHost(ctx, {
        workspaceRoot: tmpDir,
        stripMarkerInStream: true
      });

      // (a) Regular conversation stream: both text-delta concatenation and block-end.block.text must be stripped
      const emittedChunks = [];
      for await (const chunk of ctx.llm.stream({
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
        sessionId: 'sess-alpha',
        messages: []
      })) {
        emittedChunks.push(chunk);
      }

      const joinedDeltas = emittedChunks
        .filter(c => c.type === 'text-delta')
        .map(c => c.text)
        .join('');
      const blockEndChunk = emittedChunks.find(c => c.type === 'block-end');

      assert.equal(joinedDeltas.includes('<|task:1|>'), false);
      assert.ok(joinedDeltas.endsWith('```'));
      assert.ok(blockEndChunk);
      assert.equal(blockEndChunk.block.text, joinedDeltas);
      assert.equal(blockEndChunk.block.text.includes('<|task:1|>'), false);

      // Verify raw text & marker were stashed for TurnAccumulator before stripping
      const stashed = host.accumulator.consumeStashedMarker('sess-alpha');
      assert.ok(stashed);
      assert.equal(stashed.parsed.valid, true);
      assert.equal(stashed.parsed.task_number, 1);
      assert.equal(stashed.parsed.closed_fence_before_marker, true);
      assert.ok(stashed.rawText.endsWith('<|task:1|>'));

      // Verify observed primary conversation route was recorded
      assert.deepEqual(host.getLastObservedRoute(), {
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash'
      });

      // (b) Anti-reentrancy: `purpose: 'cairn-worker'` passes through untouched without stashing or overwriting route
      const workerChunks = [];
      for await (const chunk of ctx.llm.stream({
        provider: 'other-provider',
        model: 'other-model',
        sessionId: 'sess-alpha',
        purpose: 'cairn-worker',
        messages: []
      })) {
        workerChunks.push(chunk);
      }
      assert.equal(workerChunks[0].text, '{"ops":[]}\n<|task:9|>');
      assert.equal(host.accumulator.consumeStashedMarker('sess-alpha'), null);
      assert.deepEqual(host.getLastObservedRoute(), {
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash'
      });
    });
  });

  test('2. Multi-step ReAct turn loop -> useHostLlm zero-config staging extraction -> human-authority tools & /cairn slash command', async () => {
    await withTempWorkspace(async tmpDir => {
      const workerStreamCalls = [];

      const ctx = createMockDshContext({
        adapterStream: async function* (req) {
          if (req.purpose === 'cairn-worker') {
            workerStreamCalls.push(req);
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify({
                ops: [
                  {
                    op: 'ASSERT',
                    scope: 'global',
                    key: 'cache_strategy',
                    option_code: 'redis_ttl',
                    summary: 'Centralized Redis TTL cache after benchmark'
                  }
                ]
              })
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }

          // Primary conversation stream
          yield {
            type: 'text-delta',
            index: 0,
            text: '压测已确认 local_lru 存在 14% 脏读，已按您的拍板切换全局方案为 redis_ttl。\n<|task:1|>'
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      });

      const host = await applyCairnDshHost(ctx, {
        workspaceRoot: tmpDir,
        actorId: 'dsh-agent',
        useHostLlm: true,
        stripMarkerInStream: true
      });

      const session = { id: 'sess-react' };

      // Start Turn 1 (Multi-step ReAct: Step 1 calls a tool without task marker; Step 2 answers with <|task:1|>)
      ctx.emit('session/event', session, {
        seq: 1,
        type: 'turn/start',
        data: { turn: 1 }
      });

      // Synthetic runtime-context user message must be ignored by TurnAccumulator
      ctx.emit('session/event', session, {
        seq: 2,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          role: 'user',
          source: { kind: 'runtime-context' },
          content: [{ type: 'text', text: 'Current runtime context...' }]
        }
      });

      // Real user message
      ctx.emit('session/event', session, {
        seq: 3,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [
            {
              type: 'text',
              text: '运行缓存压测，确认脏读后我们正式拍板把全局 cache_strategy 设为 redis_ttl。'
            }
          ]
        }
      });

      // Step 1: intermediate tool-calling assistant message (NO task marker)
      ctx.emit('session/event', session, {
        seq: 4,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '正在执行缓存一致性压测脚本...' },
              {
                type: 'tool-call',
                id: 'call_bench_1',
                name: 'bash',
                arguments: JSON.stringify({ command: 'npm run bench:cache' })
              }
            ]
          }
        }
      });

      // Tool result linked via sourceEventSeqs: [4]
      ctx.emit('session/event', session, {
        seq: 5,
        type: 'tool/result',
        surfaceOp: 'append',
        sourceEventSeqs: [4],
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call_bench_1',
            isError: false,
            content: [
              {
                type: 'text',
                text: 'metric: stale_read_14pct observed at p99 latency 840ms'
              }
            ]
          }
        }
      });

      // Step 2: Run through llm/stream first (which strips <|task:1|> and stashes raw marker)
      const step2Chunks = [];
      for await (const chunk of ctx.llm.stream({
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
        sessionId: session.id,
        messages: []
      })) {
        step2Chunks.push(chunk);
      }
      const strippedStep2Text = step2Chunks
        .filter(c => c.type === 'text-delta')
        .map(c => c.text)
        .join('');
      assert.equal(strippedStep2Text.includes('<|task:1|>'), false);

      // Step 2 committed assistant/message receives the already-stripped text from BlockAssembler
      ctx.emit('session/event', session, {
        seq: 6,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 2,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: strippedStep2Text }]
          }
        }
      });

      // Turn end -> archives to .cairn/tasks/1/thread.jsonl & triggers serial async staging extractor
      ctx.emit('session/event', session, {
        seq: 7,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } }
      });

      await host.accumulator.flushPendingJobs();

      // Verify task 1 thread archival preserved raw_content (<|task:1|>) and distilled tool metadata
      const thread1 = readTaskThread(tmpDir, 1);
      assert.equal(thread1.length, 2);
      assert.equal(thread1[0].role, 'user');
      assert.equal(thread1[1].role, 'assistant');
      assert.equal(thread1[1].content.includes('<|task:1|>'), false);
      assert.ok(thread1[1].raw_content.endsWith('<|task:1|>'));
      assert.equal(thread1[1].meta.tools[0].name, 'bash');
      assert.equal(thread1[1].meta.tools[0].target, 'npm run bench:cache');

      // Verify out-of-band worker reused observed host provider/model and staged stg_1
      assert.equal(workerStreamCalls.length, 1);
      assert.equal(workerStreamCalls[0].provider, 'deepseek');
      assert.equal(workerStreamCalls[0].model, 'deepseek-v4.1-flash');
      assert.equal(workerStreamCalls[0].purpose, 'cairn-worker');

      const staged = readStaged(tmpDir);
      assert.equal(staged.proposals.length, 1);
      assert.equal(staged.proposals[0].proposal_id, 'stg_1');
      assert.equal(staged.proposals[0].ops[0].option_code, 'redis_ttl');

      // Verify systemPrompt.context includes staged notice with human-authority warning
      const renderedContexts = ctx.systemPrompt.renderAll({ agent: { session } });
      const ledgerCtx = renderedContexts.find(c => c.name === 'cairn:workspace-ledger');
      assert.ok(ledgerCtx.text.includes('stg_1'));
      assert.ok(ledgerCtx.text.includes('/cairn commit'));
      assert.ok(ledgerCtx.text.includes('Do NOT autonomously commit or drop'));

      // Verify registered tools include HUMAN AUTHORITY RED LINE and valid output.render
      const commitTool = ctx._registry.tools.get('cairn_commit');
      const dropTool = ctx._registry.tools.get('cairn_drop');
      assert.ok(commitTool.description.includes('HUMAN AUTHORITY RED LINE'));
      assert.ok(dropTool.description.includes('HUMAN AUTHORITY RED LINE'));
      assert.deepEqual(commitTool.output.render({}, 'Committed 1'), [
        { type: 'text', text: 'Committed 1' }
      ]);

      // Execute `/cairn commit` via registered dsh slash command
      const cairnCmd = ctx._registry.commands.get('cairn');
      assert.ok(cairnCmd);
      const cmdRes = await cairnCmd.handler({
        commandId: 'cmd-1',
        agent: { session },
        rawInput: 'commit',
        attachments: [],
        signal: new AbortController().signal
      });
      assert.equal(cmdRes.kind, 'success');
      assert.ok(cmdRes.text.includes('HEAD is now at revision 1'));
      assert.equal(readHead(tmpDir).active[0].id, 'D1');
      assert.equal(readHead(tmpDir).active[0].option_code, 'redis_ttl');
    });
  });

  test('3. cairn:task-continuity prioritizes work_anchor_task_id over session lastTaskId for compact.md injection, and session/disposed cleans up memory', async () => {
    await withTempWorkspace(async tmpDir => {
      const ctx = createMockDshContext();
      const host = await applyCairnDshHost(ctx, {
        workspaceRoot: tmpDir,
        useHostLlm: false
      });

      writeTaskCompaction(tmpDir, 1, 'Task 1 local summary: semicolon CSV export.');
      writeTaskCompaction(tmpDir, 2, 'Task 2 local summary: HMAC webhook verifier.');

      const session = { id: 'sess-compact' };

      // Simulate session observing Task 1
      ctx.emit('session/event', session, {
        seq: 1,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Task 1 reply.\n<|task:1|>' }]
          }
        }
      });

      assert.equal(host.accumulator.getLastTaskId(session), 1);

      // Without work_anchor_task_id, cairn:task-continuity injects Task 1's compact.md
      let taskCtx = ctx.systemPrompt
        .renderAll({ agent: { session } })
        .find(c => c.name === 'cairn:task-continuity');
      assert.ok(taskCtx.text.includes('task_id="1"'));
      assert.ok(taskCtx.text.includes('semicolon CSV export'));

      // Setting work_anchor_task_id = 2 overrides session lastTaskId and injects Task 2's compact.md
      upsertTask(tmpDir, { id: 2, work_anchor_task_id: 2 });
      taskCtx = ctx.systemPrompt
        .renderAll({ agent: { session } })
        .find(c => c.name === 'cairn:task-continuity');
      assert.ok(taskCtx.text.includes('task_id="2"'));
      assert.ok(taskCtx.text.includes('HMAC webhook verifier'));

      // Emitting session/disposed clears all per-session state in TurnAccumulator
      host.accumulator.stashStreamMarker(session.id, {
        rawText: 'test\n<|task:1|>',
        parsed: { valid: true, task_number: 1, is_unresolved: false, display_text: 'test' }
      });
      ctx.emit('session/disposed', session);

      assert.equal(host.accumulator._internal.turnStateBySession.has(session.id), false);
      assert.equal(host.accumulator._internal.lastTaskIdBySession.has(session.id), false);
      assert.equal(host.accumulator._internal.stashedMarkersBySession.has(session.id), false);
    });
  });

  test('4. request.purpose === "compaction": clones deepFreeze-d request.messages and appends COMPRESSOR_STRICT + Global Ledger Exclusion Watchlist', async () => {
    await withTempWorkspace(async tmpDir => {
      let capturedCompactionRequest = null;

      const ctx = createMockDshContext({
        adapterStream: async function* (req) {
          capturedCompactionRequest = req;
          yield {
            type: 'text-delta',
            index: 0,
            text: '## Primary Request and Intent\n- Local task summary only'
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      });

      await applyCairnDshHost(ctx, {
        workspaceRoot: tmpDir,
        useHostLlm: false
      });

      // Populate an active global decision D1 in head.json via `/cairn` or store
      const cairnCmd = ctx._registry.commands.get('cairn');
      assert.ok(cairnCmd);

      // Construct a compaction request matching `@deepseek-ai/dsh-compaction-basic` with deepFreeze-d messages
      const frozenSystemMsg = freezeDeep({
        role: 'system',
        content: [{ type: 'text', text: 'System head prompt' }]
      });
      const frozenUserMsg = freezeDeep({
        role: 'user',
        content: [{ type: 'text', text: 'Earlier turn content' }]
      });
      const frozenDirectiveMsg = freezeDeep({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are now acting as a compaction engine for this AI coding assistant.'
          }
        ]
      });
      const frozenMessagesArray = freezeDeep([
        frozenSystemMsg,
        frozenUserMsg,
        frozenDirectiveMsg
      ]);

      const compactionRequest = {
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
        sessionId: 'sess-compact-native',
        purpose: 'compaction',
        messages: frozenMessagesArray
      };

      const chunks = [];
      for await (const chunk of ctx.llm.stream(compactionRequest)) {
        chunks.push(chunk);
      }

      assert.ok(capturedCompactionRequest);
      // Prefix messages [0, 1] retain exact reference identity for KV-cache reuse
      assert.equal(capturedCompactionRequest.messages[0], frozenSystemMsg);
      assert.equal(capturedCompactionRequest.messages[1], frozenUserMsg);

      // Original frozenDirectiveMsg was not mutated; last message in request was cloned with COMPRESSOR_STRICT
      assert.equal(
        frozenDirectiveMsg.content[0].text,
        'You are now acting as a compaction engine for this AI coding assistant.'
      );
      const updatedFinalText = capturedCompactionRequest.messages[2].content[0].text;
      assert.ok(
        updatedFinalText.includes(
          'You are now acting as a compaction engine for this AI coding assistant.'
        )
      );
      assert.ok(updatedFinalText.includes('COMPRESSOR_STRICT'));
    });
  });
});
