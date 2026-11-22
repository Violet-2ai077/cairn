# DeepSeek Harness (`dsh`) Host Extension & Hook Interface Reference

This document records **only verified factual capabilities** of the DeepSeek Harness (`dsh`) plugin and hook surface inspected during the ACMI -> Cairn transition, clearly separating **confirmed runtime hooks** from **surface items that require verification on an interactive `dsh` profile**.

> **Hard Red Line**: Never port or resurrect legacy same-generation JSON `ENVELOPE` wrappers (`Phase 0.9.10` / `FM1` nested work-state trees). Cairn uses only lightweight trailing `<|task:N|UNRESOLVED|>` markers in the primary response stream and out-of-band asynchronous operator staging.

---

## 1. Plugin Loading Format & Runtime Baseline

| Dimension | Verified Fact |
| --- | --- |
| **Target `dsh` Baseline** | `@deepseek-ai/dsh` `0.2.2-rc.5` |
| **Plugin Framework** | `@deepseek-ai/cordis` `4.1.0` (dependency injection & lifecycle container) |
| **Node.js Engine** | Node.js `>=24.16.0 <25` (for stock `dsh` binary / packages); Cairn `src/kernel/` runs on Node `>=22.0.0` |
| **Module Format** | Standard ES Module (`.mjs` or compiled `.js` from `.ts`), loadable via `file:///absolute/path/to/index.mjs` |
| **Native Session Journal** | `SESSION_FORMAT_VERSION === 4` (append-only JSONL or checksummed Zstandard `.zst` segments) |

### Standard Cordis Plugin Entry Signature

A `dsh` plugin module exports `name`, `inject` (required host services), `Config` (`@deepseek-ai/schemastery`), and `apply(ctx, config)`:

```js
export const name = 'cairn-dsh-host';

export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'sessionProjections',
  'systemPrompt',
  'llm',
  'tools'
];

export async function apply(ctx, config) {
  // Register hooks, systemPrompt providers, and tools;
  // register disposal callbacks via ctx.effect(() => dispose, 'description')
}
```

### Attaching via CLI / Profile Patch (`cordis.patch.yml`)

`dsh` loads external plugins without modifying `dsh` core source via `--patch`:

```yaml
- insert:
    - id: cairn
      name: 'file:///absolute/path/to/cairn/src/hosts/dsh/index.mjs'
      config:
        workspaceRoot: '/absolute/path/to/workspace'
```

Verify configuration resolution via:
```sh
dsh --profile web --patch /absolute/path/to/cairn.patch.yml --dump-config
```

---

## 2. Confirmed Lifecycle Hooks & Host Services (Verified in `dsh 0.2.2-rc.5`)

### 2.1 Dynamic System Prompt & Context Injection (Pre-Request) — **CONFIRMED**
- **API**: `ctx.systemPrompt.context({ name, order, interpolate: false, text({ agent, signal }) })` (from `@deepseek-ai/dsh-system-prompt`)
- **Behavior**: Invoked synchronously/fast-path before each outbound agent request to assemble system prompt segments. Returns a `release()` disposer.
- **Cairn Usage**:
  - Inject `buildAntiRecencyContract({ tasks, workAnchorTaskId })` (Primitive 1);
  - Inject `buildAuthorityCheckoutContract(readOnlyLedgerHead)` (Primitive 5) so the active agent always sees `workspace_ledger.active`, `tombstones`, and `open_questions`.

### 2.2 Outbound LLM Stream & Compaction Middleware — **CONFIRMED**
- **API**: `ctx.on('llm/stream', async function* (request, next) { ... }, { prepend: true, global: true })` (from `@deepseek-ai/dsh-llm`)
- **Behavior**: Intercepts every outbound LLM completion stream before it reaches the provider adapter.
  - `request.sessionId`: ID of the originating `dsh` Session;
  - `request.messages`: wire message array;
  - `request.purpose`: identifies the request purpose — specifically `request.purpose === 'compaction'` when `dsh` triggers context compaction!
