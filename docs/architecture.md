# Cairn Architecture: Git for Agent Work States

Cairn is a lightweight, local-first work-state and task-continuity engine for AI coding agents. Its design is derived directly from the **five closed-loop primitives** validated across **484 controlled single-factor ablation calls** in ACMI Path 1 ([`docs/reference/acmi-path1-synthesis.md`](reference/acmi-path1-synthesis.md)).

---

## 1. Core Positioning: Git for Agent Work States

Traditional agent sessions conflate **conversation transcripts** with **work tasks** and **workspace state**:
- Asking an LLM to maintain a nested JSON work-state tree in the same generation as its user answer causes **decision reversals** (`FM1`: 4/6 cases where prose chose one option while JSON state recorded the opposite) and **ID drift**.
- Compressing a task transcript without separating workspace-global rules from task-local history causes **100% stale-rule resurrection** (`TH1-B`: 8/8 in `compact_P0_C0`).

Cairn solves this by modeling agent memory after Git's staging and commit lifecycle:

| Git Concept | Cairn Equivalent | Mechanism Primitive |
| --- | --- | --- |
| **Branch / Worktree** | Task Identity (`<\|task:N\|>` / `<\|task:UNRESOLVED\|>`) | **Primitive 1**: Minimal inline tail marker + `SYSTEM_C1` Anti-Recency Contract + 1-line read-only task catalog |
| **`git add` (Working Diff -> Index)** | Asynchronous Operator Staging (`.cairn/staged.json`) | **Primitive 2**: Out-of-band `buildStagingExtractorPrompt(head)` -> `ASSERT` / `SUPERSEDE` / `OPEN_QUESTION` / `RESOLVE_QUESTION` / `NO_OP` |
| **`git commit` (Index -> `HEAD`)** | Host Deterministic Folding (`.cairn/head.json` & `ledger.jsonl`) | **Primitive 3**: Pure-function `foldLedger` allocating `D1../Q1..`, preserving `active`, `tombstones` (with falsification `reason`), and `open_questions` |
| **Branch Squash (`compact.md`)** | Task-Local Compaction (`.cairn/tasks/<id>/compact.md`) | **Primitive 4**: `buildStrictCompactorPrompt()` (`COMPRESSOR_STRICT` prohibiting global rules in task notes) |
| **`git checkout` (Handoff to Worker)** | Authoritative Ledger Checkout (`RECEIVER_C1`) | **Primitive 5**: `buildAuthorityCheckoutContract(head)` enforcing `active` override and `tombstones` anti-regression |

---

## 2. The `.cairn/` On-Disk Model

### M4.1 centralized Hub mode

The dsh host uses the hidden centralized Hub when `workspaceRoot` is omitted. Storage is resolved as explicit `storeRoot` > `$DSH_HOME/cairn` > `~/.cairn`; business repositories never receive a `.cairn/` directory. The Hub layout is `user/ledger/`, `projects/index.json`, `projects/<project_id>/ledger/`, global `tasks/index.json`, `tasks/<id>/`, and hashed per-session bindings under `sessions/`. The CLI defaults to the same Hub; `--store <path>` overrides it, while explicit `--cwd <dir>` remains the compatibility path for workspace-local M1-M3 stores.

Project hints are found by read-only upward `.git` traversal. The deterministic project identity is registered only by the first actual task or ledger write. A cold Turn 1 context contains only the stable User Ledger and global active task catalog; after `agent/pre-step` locks a project, the same turn's later context evaluation may include that project's ledger and selected task checkout. Project-specific decisions override generic User defaults within their project; both authoritative ledgers and their tombstones override task-local history.

User- and project-scoped ledgers have independent revision/ID sequences and staged queues. A `general` session stages only to User scope and uses the strict cross-project preference extraction boundary. CLI checkout preview is read-only; persisting a binding requires `--session <id>`. Session bindings are never global anchors.

Every workspace managed by Cairn stores its state in a human-inspectable, plain-text `.cairn/` directory:

