# Hub health and cold recovery

Use this procedure for the centralized dsh **Hub**, not the legacy workspace store. Stop all dsh sessions, workers and CLI writers using this Hub and wait for them to exit. Use the same Cairn version for the drill. Keep the original store and the backup until you have checked the restored copy.

## Operator procedure

Example PowerShell, from the Cairn checkout. Replace the three sample paths. The destination **parent** directories must already exist; the bundle and the restored Hub themselves **must not** exist, even as empty directories. Use dedicated local directories, outside each other and outside the business repository.

```powershell
$source   = 'D:\cairn-data\hub'
$bundle   = 'D:\backups\cairn-before-upgrade'
$restored = 'D:\cairn-data\restored-hub'

node bin/cairn.mjs doctor --store $source --json
# Continue only on exit 0. Capture a representative task checkout for comparison.
node bin/cairn.mjs checkout 1 --preview --store $source --json

node bin/cairn.mjs backup $bundle --store $source --json
# Continue only when backup exits 0. Restore never overwrites an existing Hub.
node bin/cairn.mjs restore $bundle --store $restored --json

node bin/cairn.mjs doctor --store $restored --json
node bin/cairn.mjs checkout 1 --preview --store $restored --json
```

Use a real task ID in place of 1. Compare the recorded history and compacted cursor, User/Project decisions and tombstones, pending tool observations, and any file-write IDs, expected digests and last checks. The two checkouts should agree **before new writes**. For a live cutover, point the dsh patch's `storeRoot` to the restored directory and start one session. Do not run both copies as writers and expect them to merge. Repointing to the original is a rollback, not a way to transfer newer changes.

## What the commands guarantee

- **Doctor:** exit 0 = its implemented checks passed, exit 1 = inspect `issues`. It checks scoped ledger replay, task index counts versus actual records, sequence/project identity, compaction coverage, readable handoff evidence, and outstanding receipt-to-observation links, and stale session bindings. One unreadable task does not hide issues in another. A task with no records can legitimately have no thread file. Doctor never repairs data or inspects business-file contents. It is not a consistent live snapshot: on a busy Hub, stop writers and check again.
- **Backup:** takes the Hub write lock for the copy, excludes the root writer lock/fence and private lock candidates, and verifies the copy against a versioned directory/file inventory with byte sizes and SHA-256 hashes. It also runs doctor on the copy before publishing `manifest.json`. Backup is not a repair or salvage tool; preserve the original bytes separately if the Hub is unhealthy.
- **Restore:** verifies the manifest and actual payload, then checks the bytes and health of a staged copy under the fresh destination. It publishes `hub.json` last. No command replays a business tool, confirms a decision, or edits a project file. Interrupted attempts can leave an incomplete destination; do not treat it as a valid bundle or start dsh there. Retry into a **new** directory.
- **Scope:** the bundle contains the Hub's history, sessions, staging and pending evidence. It is not encrypted; give it the same access controls as the source. A colocated checksum manifest detects accidental loss or alteration, not a party able to replace both the payload and manifest. Links, hard-linked files and special entries are refused; only ordinary files and directories are copied. This is logical cold recovery, not live replication, an ACL backup, or a power-loss durability guarantee.
- **Outside the Hub:** back up Git working trees/uncommitted files and the native dsh session journal separately. A restored write intent retains the original project/root identity; it does not recreate the file, remap a moved project or prove a previous external effect. An `in_progress` receipt remains unconfirmed.

## If the check is red

| Issue | What to do |
| --- | --- |
| `task_record_count_mismatch`, `task_thread_missing`, `task_thread_unreadable` | Stop writers. Keep the source unchanged, note the task ID and counts, and compare with a known-good restored copy. Ledger sync does **not** repair task history. |
| `receipt_observation_missing` or unreadable write evidence | Do not infer success, silently clear the receipt, or retry the tool. Check the restored copy and native journal; verify actual external state separately. |
| Ledger `materialization_pending` | Follow the scoped ledger sync procedure for that specific scope. A divergent or damaged log is not the same as a stale materialized head; do not truncate it. |
| Busy lock, checksum failure, missing/invalid manifest or pre-existing destination | Do not force unlock or overwrite. Stop writers, check the backup source, and use an intact bundle and fresh destination. |

To repeat the self-contained drill without production data: `node --test test/hub-recovery.node-test.mjs`. The installed-host test, `node scripts/smoke-dsh.mjs <dsh/lib/bin.js>`, also cold-restores a real stopped dsh Hub after a native file write exited before its tool result. The provider is an offline fixture.