- **Cairn Usage**:
  - Observe or intercept `request.purpose === 'compaction'` to enforce `buildStrictCompactorPrompt()` (Primitive 4: hard global/local boundary so global rules are never baked into task-local compaction summaries).

### 2.3 Committed Session Event Feed (Messages, Turns, Steps, Tools) — **CONFIRMED**
- **API**:
  - `ctx.on('session/event', (session, event) => { ... }, { global: true })`
  - `ctx.on('session/disposed', (session) => { ... }, { global: true })`
- **Verified `event.type` Values on Committed `SessionEvent` (`event.seq`)**:
  - `'user/message'` (`event.surfaceOp === 'append'`, `event.data.source.kind === 'user'`): User prompt committed.
  - `'assistant/message'` (`event.surfaceOp === 'append'`, `event.data.turn`, `event.data.step`): Assistant completion committed.
  - `'turn/start'` and `'turn/end'` (`event.data.turn`, `event.data.reason.kind === 'completed' | ...`): Full turn lifecycle boundaries.
  - `'step/start'` and `'step/end'` (`event.data.turn`, `event.data.step`): Individual agent-loop step boundaries.
  - `'tool/call'` (`event.data.callId`, `event.data.turn`, `event.data.step`) and `'tool/result'` (`event.data.message.toolCallId`, `event.sourceEventSeqs` causal link to the originating `tool/call` sequence number).
- **Cairn Usage**:
  - On `'assistant/message'` / `'turn/end'`: run `parseTaskMarker(assistantText)` from `src/kernel/marker.mjs` to append the turn to `.cairn/tasks/<id>/thread.jsonl` (or mark unresolved clarification), and trigger the out-of-band **Asynchronous Staging Worker** (`buildStagingExtractorPrompt(head)`) without blocking the user turn.

### 2.4 Custom Plugin Journal Records & Session Projections — **CONFIRMED**
- **API**:
  - `appendPluginRecord(session, 'plugin:cairn/<record-type>', data)` (`@deepseek-ai/dsh-session`)
  - `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })` (`@deepseek-ai/dsh-session-projection`)
  - `await ctx.sessions.flush(session)`
- **Behavior**: Persists custom typed metadata records inside the native `dsh` v4 session journal and folds them deterministically on session load.

### 2.5 Tool Registry — **CONFIRMED**
- **API**: `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute(args, runCtx) }))` (`@deepseek-ai/dsh-tools`)
- **Behavior**: Registers callable tools in the host tool registry. Note that `@deepseek-ai/dsh-tools` strictly requires `output: { schema, render(args, value) }` on every registered tool definition.

---

### 2.6 Milestone 2: Pre-Step Routing and Dynamic Checkout Context — **CONFIRMED (`0.2.2-rc.5`)**
- `agent/pre-step` payload contains `{ agent, messages, turn, step, signal, modelSelection }`; `modelSelection` is the captured step selection. `PreStepDecision` is `{ kind: 'reject' }` or `{ kind: 'enter', messages, startsRequestSeries? }`. Treat `messages` as an immutable identified batch and return a shallow-cloned decision if replacing its array.
- The host uses the pre-step waterfall to bind a cold-routed task, then relies on `ctx.systemPrompt.context({ order, text })` being synchronously re-evaluated by `refreshContext()` after pre-step. This avoids mutating frozen histories and keeps task checkout snapshots stable. Runtime context is a sourced user-message snapshot; system sections remain ordered prompt-prefix content.
- Context providers are synchronous and ordered ascending by finite `order`, then name. Identical rendered prefixes preserve reuse; route capability `systemPromptUpdate: 'in-history'` appends a changed prompt in history rather than rewriting the cached prefix. Dynamic task history is deliberately isolated in runtime context rather than static system sections.
- `session/disposed` is the cleanup hook for session-scoped routing/cache state. `ctx.commands.register()` and `ctx.tools.register()` retain the confirmed command/tool shape described below. Worker calls go through `ctx.llm.stream()` using the selected provider/model and `purpose: 'cairn-worker'`; the guard prevents re-entry.
- The loaded profile resolves `dsh-agent`, `dsh-agent-loop`, `dsh-system-prompt`, `dsh-commands`, and `dsh-tools` from the same global `0.2.2-rc.5` package tree. Use a clean temporary profile for smoke tests to avoid old custom bundle dependencies.