```text
.cairn/
├── head.json                   # Materialized read-only Workspace State Ledger snapshot (revision, active, tombstones, open_questions)
├── ledger.jsonl                # Append-only audit log of accepted foldLedger commits (with actor_id, source_step, base_revision)
├── staged.json                 # Pending candidate delta proposals (next_proposal_seq, proposals: [{ proposal_id: "stg_<n>", base_revision, ops }])
└── tasks/
    ├── index.json              # Deterministic Task Catalog (id in 1..999, title, birth_turn, status) -> compiles 1-line-per-task header
    ├── 1/                      # Numeric task directory matching <|task:N|> from parseTaskMarker
    │   ├── thread.jsonl        # Task 1 scoped turns & causal tool call/result records
    │   └── compact.md          # Task 1 local-only compaction summary (strictly free of workspace-global rules)
    └── 2/
        ├── thread.jsonl
        └── compact.md
```

### Invariants of `.cairn/`
1. **Host-Exclusive IDs**: Models never invent `D1` or `Q1` handles. Only `foldLedger()` in `src/kernel/ledger.mjs` allocates `D<n>` and `Q<n>` upon commit.
2. **Tombstone Provenance**: When an active decision `D1` is superseded by `D2`, `D1` is never deleted; it moves to `tombstones` with `superseded_by: "D2"` and the objective falsification `reason`.
3. **Optimistic Concurrency (`actor_id` + `base_revision`)**: Every fold accepts an optional `actor_id` (default `"default"`) and `base_revision`. If `base_revision !== currentLedger.revision`, `foldLedger` rejects the commit with `conflict: true` rather than silently overwriting a concurrent worker's state.
4. **Crash-Safe Commit Write Ordering**: `commitStaged()` in `src/kernel/store.mjs` persists each accepted proposal strictly in order: (1) append commit record to `ledger.jsonl`, (2) atomically overwrite `head.json`, (3) atomically update `staged.json` (preserving monotonic `next_proposal_seq`).

---

## 3. Three-Layer Decoupling Principle (`kernel` -> `workers` -> `hosts`)

```text
cairn/
├── bin/
│   └── cairn.mjs               # Minimal zero-dependency CLI (tasks / close / archive / reopen / compact / doctor)
└── src/
    ├── kernel/                 # Layer 1: Pure deterministic, zero-LLM, zero-host-dependency core
    │   ├── ledger.mjs          #   createEmptyLedger, foldLedger, projectReadOnlyLedger
    │   ├── marker.mjs          #   parseTaskMarker (closed-fence fix), stripTaskMarker, buildLightTaskCatalog
    │   ├── contracts.mjs       #   4 empirically validated prompt contract builders
    │   ├── store.mjs           #   .cairn/ persistence, replayLedger verification, batch optimistic concurrency
    │   └── index.mjs           #   Unified kernel barrel export
    ├── workers/                # Layer 2: Low-frequency asynchronous LLM workers
    │   ├── task-compaction-coordinator.mjs # shared per-workspace/task lock, cooldown, drain
    │   ├── doctor.mjs           # read-only integrity, catalog, anchor, and tail-watermark diagnostics
    │   └── index.mjs           # staging-extractor, strict-compactor, cold-router, compactor, doctor
    └── hosts/                  # Layer 3: Thin runtime host adapters
        └── dsh/                #   Reference Host #1: DeepSeek Harness (dsh 0.2.2-rc.5)
            └── index.mjs
```

- **Layer 1 (`src/kernel/`)** has **zero network calls, zero file I/O, zero LLM calls, and zero host runtime imports**. It can be unit-tested in milliseconds via `node --test`.
- **Layer 2 (`src/workers/`)** wraps the prompt contracts from `src/kernel/contracts.mjs` around an OpenAI-compatible completion client and `.cairn/` disk persistence. It runs out-of-band so primary user responses incur zero latency penalty.
- **Layer 3 (`src/hosts/<host>/`)** bridges a specific agent host (starting with `dsh`, see [`docs/dsh-host-interface.md`](dsh-host-interface.md)) to Cairn's workers and kernel. Supporting additional runtimes (e.g., Claude Code, Codex, custom CLI harnesses) only adds a sibling folder under `src/hosts/`.

