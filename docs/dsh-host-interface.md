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

#### Continuity fixes and recovery

- With Hub Autopilot mid-session switching enabled, natural return requests such as “回到昨天的 CSV 导出问题” and “Back to the CSV export issue” re-enter routing. A return with no matching task asks for clarification rather than creating one. Routine follow-ups still keep the current task; explicit IDs and cross-project restrictions are unchanged.
- `/cairn turns` shows the last 20 turn receipts for **this dsh session**; `/cairn turns <turn>` reads a specific receipt, including after resume. An admitted turn without a terminal event remains `in_progress`. Terminal states include `archived`, `interrupted`, and `unassigned`; per-scope extraction distinguishes `pending`, `no_ops`, `staged`, commit outcomes, and failures. These local receipts hold journal references and metadata, not prompt/output bodies. Confirmed task history separately includes up to eight bounded tool-result excerpts, preferring failures.
- On a previously bound active task, a native appended `tool/result` is also visible to another process **before** turn/end via `cairn checkout <id> --preview`. Provisional switches, new-task tickets and changed binding epochs never publish speculative evidence to a task. A crash can leave an `in_progress` receipt; that is not a liveness signal. A mismatched final marker can leave an `unassigned` observation of the earlier bound tool result; it does not assign the answer. Inspect the last result and verify actual external state before deciding whether to retry.
- In the original (or resumed) session, a human can issue `/cairn recover <turn> <task-id>` for a **completed, markerless** turn. It re-reads the native journal, verifies the authored input and final answer against the receipt digest, and appends historical records only to an active task in the same project scope. It does not rebind the session, run extraction, or change either ledger. Interrupted, ambiguous, and conflicting-marker turns cannot be claimed this way.
- With mid-session switching enabled, recognized preferences use the item-specific review described below. The compatibility path can separately stage an explicitly cross-project clause in the User ledger. Neither path automatically commits User defaults.
- Both task compactors now process contiguous bounded batches, including splits of oversized records. The old summary and cursor are left untouched until **all** batches succeed. To regenerate a summary produced by an older version, use `/cairn compact <id> --full` on an active task; there is no automatic rewrite of historical summaries.
- Hub native dsh compaction adds the exclusion directive even when marker stripping or Autopilot is off. rc.5 closes over the original mutable auxiliary request options in its terminal waterfall callback: replace its messages array, not the frozen journal messages or the main model request.

**Repeatable host check:** `node scripts/smoke-dsh.mjs /absolute/path/to/dsh/lib/bin.js` runs the installed headless dsh in an isolated temporary home and Git repository. The provider is a deterministic local fixture, not a network model. The check runs a failing Node test in task A, supersedes a Project rule in B, manually recovers a markerless turn, runs native compaction, then resumes the persisted session in a fresh process without a task ID. It checks the provider-facing checkout for the actual failure evidence and the current decision/tombstone. This validates host wiring, not semantic accuracy on unseen prompts.

#### Choosing which task to resume

With Hub Autopilot and mid-session switching enabled (as in the example patch), a bound session keeps its task for a plain “继续”. In an unbound session, the same request asks even if only one task is active. An ambiguous route also asks; an empty candidate pool does not create a task. A clear reference such as `继续任务 #9` does not need a menu.

- Cairn builds choices from eligible active tasks, not from model-generated labels. Each shows a stable task ID, title, project and, when available, the last tool name and outcome. Candidate transcripts and tool output are not quoted. The “更多任务” option pages five tasks at a time; “都不是” expands a narrowed list within the same permitted scope.
- When a dsh client answers `ctx.userQuestions.ask`, its choice resumes the original request in the same turn. Without an answerer, Cairn returns a text menu without calling the primary model or any business tool. Reply in the same session with the displayed position, an explicit ID (`#9`), or a unique title fragment (“CSV 那个”). A duplicate title asks again. “取消” discards the request without binding a task.
- While the menu is outstanding, the local Hub holds the original text and candidate IDs under `sessions/choices/`, keyed by session. This lets the text path resume after process restart with the same dsh session ID. A choice does not grant new authority: the checkout restores the task context, and only the original request and later authored instructions are filed with the final answer, never the menu reply. Selection alone neither commits a ledger change nor binds a task; the completed answer must still pass the task-marker check.

The headless smoke check also exercises the real dsh question service with a scripted answerer, then repeats the scenario without an answerer across a process restart. In both cases the provider must receive the original verification request and the selected task's failure evidence before it runs the test tool. This is not a manual Web/TUI rendering check.

#### Confirming a preference

In the example Hub configuration the business model handles the original request first. On a terminal answer with the expected task marker the host can append a separate memory notice. The notice is not archived as part of the business answer and is **not** a saved-rule receipt. Only a successfully archived turn can generate a review. No review blocks ordinary follow-ups.

| Authored instruction | Long-term behavior |
| --- | --- |
| 这次用英文。 | No review or ledger proposal for this instruction. |
| 以后默认用中文。 | In a locked project, offer project-only or all projects. If this is the sole item, the next reply may be just “仅本项目” or “所有项目”. In a general session there is no project option. |
| 所有项目默认中文，但这个项目用英文。 | Offer two numbered items with fixed scopes. Approve either, both, or neither. |

Send `查看记忆` (or `/cairn memory`) to see outstanding session items, including the authored clause and proposed key/value. For item `4.1`, send `记忆 4.1 所有项目`, `记忆 4.1 仅本项目` or `记忆 4.1 跳过`. The slash equivalents are `/cairn memory 4.1 user|project|skip`; omit the last argument to read that item's status, including a failed extraction. The ID belongs to the **original dsh session**, including after restart. Ordinary “确认” is not consent. An item targeting a project cannot be approved from a different project binding.

Only the isolated authored clause goes to the out-of-band preference worker. It may propose one new ASSERT; it cannot select a scope, replace an existing preference, or commit. Reviews with an explicit scope use protected staging; unresolved reviews enter neither ledger until a person chooses. Bulk commit/drop and Project auto-commit do not act on reviews. A changed ledger revision or an existing active key will not be silently overwritten. A failure or skipped item leaves the business answer intact. Scope recognition is conservative, not a general natural-language classifier. The optional headless smoke uses a scripted provider and checks the actual User and Project snapshots supplied on subsequent checkouts.

#### Original rc.5 turn-boundary measurements

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
