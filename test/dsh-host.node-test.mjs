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
  appendTaskTurn,
  writeTaskCompaction
} from '../src/kernel/index.mjs';
import {
  apply as cordisApplyCairnDshHost,
  createCairnDshHost as applyCairnDshHost
} from '../src/hosts/dsh/index.mjs';

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
    async runPreStep(payload, base = { kind: 'enter', messages: payload.messages }) {
      const chain = [...(listeners.get('agent/pre-step') ?? [])];
      const dispatch = async index => index >= chain.length ? (typeof base === 'function' ? base() : base) : chain[index](payload, () => dispatch(index + 1));
      return dispatch(0);
    },
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
        model: 'deepseek-v4.1-flash',
        sessionId: 'sess-alpha'
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
        model: 'deepseek-v4.1-flash',
        sessionId: 'sess-alpha'
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
      assert.equal(workerStreamCalls[0].sessionId, session.id);
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
      const checkoutTool = ctx._registry.tools.get('cairn_checkout');
      const compactTool = ctx._registry.tools.get('cairn_compact');
      assert.ok(commitTool.description.includes('HUMAN AUTHORITY RED LINE'));
      assert.ok(dropTool.description.includes('HUMAN AUTHORITY RED LINE'));
      assert.ok(checkoutTool.description.includes('HUMAN AUTHORITY RED LINE'));
      assert.ok(compactTool.description.includes('HUMAN AUTHORITY RED LINE'));
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

      const checkoutRes = await cairnCmd.handler({ rawInput: 'checkout 1', signal: new AbortController().signal });
      assert.equal(checkoutRes.kind, 'success');
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, 1);
      await checkoutTool.execute({ clear: true });
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, null);

      const compactRes = await cairnCmd.handler({ rawInput: 'compact', agent: { session }, signal: new AbortController().signal });
      assert.equal(compactRes.kind, 'success');
      assert.match(compactRes.text, /"task_id":1/);
      assert.ok(readTasksIndex(tmpDir).tasks[0].has_compact);
      const compactToolRes = await compactTool.execute({}, { agent: { session } });
      assert.match(compactToolRes, /"task_id":1/);
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

  test('5. pre-step cold routing binds once, injects refreshed context from a cached snapshot, and bypasses empty/anchored catalogs', async () => {
    await withTempWorkspace(async tmpDir => {
      const calls = [];
      upsertTask(tmpDir, { id: 1, title: 'Router task' });
      upsertTask(tmpDir, { id: 2, title: 'Switched task' });
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'Initial task history' });
      appendTaskTurn(tmpDir, { task_id: 2, turn: 1, role: 'user', content: 'SWITCHED_TASK_HISTORY' });
      const ctx = createMockDshContext({ adapterStream: async function* (request) { calls.push(request); yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: 'match', task_id: 1, candidates: [1], reason: 'unique' }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } });
      const host = await applyCairnDshHost(ctx, { workspaceRoot: tmpDir });
      const session = { id: 'cold-session' };
      const payload = { agent: { session }, sessionId: session.id, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'deepseek', model: 'deepseek-chat' }, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue router task' }] }] };
      const frozenInput = freezeDeep(payload.messages);
      await ctx.runPreStep(payload);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].provider, 'deepseek');
      assert.equal(calls[0].model, 'deepseek-chat');
      assert.equal(calls[0].sessionId, 'cold-session');
      assert.equal(calls[0].purpose, 'cairn-worker');
      assert.match(ctx.systemPrompt.renderAll({ agent: { session } }).find(x => x.name === 'cairn:task-continuity').text, /Initial task history/);
      appendTaskTurn(tmpDir, { task_id: 1, turn: 2, role: 'user', content: 'A new turn that must not echo' });
      const after = ctx.systemPrompt.renderAll({ agent: { session } }).find(x => x.name === 'cairn:task-continuity').text;
      assert.match(after, /Initial task history/);
      assert.doesNotMatch(after, /A new turn that must not echo/);
      assert.deepEqual(payload.messages, frozenInput);

      ctx.emit('session/disposed', session);
      await ctx.runPreStep({ ...payload, turn: 2 });
      assert.equal(calls.length, 2, 'disposed session routing binding is discarded');
      const refreshed = ctx.systemPrompt.renderAll({ agent: { session } }).find(x => x.name === 'cairn:task-continuity').text;
      assert.match(refreshed, /A new turn that must not echo/, 'disposed session checkout snapshot is discarded');

      const command = ctx._registry.commands.get('cairn');
      const switched = await command.handler({ rawInput: 'checkout 2' });
      assert.equal(switched.kind, 'success');
      const taskTwo = ctx.systemPrompt.renderAll({ agent: { session } }).find(x => x.name === 'cairn:task-continuity').text;
      assert.match(taskTwo, /SWITCHED_TASK_HISTORY/);
      assert.doesNotMatch(taskTwo, /Initial task history/);

      await host.dispose();
    });
    await withTempWorkspace(async tmpDir => {
      let calls = 0;
      const ctx = createMockDshContext();
      const host = await applyCairnDshHost(ctx, { workspaceRoot: tmpDir, llmClient: { async complete() { calls++; throw new Error('should short circuit'); } } });
      const base = { agent: { session: { id: 'empty' } }, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'deepseek', model: 'm' }, messages: [] };
      await ctx.runPreStep(base);
      assert.equal(calls, 0);
      upsertTask(tmpDir, { id: 1, work_anchor_task_id: 1 });
      await ctx.runPreStep({ ...base, agent: { session: { id: 'anchored' } }, sessionId: 'anchored', turn: 1 });
      assert.equal(calls, 0);
      await host.dispose();
    });
  });

  test('6. ambiguous routing exposes no task history, then retries once with the natural-language clarification', async () => {
    await withTempWorkspace(async tmpDir => {
      upsertTask(tmpDir, { id: 1, title: 'one' });
      upsertTask(tmpDir, { id: 2, title: 'two' });
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'PRIVATE_TASK_ONE' });
      appendTaskTurn(tmpDir, { task_id: 2, turn: 1, role: 'user', content: 'PRIVATE_TASK_TWO' });
      const calls = [];
      const outputs = [
        { decision: 'ambiguous', task_id: null, candidates: [1, 2], reason: 'unclear' },
        { decision: 'match', task_id: 2, candidates: [2], reason: 'clarified' }
      ];
      const ctx = createMockDshContext();
      const host = await applyCairnDshHost(ctx, { workspaceRoot: tmpDir, llmClient: { async complete(input) { calls.push(input.messages[0].content); return { ok: true, content: JSON.stringify(outputs.shift()) }; } } });
      const session = { id: 'ambiguous-session' };
      const signal = new AbortController().signal;
      const payload = prompt => ({ agent: { session }, turn: calls.length + 1, step: 1, signal, modelSelection: { provider: 'deepseek', model: 'deepseek-chat' }, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }] });
      await ctx.runPreStep(payload('Continue the previous work'));
      const firstContext = ctx.systemPrompt.renderAll({ agent: { session } }).find(x => x.name === 'cairn:task-continuity').text;
      assert.doesNotMatch(firstContext, /PRIVATE_TASK_ONE|PRIVATE_TASK_TWO/);
      await ctx.runPreStep(payload('It is the webhook-signature task, task 2'));
      assert.match(calls[1], /Continue the previous work/);
      assert.match(calls[1], /task 2/);
      const nextContext = ctx.systemPrompt.renderAll({ agent: { session } }).find(x => x.name === 'cairn:task-continuity').text;
      assert.match(nextContext, /PRIVATE_TASK_TWO/);
      assert.doesNotMatch(nextContext, /PRIVATE_TASK_ONE/);
      await host.dispose();
    });
  });

  test('7. router errors/timeouts fail open, while caller abort propagates before admitting the main request', async () => {
    await withTempWorkspace(async tmpDir => {
      upsertTask(tmpDir, { id: 1, title: 'Router task' });
      const errorCtx = createMockDshContext();
      let errorCalls = 0;
      const errorHost = await applyCairnDshHost(errorCtx, { workspaceRoot: tmpDir, llmClient: { async complete() { errorCalls++; return { ok: false, error_code: 'offline', error_message: 'offline' }; } } });
      const makePayload = (id, signal) => ({ agent: { session: { id } }, turn: 1, step: 1, signal, modelSelection: { provider: 'deepseek', model: 'deepseek-chat' }, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'resume the router task' }] }] });
      const failOpen = await errorCtx.runPreStep(makePayload('router-error', new AbortController().signal));
      assert.equal(failOpen.kind, 'enter');
      assert.equal(errorCalls, 1);
      await errorCtx.runPreStep(makePayload('router-error', new AbortController().signal));
      assert.equal(errorCalls, 1, 'error is terminal for this session');
      await errorHost.dispose();

      const timeoutCtx = createMockDshContext();
      const timeoutHost = await applyCairnDshHost(timeoutCtx, { workspaceRoot: tmpDir, coldRouterTimeoutMs: 10, llmClient: { async complete({ signal }) { return await new Promise((resolve, reject) => { const timer = setTimeout(() => resolve({ ok: true, content: '{"decision":"new","task_id":null,"candidates":[],"reason":"late"}' }), 100); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true }); }); } } });
      const timed = await timeoutCtx.runPreStep(makePayload('router-timeout', new AbortController().signal));
      assert.equal(timed.kind, 'enter');
      assert.equal(timeoutCtx.systemPrompt.renderAll({ agent: { session: { id: 'router-timeout' } } }).find(x => x.name === 'cairn:task-continuity').text.includes('Task Checkout'), false);
      await timeoutHost.dispose();

      const abortCtx = createMockDshContext();
      const abortHost = await applyCairnDshHost(abortCtx, { workspaceRoot: tmpDir, llmClient: { async complete({ signal }) { return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } } });
      const controller = new AbortController();
      controller.abort(new Error('caller cancelled'));
      let enteredNext = false;
      await assert.rejects(abortCtx.runPreStep(makePayload('router-abort', controller.signal), () => { enteredNext = true; return { kind: 'enter', messages: [] }; }), /caller cancelled/);
      assert.equal(enteredNext, false);
      await abortHost.dispose();
    });
  });

  test('8. Cordis plugin contract (real-dsh regression): apply() must return only a disposer effect, never a handle object', async () => {
    await withTempWorkspace(async tmpDir => {
      const workerCalls = [];
      const ctx = createMockDshContext({
        adapterStream: async function* (request) {
          if (request.purpose === 'cairn-worker') {
            workerCalls.push(request);
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify({
                ops: [
                  {
                    op: 'ASSERT',
                    scope: 'global',
                    key: 'state_authority',
                    option_code: 'local_ledger',
                    summary: 'Use the local ledger as the only state authority'
                  }
                ]
              })
            };
          }
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      });

      // Mirrors @deepseek-ai/cordis Fiber._execute: functions and nullish are valid effects,
      // any other non-thenable/non-iterable object throws `TypeError: Invalid effect`.
      const effect = await cordisApplyCairnDshHost(ctx, { workspaceRoot: tmpDir });
      const isValidCordisEffect =
        effect === null ||
        effect === undefined ||
        typeof effect === 'function';
      assert.equal(isValidCordisEffect, true, 'apply() returned a non-effect value');
      assert.equal(typeof effect, 'function');

      // Everything must be registered before the disposer runs...
      assert.ok(ctx._registry.tools.has('cairn_commit'));
      assert.ok(ctx._registry.commands.has('cairn'));
      assert.ok(ctx._registry.contexts.has('cairn:task-continuity'));
      assert.ok((ctx._registry.listeners.get('llm/stream') ?? []).length === 1);

      const session = { id: 'sess-dispose-flush' };
      ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
      ctx.emit('session/event', session, {
        type: 'user/message',
        data: {
          message: {
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Establish the local ledger as the only global state authority.' }]
          }
        }
      });
      ctx.emit('session/event', session, {
        type: 'assistant/message',
        data: {
          turn: 1,
          message: { content: [{ type: 'text', text: 'Confirmed.\n<|task:1|>' }] }
        }
      });
      ctx.emit('session/event', session, {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } }
      });

      // Cordis awaits Promise-returning disposers, so pending workers must drain first.
      await effect();
      assert.equal(workerCalls.length, 1);
      assert.equal(workerCalls[0].purpose, 'cairn-worker');
      assert.equal(readStaged(tmpDir).proposals[0].ops[0].op, 'ASSERT');

      // The returned disposer unregisters all of the plugin's effects after the drain.
      assert.equal(ctx._registry.tools.size, 0);
      assert.equal(ctx._registry.commands.size, 0);
      assert.equal(ctx._registry.contexts.size, 0);
      assert.equal((ctx._registry.listeners.get('llm/stream') ?? []).length, 0);
    });
  });
});
