# DeepSeek Harness (`dsh`) Host Extension & Hook Interface Reference

This document records **only verified factual capabilities** of the DeepSeek Harness (`dsh`) plugin and hook surface inspected during the ACMI -> Cairn transition, clearly separating **confirmed runtime hooks** from **surface items that require verification on an interactive `dsh` profile**.

> **Hard Red Line**: Never port or resurrect legacy same-generation JSON `ENVELOPE` wrappers (`Phase 0.9.10` / `FM1` nested work-state trees). Cairn uses only lightweight trailing `<|task:N|UNRESOLVED|>` markers in the primary response stream and out-of-band asynchronous operator staging.

---

## 1. Plugin Loading Format & Runtime Baseline

### M4.1 centralized Hub operation

When `workspaceRoot` is omitted, `apply()` selects the centralized Hub adapter; explicit `workspaceRoot` retains the legacy workspace-local adapter for compatibility. `storeRoot` overrides `$DSH_HOME/cairn`, which overrides `~/.cairn`. The Hub adapter resolves `.git` roots from `session.header.cwd` as soft hints only and never writes into the business repository. `resolveGitProjectHint()` is read-only; registration occurs on a task/ledger write.

The first `systemPrompt.context` evaluation in an unbound session contributes only User Ledger and the global active-task catalog. `agent/pre-step` uses the selected `modelSelection`, active task/project cards, and optional cwd hint to route; only after that state is locked does the later context provider add the selected Project Ledger and task checkout. A match can select a project different from the cwd hint. `new` selects the cwd project only when a valid Git hint exists; otherwise the session remains in `general` and project context is omitted. A general session's staging target is User scope only.

User and Project ledger heads, staged proposals, replay integrity, and decision IDs are independent. A Project decision/tombstone takes precedence over a generic User default inside that project; both applicable ledgers override task-local checkout history. CLI `checkout <id> --preview --store <root>` is read-only. Persisting/clearing a CLI checkout requires `--session <id>`; dsh slash checkout is session-local. `inspect` reports a short project fingerprint and routing state only, never absolute paths, prompts, model output, or credentials.

### M4.2 Slice A Hub operation

The example patch opts into Project auto-commit; existing configs remain stage-only unless explicitly enabled. Automatic admission uses actual authored user adoption, not runtime-context messages or the assistant's unilateral recommendation. User-scope proposals always remain staged. Background extraction and auto-compaction use the model route captured for their own turn. A selected general task gets task-local checkout without a Project Ledger.

To preview compensation, use `/cairn undo project <project-id> <commit-seq> --preview <reason>` (or `/cairn undo user <commit-seq> --preview <reason>`). Remove `--preview` to apply. The CLI equivalent is `cairn revert <commit-seq> --scope project --project <project-id> --reason "<reason>" [--preview]`. Both require an explicit scope and commit sequence; use `cairn log --scope project --project <project-id> --json` to find the sequence. Replay/sync and policy behavior are covered offline; these instructions do not claim a new live rc.5 smoke test.

### M4.2 Slice B Hub operation

- `autopilot.enabled` defaults to false. When enabled, `taskHeat.enabled` defaults to true with `hotMaxTasks: 24`, `idleDays: 14`, `dormantMaxCandidates: 5` and one shared `routeTimeoutMs: 2500` budget. The Hub routes only the current authored user input; it neither concatenates older user turns nor uses synthetic reminder text.
- Cold entry supports exact references such as `continue task #42` or `继续任务 #42`. A frozen target needs explicit reopen. The Slice B compatibility path binds dormant matches in `agent/pre-step`; the Slice C runtime mounts them provisionally and persists only after a completed, matching marker. General tasks mount only Task Checkout. Ambiguity, deadline, or router error does not start a dormant lookup.
- `/cairn tasks` displays lifecycle and derived pool under the running host policy; use `--all` to include frozen tasks. A standalone CLI does not read the dsh patch, so `cairn tasks --all --task-heat` applies the default heat policy to the view; mirror custom host settings with `--hot-max-tasks` and `--idle-days`. Without `--task-heat` all active rows are shown as hot. These views are read-only.

