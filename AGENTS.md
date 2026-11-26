# AGENTS.md — Cairn Engineering Constitution

Read this file first at the start of every coding session in this repository.

## 1. Mission & Lineage

**Cairn** (*Git for Agent Work States*) is the practical engineering implementation (Path 2) of the **five closed-loop mechanism primitives** validated across 484 controlled single-factor ablation calls in the ACMI research program ([`docs/reference/acmi-path1-synthesis.md`](docs/reference/acmi-path1-synthesis.md)).

Our goal is to deliver a **fast, lightweight, local-first (`.cairn/`) task-continuity and workspace-state ledger engine** — starting with a rock-solid single-agent adapter for DeepSeek Harness (`dsh`), and only then expanding to single-window multi-agent orchestration.

---

## 2. Directory & Layer Boundaries

This is an entry-point map, not an exhaustive file list.

| Start here | Responsibility |
| --- | --- |
| `bin/cairn.mjs`, `src/commands/run-cairn.mjs` | Executable and shared command dispatch. |
| `src/kernel/ledger.mjs`, `marker.mjs`, `contracts.mjs` | Deterministic fold, marker parsing and prompt contracts; no LLM or network. |
| `src/kernel/hub-store.mjs`, `hub-write-lock.mjs` | Default Hub: scoped ledgers, persistence and snapshot consistency. `src/kernel/store.mjs` is the workspace-local compatibility store. |
| `src/workers/hub-handoff.mjs`, `hub-cold-router.mjs`, `hub-staging-extractor.mjs` | Handoff assembly, routing and scoped staging. |
| `src/hosts/dsh/index.mjs`, `hub-host.mjs`, `hub-turn-runtime.mjs` | Adapter selection, default Hub integration, and turn attribution. Explicit `workspaceRoot` selects the compatibility adapter. |
| `test/git-project.node-test.mjs`, `test/kernel.node-test.mjs`, `test/hub-*.node-test.mjs` | Git discovery, kernel contracts and Hub integration/recovery. `npm test` discovers the full suite. |
| `scripts/smoke-dsh.mjs`, `docs/dsh-host-interface.md` | Installed-host verification and setup; the smoke provider is offline. |

---

## 3. The Five Validated Primitives (Do Not Reinvent or Alter)

1. **Minimal Inline Tail Marker + Anti-Recency Contract (`src/kernel/marker.mjs`, `buildAntiRecencyContract`)**:
   - Primary assistant responses append only `<|task:N|>` (`1..999`) or `<|task:UNRESOLVED|>`.
   - `parseTaskMarker` permits markers on their own trailing line after a *closed* Markdown code fence (```` ```...```\n<|task:N|> ````) while rejecting markers inside *unclosed* fences.
   - Ambiguous requests matching multiple tasks must emit `<|task:UNRESOLVED|>` and ask for clarification rather than defaulting to the most recent task (Recency heuristic).
2. **Asynchronous Staging Restricted Operator Extraction (`buildStagingExtractorPrompt`)**:
   - Workspace state extraction runs **out-of-band** after a turn commits, emitting strict JSON `{"ops":[...]}` restricted to `ASSERT`, `SUPERSEDE` (with `target_id` and objective falsification `reason`), `OPEN_QUESTION`, `RESOLVE_QUESTION`, or `{"ops":[]}`.
3. **Host Deterministic `foldLedger` (`src/kernel/ledger.mjs`)**:
   - Only `foldLedger` allocates `D1, D2...` and `Q1, Q2...`.
   - Superseded decisions move to `tombstones` with `superseded_by` and `reason`.
   - Supports `actor_id` (default `"default"`) and `base_revision` optimistic concurrency conflict rejection.
4. **Hard Global/Local Boundary Compaction (`buildStrictCompactorPrompt`)**:
   - Task compaction notes (`.cairn/tasks/<id>/compact.md`) summarize **only task-local state and artifacts** and strictly exclude workspace-global rules.
5. **Authoritative Override & Tombstone Checkout Contract (`buildAuthorityCheckoutContract`)**:
   - On handoff or session resume, `workspace_ledger.active` unconditionally overrides any stale global rule remnant in task transcripts/notes, and `workspace_ledger.tombstones` provides the objective falsification evidence to reject unratified rollbacks.

---

## 4. Non-Negotiable Anti-Bloat Red Lines

- **NEVER ask the primary answering model to maintain or output a nested JSON work-state tree in the same generation** (`Phase 0.9.10` / `FM1` proved this causes 0/24 valid answers and 4/6 decision reversals).
- **NEVER allow the model to invent `D<n>` or `Q<n>` IDs** (`foldLedger` strictly rejects any operator with an `id` property).
- **NEVER mix workspace-global rules into task-local compaction summaries**.
- **NEVER re-introduce monorepo multi-package sprawl, heavy build steps, or synthetic `gate2` ceremony gates**. Keep Cairn a single-package Node ESM repository with millisecond `node --test` execution.

---

## 5. Current Status & Next Development Entry Point

- The filesystem stores, async workers and single-agent Cordis adapter are implemented. Without an explicit `workspaceRoot`, dsh uses the centralized Hub with separate User and Project ledgers; an explicit workspace root keeps the original workspace adapter.
- Start with [the current dsh host behavior and recovery notes](docs/dsh-host-interface.md), `npm test`, and the optional real-host smoke documented there. Distinguish deterministic host verification from live-model routing and summary quality.
