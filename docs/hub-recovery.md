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

### Encrypted and authenticated bundle (optional)

When a party with access to backup storage must not be able to read or rewrite the contents, use an external random 32-byte key. Create it once in an access-controlled directory **outside both Hub and bundle**. Keep an independently protected recovery copy. Loss of the key means loss of access; anyone with the key can read **and create** authenticated backups. Do not put the key in the backup, Git, a command line or a passphrase file.

```powershell
$key = 'D:\private-keys\cairn-backup.key'
# Create exclusively; do not regenerate an existing key.
node -e "require('node:fs').writeFileSync(process.argv[1],require('node:crypto').randomBytes(32),{flag:'wx',mode:0o600})" $key
node bin/cairn.mjs backup $bundle --store $source --key-file $key --json
node bin/cairn.mjs restore $bundle --store $restored --key-file $key --json
```

The key file may contain 32 raw bytes or 64 hexadecimal characters (optional final newline). On Windows protect the key directory with the intended account's ACL. Backup streams into numbered ciphertext files; there is no temporary plaintext backup. A v2 bundle encrypts both file contents and the inventory of file names and hashes. Each bundle uses a random 256-bit salt, a separate HKDF-SHA256 key, and AES-256-GCM with a distinct nonce per file and manifest. File counts and approximate sizes are visible. Restore authenticates every blob before creating the destination, then verifies the restored bytes and runs doctor before publishing. The restored Hub is plain local data, just like the original.

Supply `--key-file` on restore whenever authentication is required: a v1 plaintext bundle is then rejected, even if internally consistent. Without a key, the original v1 commands still work; a v2 bundle never falls back to v1. A valid older encrypted bundle can still be replayed as a whole; confirm the expected backup date or identifier independently.

## What the commands guarantee

### Optional extended Hub task IDs

The normal Hub and legacy workspace keep IDs 1..999. To opt in, stop all writers, take a backup, then run `cairn init --store <hub> --extended-task-ids` using a current release. This is a one-way Hub option; do not run older Cairn binaries against this store. Existing task directories and IDs do not move. The new capacity is 999,000 monotonically increasing **durable task IDs**. The capacity limit is checked before allocation; closing or archiving a task never recycles a number.

Use the durable number with `tasks`, `checkout 1000 --preview`, slash commands or a request such as “continue task #1000”. The primary assistant still emits only markers 1..999. Autopilot TurnScope maps each consecutive group of 999 durable tasks to markers 1..999; for example, #999 uses marker 999, #1000 uses marker 1, and #1999 uses marker 1 in a different group. Only the marker for the host-selected task/ticket can file that turn. Group assignments persist per native session across restarts and backup/restore. The first use requires turn 1 of a new, non-forked dsh session with a verifiable session identity and no previous Cairn receipts; use another new native session for another group. Checkout/clear does not reset a group's assignment.

A current compatibility host without TurnScope refuses to file into an extended Hub, even for low task numbers. Keep the default capacity if you need that host. Index and ledger files are still read locally; capacity is a namespace limit, not a throughput claim at that many active tasks.

Run `node scripts/smoke-dsh.mjs <dsh/lib/bin.js> --marker-bank-only` to check the installed native host with an offline provider: a fresh session creates durable task #1000 with short marker 1, resumes after restart, refuses a different bank, and restores the original checkout through the CLI.

- **Doctor:** exit 0 = its implemented checks passed, exit 1 = inspect `issues`. It checks scoped ledger replay, task index counts versus actual records, sequence/project identity, compaction coverage, readable handoff evidence, and outstanding receipt-to-observation links, and stale session bindings. One unreadable task does not hide issues in another. A task with no records can legitimately have no thread file. Doctor never repairs data or inspects business-file contents. It is not a consistent live snapshot: on a busy Hub, stop writers and check again.
- **Backup:** takes the Hub write lock for the copy, excludes the root writer lock/fence and private lock candidates, and verifies the copy against a versioned directory/file inventory with byte sizes and SHA-256 hashes. It also runs doctor on the copy before publishing `manifest.json`. Backup is not a repair or salvage tool; preserve the original bytes separately if the Hub is unhealthy.
- **Restore:** verifies the manifest and actual payload, then checks the bytes and health of a staged copy under the fresh destination. It publishes `hub.json` last. No command replays a business tool, confirms a decision, or edits a project file. Interrupted attempts can leave an incomplete destination; do not treat it as a valid bundle or start dsh there. Retry into a **new** directory.
- **Scope:** the bundle contains the Hub's history, sessions, staging and pending evidence. The default v1 bundle is not encrypted; give it the same access controls as the source. Its colocated checksum manifest detects accidental loss or alteration, not a party able to replace both the payload and manifest. Use v2 above for authenticated, confidential storage. Links, hard-linked files and special entries are refused; only ordinary files and directories are copied. This is logical cold recovery, not live replication, an ACL backup, or a power-loss durability guarantee.
- **Outside the Hub:** back up Git working trees/uncommitted files and the native dsh session journal separately. A restored write intent retains the original project/root identity; it does not recreate the file, remap a moved project or prove a previous external effect. An `in_progress` receipt remains unconfirmed.

## If the check is red

| Issue | What to do |
| --- | --- |
| `task_record_count_mismatch`, `task_thread_missing`, `task_thread_unreadable` | Stop writers. Keep the source unchanged, note the task ID and counts, and compare with a known-good restored copy. Ledger sync does **not** repair task history. |
| `receipt_observation_missing` or unreadable write evidence | Do not infer success, silently clear the receipt, or retry the tool. Check the restored copy and native journal; verify actual external state separately. |
| Ledger `materialization_pending` | Follow the scoped ledger sync procedure for that specific scope. A divergent or damaged log is not the same as a stale materialized head; do not truncate it. |
| Busy lock, checksum failure, missing/invalid manifest or pre-existing destination | Do not force unlock or overwrite. Stop writers, check the backup source, and use an intact bundle and fresh destination. |

To repeat the self-contained drill without production data: `node --test test/hub-recovery.node-test.mjs`. The installed-host test, `node scripts/smoke-dsh.mjs <dsh/lib/bin.js>`, also cold-restores a real stopped dsh Hub after a native file write exited before its tool result. The provider is an offline fixture.
