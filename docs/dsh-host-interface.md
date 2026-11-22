# DeepSeek Harness (`dsh`) Host Extension & Hook Interface Reference

This document records **only verified factual capabilities** of the DeepSeek Harness (`dsh`) plugin and hook surface inspected during the ACMI -> Cairn transition, clearly separating **confirmed runtime hooks** from **surface items that require verification on an interactive `dsh` profile**.

> **Hard Red Line**: Never port or resurrect legacy same-generation JSON `ENVELOPE` wrappers (`Phase 0.9.10` / `FM1` nested work-state trees). Cairn uses only lightweight trailing `<|task:N|UNRESOLVED|>` markers in the primary response stream and out-of-band asynchronous operator staging.

---

## 1. Plugin Loading Format & Runtime Baseline

| Dimension | Verified Fact |
| --- | --- |
| **Target `dsh` Baseline** | `@deepseek-ai/dsh` `0.2.2-rc.1` (upstream baseline `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`) |
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

## 2. Confirmed Lifecycle Hooks & Host Services (Verified in `dsh 0.2.2-rc.1`)

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
- **API**: `ctx.tools.register(defineTool({ name, description, parameters, execute(args, runCtx) }))` (`@deepseek-ai/dsh-tools`)
- **Behavior**: Registers callable tools in the host tool registry.

---

## 3. Surface Items Requiring Verification on Interactive `dsh` Profiles

The following three integration details were not exercised by the headless `dsh-quickstart` harness and **must be verified against the live `dsh` TUI/Web profile during Phase 1 host adapter implementation**:

| Item to Verify | Question for Live `dsh` Verification | Fallback if Native Hook Is Absent |
| --- | --- | --- |
| **1. UI Display Stripping of `<\|task:N\|>`** | Does `dsh` TUI/Web expose a presentation-only message formatter hook, or does modifying yielded text chunks in `ctx.on('llm/stream')` cleanly strip `<\|task:N\|>` via `stripTaskMarker()` before terminal rendering? | Strip the trailing `<\|task:N\|>` token in the `llm/stream` generator wrapper while recording the extracted marker in `.cairn/tasks/` metadata. |
| **2. Interactive `/slash` Commands** | Does the target `dsh` profile expose a public Cordis service for user slash commands (e.g., `/cairn stage`, `/cairn commit`, `/cairn ledger`, `/cairn tasks`)? | Expose a lightweight `cairn` CLI command (`npx cairn status / commit / tasks`) reading `.cairn/` directly alongside registered `cairn_*` host tools. |
| **3. Native Compaction Prompt Override** | When `ctx.on('llm/stream')` intercepts `request.purpose === 'compaction'`, does mutating `request.messages` in-place work cleanly with `dsh`'s compaction consumer? | Run Cairn's own `strict-compactor` worker out-of-band into `.cairn/tasks/<id>/compact.md` and inject it via `ctx.systemPrompt.context`. |
