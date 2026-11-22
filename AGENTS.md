# AGENTS.md — Cairn Engineering Constitution

Read this file first at the start of every coding session in this repository.

## 1. Mission & Lineage

**Cairn** (*Git for Agent Work States*) is the practical engineering implementation (Path 2) of the **five closed-loop mechanism primitives** validated across 484 controlled single-factor ablation calls in the ACMI research program ([`docs/reference/acmi-path1-synthesis.md`](docs/reference/acmi-path1-synthesis.md)).

Our goal is to deliver a **fast, lightweight, local-first (`.cairn/`) task-continuity and workspace-state ledger engine** — starting with a rock-solid single-agent adapter for DeepSeek Harness (`dsh`), and only then expanding to single-window multi-agent orchestration.

---

## 2. Directory & Layer Boundaries

```text
cairn/
├── bin/
│   └── cairn.mjs        # Minimal zero-dependency CLI (init / status / log / commit / drop / tasks)
├── src/
│   ├── kernel/          # Layer 1: Deterministic core (ZERO LLM calls, ZERO network, ZERO host imports)
│   │   ├── ledger.mjs   #   createEmptyLedger, foldLedger (D1../Q1.., actor_id, base_revision), projectReadOnlyLedger
│   │   ├── marker.mjs   #   parseTaskMarker (closed-fence aware), stripTaskMarker, buildLightTaskCatalog
│   │   ├── contracts.mjs#   buildAntiRecencyContract, buildStagingExtractorPrompt, buildStrictCompactorPrompt, buildAuthorityCheckoutContract
│   │   ├── store.mjs    #   .cairn/ persistence, replayLedger verification, batch optimistic concurrency
│   │   └── index.mjs    #   Kernel barrel export
│   ├── workers/         # Layer 2: Out-of-band async LLM workers (llm-client, distill, staging-extractor, strict-compactor, cold-router)
│   └── hosts/
│       └── dsh/         # Layer 3: Thin runtime host adapter for DeepSeek Harness (dsh 0.2.2-rc.1 / Cordis 4.1.0)
├── docs/
│   ├── architecture.md               # .cairn/ disk model & 3-layer design
│   ├── dsh-host-interface.md         # Factual dsh Cordis hooks & verified integration surface
│   ├── cairn.patch.example.yml       # Example Cordis --patch config for dsh
│   └── reference/
│       └── acmi-path1-synthesis.md   # Read-only empirical proof of the 5 primitives
└── test/
    ├── kernel.node-test.mjs          # Millisecond kernel unit tests via `node --test`
    ├── store-cli.node-test.mjs       # .cairn/ persistence & CLI integration tests via `node --test`
    ├── workers.node-test.mjs         # Out-of-band workers & trajectory distiller unit tests
    └── dsh-host.node-test.mjs        # Offline end-to-end dsh Cordis host adapter tests
```

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

- **Completed**:
  - `src/kernel/ledger.mjs`, `src/kernel/marker.mjs`, `src/kernel/contracts.mjs`, and `test/kernel.node-test.mjs` (100% passing).
  - Architecture spec ([`docs/architecture.md`](docs/architecture.md)) and factual `dsh` hook reference ([`docs/dsh-host-interface.md`](docs/dsh-host-interface.md)).
- **Next Step**:
  1. Build the `.cairn/` local filesystem store (`.cairn/head.json`, `.cairn/ledger.jsonl`, `.cairn/staged.json`, `.cairn/tasks/`) and async worker runners in `src/workers/`.
  2. Implement the single-agent `dsh` Cordis plugin in `src/hosts/dsh/index.mjs` and verify the three interactive surface items listed in Section 3 of [`docs/dsh-host-interface.md`](docs/dsh-host-interface.md).
