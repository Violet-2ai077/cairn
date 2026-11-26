# Cairn

[English](README.md) · [简体中文](README.zh-CN.md)

**Git for Agent Work States** — lightweight multi-task continuity, out-of-band asynchronous state staging, deterministic Host ledger folding (with falsification tombstones), and anti-regression handoff for AI coding agents.

## Install and verify from source

**Do not run `npm install cairn`, `npm install cairn@0.1.0`, or `npx cairn`.**
The public npm package with that name is an unrelated React Native library.
Use Git and Node.js 22+; this checkout needs no dependency installation or build:

```sh
git clone https://github.com/Violet-2ai077/cairn.git
cd cairn
git remote get-url origin
node ./bin/cairn.mjs status --json
npm test
```

The remote should be the repository above. On a new installation, an
uninitialized store is expected: `status` is read-only. In the examples below,
use `node /absolute/path/to/cairn/bin/cairn.mjs` wherever you see `cairn`.
The CLI alone does **not** activate the dsh plugin. For the verified host
(`dsh 0.2.2-rc.5` on Node 24.16), copy the [example patch](docs/cairn.patch.example.yml),
replace its placeholder file URL with the absolute URL of this checkout's
`src/hosts/dsh/index.mjs`, then start `dsh --profile web --patch <your-patch.yml>`.
Use `/cairn status` in dsh to verify activation.

For a pinned installation, check out `v0.4.3` after cloning, or download
`cairn-0.4.3.tgz` and its SHA-256 checksum from the
[GitHub release](https://github.com/Violet-2ai077/cairn/releases/tag/v0.4.3).
Install the verified **local file** with `npm install --offline ./cairn-0.4.3.tgz`.
This does not require resolving the package name from the npm registry.

### Language

Cairn selects the language for its model contracts, task picker and memory
review at process startup. A Chinese environment uses Chinese; English and
unrecognized locales use English. To override, set `CAIRN_LOCALE=en` or
`CAIRN_LOCALE=zh` before starting dsh (PowerShell: `$env:CAIRN_LOCALE='en'`).
Use `auto` or unset the variable to follow `LC_ALL`, `LC_MESSAGES`, `LANG`
or the operating system locale, in that order. Stored user content, ledger
keys, task markers, command names and JSON fields are not translated.

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

## Inspecting a task

To inspect a task without starting dsh or changing a session binding:

```sh
cairn checkout 1 --store /path/to/hub --preview
cairn checkout 1 --store /path/to/hub --preview --json
```

Both show the applicable rules, filed history and any checkpointed tool results for turns that were not filed. A result from an interrupted turn is evidence to verify, not a completed task or an instruction to repeat the tool. See [the handoff format](docs/architecture.md#read-only-task-handoff-hub).

### Checking a file after a disconnect

If a bound dsh task started a native full-file `write`, its checkout can show a write ID even when no tool result returned. Copy the ID from `work_state.file_writes` and explicitly check the file:

```sh
cairn verify-write 1 <write-id> --store /path/to/hub --json
```

`matches` (exit 0) means the bytes matched the expected SHA-256 **when checked**. `differs` (2) means the bytes differed or the file was missing. `unverifiable` (3) means no safe comparison could be made. Command/usage errors exit 1. The command records its latest finding on the active task; it does not write the target, repeat the tool, or mark the task complete. Ordinary checkout only reads the Hub.

### Health and recovery

For day-to-day Hub use, [check health and rehearse a cold restore](docs/hub-recovery.md) before relying on the ledger. `doctor` is read-only. `backup` and `restore` use explicit store paths and fresh destinations; neither changes which Hub dsh is configured to use.

See [Hub reliability and benchmarks](docs/hub-reliability.md) for verified context reads and CI,
[turn recovery](docs/turn-recovery.md) for interrupted archives and tool evidence, and
[attribution experiments](docs/attribution-quality.md) for task routing, preference evaluation,
and opt-in fresh-session isolation. Backup encryption is optional; plaintext is not authenticated
against replacement by an attacker.

## Running Tests

Cairn uses Node.js built-in test runner (`node:test` and `node:assert/strict`) with zero external runtime dependencies:

```sh
npm test
# or directly:
node --test test/kernel.node-test.mjs
```

With dsh installed, `node scripts/smoke-dsh.mjs /absolute/path/to/dsh/lib/bin.js` additionally verifies the real headless host across native compaction and process restart, with a local deterministic provider. See [dsh continuity and recovery](docs/dsh-host-interface.md#continuity-fixes-and-recovery) for turn diagnostics, markerless recovery, and rebuilding old summaries.

With Hub Autopilot enabled as in the example patch, an unbound “继续” asks which task to resume instead of guessing. Pick a task in the dsh client, or reply “CSV 那个” to the text menu; Cairn then resumes the original request without asking you to repeat it. See [choosing which task to resume](docs/dsh-host-interface.md#choosing-which-task-to-resume).

Long-term preferences are separate from task selection. “这次用英文” applies to this answer only. “以后默认用中文” in a project offers a scoped memory choice **after** the business answer. See [confirming a preference](docs/dsh-host-interface.md#confirming-a-preference) for the exact replies and how to check whether a rule actually took effect.

---

## Documentation

- **[`AGENTS.md`](AGENTS.md)**: One-page engineering constitution, non-negotiable red lines, and next development entry point.
- **[`docs/architecture.md`](docs/architecture.md)**: The `.cairn/` on-disk layout (`head.json`, `ledger.jsonl`, `staged.json`, `tasks/`) and the `kernel -> workers -> hosts` architecture.
- **[`docs/dsh-host-interface.md`](docs/dsh-host-interface.md)**: Confirmed lifecycle hooks (`ctx.systemPrompt.context`, `ctx.on('llm/stream')`, `ctx.on('session/event')`, `appendPluginRecord`) and interactive profile verification items for DeepSeek Harness (`dsh`).
- **[`docs/reference/acmi-path1-synthesis.md`](docs/reference/acmi-path1-synthesis.md)**: Full empirical report of the 484 controlled single-factor ablation calls from ACMI Path 1.