### M4.2 Slice C: measured rc.5 turn boundary

- A temporary capture adapter under the installed rc.5 headless profile recorded the exact provider-facing message array. On the switch, the new authored message was at zero-based index 8 (`role: user`, `source.kind: user`), followed by the refreshed snapshot at index 9 (`role: user`, `source.kind: runtime-context`, `source.form: snapshot`). The first answer request already contained the new snapshot. All 7 previously sent messages matched their prior JSON serialization, both with and without the provider's `systemPromptUpdate: 'in-history'` capability. Cairn uses dynamic context rather than a rewritten leading system prompt; byte equality at the adapter boundary is not a cache-hit measurement.
- The probe's intermediate `assistant/message` had a tool-call block at step 1; the final text-only assistant event arrived at step 2 before `turn/end: completed`. Authored and projected user messages are separate sourced append events. With the actual Cairn plugin, a single live rc.5 agent ran A → B → ordinary follow-up: the previously sent message prefix stayed identical on all transitions, the follow-up appended no Cairn context update, marker bytes did not reach displayed text, and each task thread received only its own authored input and final answer. A real worker-adapter-triggered nested `sessions.flush()` returned on all three turns.
- `autopilot.midSessionSwitch.enabled` defaults to true **only** under enabled Autopilot; `crossProject` defaults to false and the route deadline defaults to 2500 ms. A marker for another task is diagnostic only; it cannot change scope. Held checkout is not replaced by a routine follow-up; explicitly ask to continue a task or switch topics. Native prior messages remain in history: this is not a confidentiality or permission boundary.

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
  - The awaited `session/flush` checkpoint drains pending staging and compaction jobs before headless completion. A worker's `ctx.llm.stream()` can itself trigger `session/flush`; an `AsyncLocalStorage` session marker skips only that same-session nested drain to avoid waiting on the queue job that is awaiting the nested model request. `session/disposed` clears session state and remains a best-effort drain fallback.

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

**M2.1 recovery behavior for the three-session smoke-test boundaries:**
- If a reply omits the task marker entirely, Cairn archives it with `meta.attribution: "session_fallback"` only when the session has an explicit workspace anchor/checkout, a cold-router match, or a prior valid task marker. Unbound and ambiguous sessions, and any malformed or unknown-task marker, do not inherit a task by fallback.
- `runStrictCompactor()` retries `empty_compaction_output` once by default (configurable with `maxEmptyRetries`). Abort signals are honored between and during attempts; exhausted retries report attempt count and safe response metadata while leaving `compact.md` and `compacted_record_count` unchanged.

### 2.7 Milestone 3 Runtime Boundaries
- `/cairn close <id>`, `/cairn archive <id>`, and `/cairn reopen <id>` implement active -> done -> archived and done/archived -> active. `tasks` filters active by default and accepts `--all` / `--status`. Close/archive clears a matching disk anchor and live session binding. Non-active tasks permit checkout preview only; manual compact returns `task_not_active` until reopen.
- Automatic compaction uses `autoCompactMinRecords` / `autoCompactMinChars` (defaults 12 / 4500; zero disables one dimension, both zero disable scheduling). `autoCompactEveryTurns` is legacy fallback only when neither new setting is present. Auto and manual compaction share a workspace/task mutex keyed by `(workspaceRoot, taskId)`; active status is rechecked inside the lock before the LLM call. Only auto runs observe cooldown; manual runs bypass cooldown and clear cooldown after success. Missing host LLM/model selection skips auto compaction silently. Jobs drain at the awaited dsh `session/flush` checkpoint; the `AsyncLocalStorage` same-session reentrancy guard skips worker-initiated nested flushes, and `session/disposed` is a best-effort cleanup fallback. Cached checkout snapshots are not refreshed after compaction.
- Invalid/non-active `work_anchor_task_id` is ignored by prompt context and pre-step routing, so it neither injects local history nor bypasses cold routing. `doctor` reports it. `cairn doctor` and `/cairn doctor` are read-only and make no LLM calls; `/cairn inspect` exposes only task id/binding source, route decision/task id/duration/error code, and compaction status metadata. It never returns user prompts, task transcript/compact body, model output, or credentials.
- `src/workers/doctor.mjs` measures the full distillable uncompressed tail with truncation limits lifted, then classifies risk relative to `maxTailChars`. It remains in the workers layer; the kernel does not import workers.
- Cairn archives only user-authored `user/message` content. dsh-sourced `runtime-context`, `compact-checkpoint`, and `agent-instructions` events are excluded by source; when dsh appends a trailing `<system-reminder>` block directly to user text, that synthetic block is stripped before task archival and staging so prompt snapshots do not echo into local history or inflate doctor watermarks.

