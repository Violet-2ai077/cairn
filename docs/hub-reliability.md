# Hub reliability contract

## Authority

The commit log, not the materialized head, determines the authoritative ledger.
A verified prefix plus a newer valid commit log is readable immediately: a read
returns the replayed value and excludes consumed staged proposals without changing
either file. Use `cairn sync` to publish the recovered materialization. Divergent
heads, incomplete logs, invalid indexes and missing files in established ledgers
are errors. A never-initialized Hub or a project not yet registered is distinct
from a registered project with a missing ledger.

## What makes a snapshot consistent

Hub writers serialize on the existing interprocess lock and publish an opaque
generation under that lock. Readers sample it and the writer fence on both sides
of a synchronous capture; they discard the capture if a writer intervened.
Interactive dsh prompt captures return `hub_snapshot_busy` on observing a
held fence; if only the generation changed, they recapture once without
sleeping. Standalone CLI readers allow five attempts. No LLM call, Hub
repair or reader lock occurs inside capture. An abandoned writer fence is not
silently deleted by a preview. Use the documented recovery flow on the stopped Hub.

The dsh TurnScope rechecks the expected binding and selected task or creation
ticket inside capture. A stable checkout includes both ledgers, thread, compact
content/cursor, outstanding observations, file-write evidence and task catalog.
A republished compact at the same cursor invalidates the checkout. A task's own
newly archived answer already exists in native history; the cache avoids adding
it a second time without skipping a peer append. New compact publications carry
a content digest in the task index. A legacy compact without such a digest can
be checked for presence and cursor consistency, but its original bytes cannot
be authenticated retrospectively.

`checkout --preview --json` supplies a content-derived snapshot ID and consistency
status. An index/thread discrepancy returns nonzero, without rendering the
history or authoritative prompt; `doctor` has detailed diagnostics. The default
Hub compatibility adapter also renders its two prompt sections from one capture.
These guarantees require writers to use the current Hub protocol: direct disk
edits, concurrently running old writers, network filesystem semantics and sudden
power loss are not a supported transaction model. They do not turn native dsh
history into a security boundary.

The host entrypoint wires the native hooks. `hub-turn-runtime.mjs` owns the
in-flight scope and marker check; `hub-context.mjs` supplies paired compatibility
prompt sections; `hub-archive-coordinator.mjs` owns the per-session worker queue,
startup replay and recovery diagnostics. The kernel, not the coordinator or
the model, remains responsible for all durable writes and ledger transitions.

## Interactive contention and recovery

In the default dsh Hub adapter, TurnScope snapshots, both compatibility prompt
sections and native compaction prompt capture do not sleep on a writer fence.
In Autopilot, a busy snapshot withholds the primary model and asks for a retry;
there is no in-progress receipt for model work that never started. A normal
`turn/end` still attempts to persist the unassigned outcome. The compatibility
provider propagates the busy error rather than injecting an older checkout.

The slash commands `checkout` (including preview), `close`, `archive`, `reopen`,
`commit`, `drop`, `undo` and `revert`, and their corresponding tools where
available, do not sleep to acquire a contended lock. They return
`hub_write_lock_busy` or `hub_snapshot_busy`; retry the command after the other
writer finishes. This policy is scoped to that invocation and Hub root, not
to the entire process or all hosts sharing a root. It changes neither the
cross-process exclusion protocol nor the generation check.

**Remaining synchronous paths:** session events (notably accepting an answer
at `turn/end`), receipts, archive replay, background workers and operations not
listed above keep the original bounded retry. A brief collision must not turn
an accepted answer into a failed archive just to make the hook return faster.
A writer that outlasts the deadline can still block archival; if no archive
intent was persisted there is nothing for startup replay to recover. Inspect
the native journal and `cairn turns` before assuming the answer was filed.
Even interactive operations use synchronous filesystem calls, and transient
generation-publication errors after acquiring the lock retain their short
retries. This is not a nonblocking filesystem or a latency guarantee.

## Measurement and continuous integration

`node scripts/bench-hub-contention.mjs` holds the writer fence on a disposable
Hub in one process while another attempts a snapshot and write. It reports
the busy outcomes, elapsed call times and when a zero-delay timer actually
ran, for `interactive` and `default_retry` policies separately. The default
reader tries five times with 5/10/15/20 ms sleeps between attempts; default
writer acquisition shares an approximately one-second deadline. The interactive
probe uses no retry sleeps on the held lock. These are not hard latency limits.
Uncontended calls do not pay these sleeps. The probe measures a deliberately
held lock, not the frequency of contention in real sessions. Do not substitute
an unverified snapshot or delete a live lock to avoid a busy result.

```sh
npm test
npm run eval:reliability
npm run bench:hub -- --tasks 50 --records 200 --samples 30 --output hub-benchmark.json
```

The benchmark uses a disposable Hub, never a user's store. It reports warmed
P50/P95 for verified ledger reads, handoff compilation and lexical shortlisting;
the context size in UTF-8 bytes; storage growth; a timed cold backup/restore;
and fixture worker call count. For exact token counts, pass `--tokenizer <module.mjs>`
with a trusted local module exporting `countTokens(text)` for the model under
test. Without it, `context_tokens` is null, not a byte-to-token estimate. The
offline provider has no billable cost. This is not a live-provider latency or
cost measurement. [The separate quality harness](attribution-quality.md)
can measure a configured provider if deliberately enabled.

One local reference run (Ubuntu 24.04 under WSL, native temporary storage,
Node 24.16.0, 1,000 real indexed tasks in an extended Hub, 100 thread records,
30 warm samples) gave 2.750/4.225 ms handoff P50/P95, 0.087/0.203 ms verified
ledger read, and 4.542/6.781 ms shortlist. The rendered handoff was 7,832 UTF-8
bytes; backup and restore took 184 and 188 ms respectively. These numbers are
a repeatable workload specification, not release gates or a throughput SLA.

The reliability workflow runs on PRs, pushes to main and a weekly schedule.
It exercises Windows/Ubuntu and Node 22/24, publishes the benchmark JSON and
runs the pinned real dsh host with its offline provider on Node 24 (dsh requires
Node >=24.9). Configure required job checks in the GitHub repository's branch
rules to block merges; the workflow file alone cannot enforce that policy.

Local verification for this change (not a hosted Actions run):

| Runtime | Node 22 | Node 24 |
| --- | --- | --- |
| Windows | 22.23.5: 186 passed | 24.16.0: 186 passed |
| Ubuntu 24.04 under WSL | 22.22.2: 186 passed | 24.16.0: 186 passed |

Each run had zero failures, cancellations and skips. The crash suite terminates
actual child processes; the archived-turn boundary tests are separate from the
installed dsh smoke. Neither simulates power loss or establishes live-model accuracy.

## Operational data

Cold backup is not a retention or confidentiality policy. Set restrictive
filesystem permissions on the Hub, native journals and backups; choose an
external retention schedule for **complete** cold bundles. Test a restore
before pruning a bundle and retain the corresponding encryption key separately.
Deleting individual receipt, intent, ledger or archive-job files can invalidate
recovery or evidence: there is intentionally no background TTL deleting them.
See [backup and restore](hub-recovery.md) and [crash recovery](turn-recovery.md).