---

## 4. Phased Delivery Roadmap

### Phase 1: Single-Agent `dsh` End-to-End Loop (Current Priority)
1. **Task Continuity & Display Hygiene**: Inject `buildAntiRecencyContract` into `dsh` via `ctx.systemPrompt.context`, parse `<|task:N|UNRESOLVED|>` on committed assistant turns via `parseTaskMarker`, route turns to `.cairn/tasks/<id>/thread.jsonl`, and strip the trailing marker from display via `stripTaskMarker`.
2. **Asynchronous Stage & Commit Loop**: Trigger the background Staging Extractor after committed turns to write candidate operators into `.cairn/staged.json`, fold accepted operators via `foldLedger` into `.cairn/head.json` and `.cairn/ledger.jsonl`.
3. **Tombstone Anti-Regression & Strict Compaction**: Inject `buildAuthorityCheckoutContract(head)` on session handoff and enforce `buildStrictCompactorPrompt()` on task compaction so superseded decisions never resurrect.

### Milestone 2: Cross-Session Task Checkout
- `compileTaskCheckout()` deterministically combines task-local `compact.md` and records after `compacted_record_count`; bounded distillation retains the newest tail and never promotes task-local prose above global Ledger/Tombstone authority.
- The dsh adapter binds a cold-routed task at `agent/pre-step`. Its stable checkout snapshot is cached per `(sessionId, taskId)` and injected by the synchronous dynamic-context provider refreshed after pre-step. Empty catalogs short-circuit to `new`; ambiguous routing gets one natural-language clarification retry without task-history disclosure.
- `/cairn checkout <id|--clear> [--preview]` changes an explicit workspace anchor; `/cairn compact [id] [--full]` is a user-directed task-local compaction. Both host tools retain explicit human-authorization red lines.
- The host contract targets `dsh 0.2.2-rc.5`; kernel, workers, and host remain separate layers.

### Milestone 3: Long-Horizon Autonomy and Anti-Entropy
- Tasks have `status: "active" | "done" | "archived"`; legacy records without status read as `active`. `close` marks done, `archive` marks done tasks archived, and `reopen` restores active status. The light catalog and cold router include active tasks only. Closing or archiving clears a matching workspace anchor and live session bindings. Non-active tasks are read-only until reopened; checkout preview remains available.
- Automatic compaction is a low-priority, out-of-band worker gated by uncompressed-tail watermarks. `autoCompactMinRecords` and `autoCompactMinChars` are independent OR dimensions (zero disables a dimension); if both are zero, auto-compaction is disabled. The legacy `autoCompactEveryTurns` is consulted only when neither new threshold is configured. A per-`(workspaceRoot, taskId)` coordinator lock serializes automatic and manual compaction; manual runs bypass cooldown, while automatic failures cool down. The worker rechecks active status after acquiring the lock and before LLM execution. dsh headless drains pending workers at the awaited `session/flush` checkpoint; worker-originated nested flushes for the same session are skipped via `AsyncLocalStorage` to prevent queue self-deadlock. `session/disposed` performs best-effort fallback cleanup, and successful compaction does not refresh a session's checkout snapshot.
- `cairn doctor` and `/cairn doctor` are read-only and make no LLM calls. They check ledger replay, task index/disk consistency, anchor validity, compaction cursors, orphan directories, and uncompressed tail size/risk relative to `maxTailChars`. `/cairn inspect` exposes only redacted binding/route/compaction metadata (no user prompts, transcript or compact text, model output, or credentials).
- `doctor.mjs` and the compaction coordinator live under `src/workers/`; the deterministic kernel has no dependency on workers or the host.

### Phase 2: Single-Window Multi-Agent Orchestration (Next)
- Once the single-agent `dsh` loop is rock-solid, leverage `actor_id` and `base_revision` optimistic concurrency in `foldLedger` so multiple subagents or parallel workers in a single workspace can check out `.cairn/head.json`, propose staged state operators, and deterministically detect/resolve state conflicts.