**Version comparison:** the previously checked `0.2.2-rc.1` and installed `0.2.2-rc.5` share the same pre-step decision union and model-selection-bearing waterfall contract; rc.5 adds no breaking field or lifecycle change for Cairn. The behavior is different from `0.2.1-rc.2`, which lacks `modelSelection` in pre-step and is therefore unsuitable for deterministic zero-config routing. Cairn's rc.5 adapter uses the same post-pre-step context refresh seam and does not depend on internal agent-loop imports.

**Known limitations observed in the three-session smoke test:**
- A model may occasionally omit the trailing task marker; that assistant turn is consequently not archived to a task thread. Marker enforcement/recovery is deferred to a follow-up slice.
- The first manual compaction attempt returned `empty_compaction_output`; retrying succeeded without advancing the cursor or writing a partial compact file on the failed attempt.

## 3. Verified Surface Items (Confirmed in `dsh 0.2.2-rc.5` Package Source)

The integration details below were confirmed against the installed `@deepseek-ai/dsh-*` `0.2.2-rc.5` packages (`dsh-llm`, `dsh-agent`, `dsh-agent-loop`, `dsh-system-prompt`, `dsh-commands`, `dsh-compaction-basic`, `dsh-tools`):

| Surface Item | Verified `dsh 0.2.2-rc.5` Source Fact | Cairn Implementation in `src/hosts/dsh/` |
| --- | --- | --- |
| **1. `llm/stream` Chunks & `session/event` Propagation** | **CONFIRMED**: `ReactLoopAgent.step` (`@deepseek-ai/dsh-agent-loop`) feeds every `StreamChunk` (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`) yielded by `llm/stream` simultaneously into `agent/assistant-stream`, `AssistantStreamAccumulator`, and `BlockAssembler` (`assistant/message`). Modifying chunks in `llm/stream` directly alters the committed `assistant/message`. | `src/hosts/dsh/index.mjs` maintains a 64-character trailing window per text block `index`, stashes the unstripped `rawText` and parsed `<\|task:N\|>` into `accumulator.stashStreamMarker(sessionId, ...)` **before** yielding stripped `text-delta` and shallow-cloned `block-end` chunks, and bypasses `request.purpose === 'cairn-worker'` to prevent reentrancy. |
| **2. Interactive `/slash` Commands & Tools** | **CONFIRMED**: `@deepseek-ai/dsh-commands` exposes `ctx.commands.register({ name, description, input: { hint }, handler })` returning `{ kind: 'success' \| 'error', text }` in Web/TUI profiles, while `@deepseek-ai/dsh-tools` requires `output: { schema, render }` on `ctx.tools.register(...)`. | Registers `cairn_status`, `cairn_tasks`, `cairn_commit`, and `cairn_drop` (with explicit human-authority red lines) on `ctx.tools.register`, conditionally registers `/cairn` on `ctx.commands` when mounted, and provides the standalone `bin/cairn.mjs` CLI. |
| **3. Native Compaction (`request.purpose === 'compaction'`)** | **CONFIRMED**: `summarizeWithLlm` in `@deepseek-ai/dsh-compaction-basic` constructs `request.messages` with `deepFreeze`-d `Message` objects (`[system, ...regionMessages, finalUserInstructionMessage]`) and calls `ctx.llm.stream(options)` directly without `prepareCall`. Mutating a frozen message in-place throws `TypeError`, while replacing `request.messages` with a shallow-cloned array and a cloned final `user` message is completely safe and preserves prefix KV-cache reuse. | `injectStrictBoundaryIntoCompactionMessages()` clones `request.messages` and appends `buildStrictCompactorPrompt()` + `buildGlobalExclusionWatchlistSection(head)` to the final `user` compaction directive message without mutating frozen objects. |