## 3. Verified Surface Items (Confirmed in `dsh 0.2.2-rc.5` Package Source)

The integration details below were confirmed against the installed `@deepseek-ai/dsh-*` `0.2.2-rc.5` packages (`dsh-llm`, `dsh-agent`, `dsh-agent-loop`, `dsh-system-prompt`, `dsh-commands`, `dsh-compaction-basic`, `dsh-tools`):

| Surface Item | Verified `dsh 0.2.2-rc.5` Source Fact | Cairn Implementation in `src/hosts/dsh/` |
| --- | --- | --- |
| **1. `llm/stream` Chunks & `session/event` Propagation** | **CONFIRMED**: `ReactLoopAgent.step` (`@deepseek-ai/dsh-agent-loop`) feeds every `StreamChunk` (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`) yielded by `llm/stream` simultaneously into `agent/assistant-stream`, `AssistantStreamAccumulator`, and `BlockAssembler` (`assistant/message`). Modifying chunks in `llm/stream` directly alters the committed `assistant/message`. | `src/hosts/dsh/index.mjs` maintains a 64-character trailing window per text block `index`, stashes the unstripped `rawText` and parsed `<\|task:N\|>` into `accumulator.stashStreamMarker(sessionId, ...)` **before** yielding stripped `text-delta` and shallow-cloned `block-end` chunks, and bypasses `request.purpose === 'cairn-worker'` to prevent reentrancy. |
| **2. Interactive `/slash` Commands & Tools** | **CONFIRMED**: `@deepseek-ai/dsh-commands` exposes `ctx.commands.register({ name, description, input: { hint }, handler })` returning `{ kind: 'success' \| 'error', text }` in Web/TUI profiles, while `@deepseek-ai/dsh-tools` requires `output: { schema, render }` on `ctx.tools.register(...)`. | Registers `cairn_status`, `cairn_tasks`, `cairn_commit`, and `cairn_drop` (with explicit human-authority red lines) on `ctx.tools.register`, conditionally registers `/cairn` on `ctx.commands` when mounted, and provides the standalone `bin/cairn.mjs` CLI. |
| **3. Native Compaction (`request.purpose === 'compaction'`)** | **CONFIRMED**: `summarizeWithLlm` in `@deepseek-ai/dsh-compaction-basic` constructs `request.messages` with `deepFreeze`-d `Message` objects (`[system, ...regionMessages, finalUserInstructionMessage]`) and calls `ctx.llm.stream(options)` directly without `prepareCall`. Mutating a frozen message in-place throws `TypeError`, while replacing `request.messages` with a shallow-cloned array and a cloned final `user` message is completely safe and preserves prefix KV-cache reuse. | `injectStrictBoundaryIntoCompactionMessages()` clones `request.messages` and appends `buildStrictCompactorPrompt()` + `buildGlobalExclusionWatchlistSection(head)` to the final `user` compaction directive message without mutating frozen objects. |
