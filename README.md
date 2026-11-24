# Cairn

**Git for Agent Work States** — lightweight multi-task continuity, out-of-band asynchronous state staging, deterministic Host ledger folding (with falsification tombstones), and anti-regression handoff for AI coding agents.

---

## Research Lineage

Cairn is the clean, zero-baggage engineering implementation (Path 2) built directly on the **five closed-loop mechanism primitives** validated by the [ACMI Path 1 Research Program](https://github.com/Violet-2ai077/ACMI/releases/tag/path1-mechanism-validation-final-20261122) across **484 controlled single-factor ablation calls** (`TH1-B`, `TC5-B`, `TC3-B`, `ST1`).

See the verbatim synthesis report in [`docs/reference/acmi-path1-synthesis.md`](docs/reference/acmi-path1-synthesis.md) for the complete empirical evidence matrix:
- **Falsified & Retired**: Same-generation heavy structured work-state JSON maintenance (`FM1`: 4/6 decision reversals, UUID drift) and uncontracted task compaction (`TH1-B` `compact_P0_C0`: 8/8 [100%] stale-rule resurrection).
- **Validated & Adopted in Cairn**:
  1. **Minimal Inline Tail Marker (`<|task:N|>` / `<|task:UNRESOLVED|>`) + Anti-Recency Contract (`SYSTEM_C1`) + Host Light Task Catalog** (`TC3-B`: **72/72 [100%]** de-greenhouse continuity across 24 turns; `TC5-B`: **16/16 [100%]** ambiguity clarify, **0/16 [0%]** over-abstention);
  2. **Asynchronous Out-of-Band State Operator Staging (`ASSERT` / `SUPERSEDE` / `OPEN_QUESTION` / `RESOLVE_QUESTION` / `NO_OP`)** (`ST1` Part A1 & A2: **36/36 [100%]** accuracy without handle leaks, **0%** false writes);
  3. **Host Deterministic `foldLedger` (`Active HEAD` + `Tombstones` + `Open Questions`)** (`ST1` Part B: **6/6 [100%]** handoff accuracy with **-58.4%** reasoning tokens vs raw transcript; stripping `tombstones` dropped falsification-evidence citation from **100% to 0%**);
  4. **Hard Global/Local Boundary Task Compactor (`COMPRESSOR_STRICT`)** (`TH1-B`: **24/24 [100%]** zero global-rule leak across `max`, `low`, `none`);
  5. **Authoritative Override & Tombstone Checkout Contract (`RECEIVER_C1`)** (`TH1-B`: **120/120 [100%]** pass, **0%** stale resurrection, **-90.5%** `max`-tier reasoning tokens on polluted histories).

---

## Repository Structure

```text
cairn/
├── AGENTS.md                         # Engineering constitution & boundaries for coding agents
├── README.md                         # Project overview & quick start
├── package.json                      # Zero-dependency single-package Node ESM config
├── docs/
│   ├── architecture.md               # .cairn/ disk model & kernel/workers/hosts 3-layer design
│   ├── dsh-host-interface.md         # Verified DeepSeek Harness (dsh) Cordis hooks & extension spec
│   └── reference/
│       └── acmi-path1-synthesis.md   # Verbatim ACMI Path 1 synthesis report (484 ablation calls)
├── src/
│   ├── kernel/                       # Pure deterministic, zero-LLM, host-agnostic core primitives
│   │   ├── ledger.mjs                #   foldLedger (D1../Q1.. handles, tombstones, actor_id, base_revision)
│   │   ├── marker.mjs                #   parseTaskMarker (closed-fence fix), stripTaskMarker, buildLightTaskCatalog
│   │   ├── contracts.mjs             #   4 parameterized prompt contract builders
│   │   └── index.mjs                 #   Unified kernel exports
│   ├── workers/                      # Routing, staged extraction, compaction and checkout
│   │   └── index.mjs
│   └── hosts/
│       └── dsh/                      # Reference Host #1 (dsh 0.2.2-rc.5): Hub and workspace adapters
│           └── index.mjs
└── test/
    └── *.node-test.mjs               # Kernel, stores, workers, CLI, and dsh integration
```

---

## Running Tests

Cairn uses Node.js built-in test runner (`node:test` and `node:assert/strict`) with zero external runtime dependencies:

```sh
npm test
# or directly:
node --test test/kernel.node-test.mjs
```

With dsh installed, `node scripts/smoke-dsh.mjs /absolute/path/to/dsh/lib/bin.js` additionally verifies the real headless host across native compaction and process restart, with a local deterministic provider. See [dsh continuity and recovery](docs/dsh-host-interface.md#continuity-fixes-and-recovery) for turn diagnostics, markerless recovery, and rebuilding old summaries.

With Hub Autopilot enabled as in the example patch, an unbound “继续” asks which task to resume instead of guessing. Pick a task in the dsh client, or reply “CSV 那个” to the text menu; Cairn then resumes the original request without asking you to repeat it. See [choosing which task to resume](docs/dsh-host-interface.md#choosing-which-task-to-resume).

---

## Documentation

- **[`AGENTS.md`](AGENTS.md)**: One-page engineering constitution, non-negotiable red lines, and next development entry point.
- **[`docs/architecture.md`](docs/architecture.md)**: The `.cairn/` on-disk layout (`head.json`, `ledger.jsonl`, `staged.json`, `tasks/`) and the `kernel -> workers -> hosts` architecture.
- **[`docs/dsh-host-interface.md`](docs/dsh-host-interface.md)**: Confirmed lifecycle hooks (`ctx.systemPrompt.context`, `ctx.on('llm/stream')`, `ctx.on('session/event')`, `appendPluginRecord`) and interactive profile verification items for DeepSeek Harness (`dsh`).
- **[`docs/reference/acmi-path1-synthesis.md`](docs/reference/acmi-path1-synthesis.md)**: Full empirical report of the 484 controlled single-factor ablation calls from ACMI Path 1.
