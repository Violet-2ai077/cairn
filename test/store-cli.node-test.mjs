import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveCairnPaths,
  initCairnStore,
  readHead,
  readLedgerLog,
  replayLedger,
  readStaged,
  stageOperators,
  commitStaged,
  dropStaged,
  readTasksIndex,
  upsertTask,
  appendTaskTurn,
  readTaskThread,
  writeTaskCompaction,
  readTaskCompaction,
  getStoreStatus,
  writeJsonAtomic
} from '../src/kernel/index.mjs';
import { runCairnCli, runCairnCliAsync } from '../bin/cairn.mjs';

test('a Legacy writer exits after append: the next commit is blocked until repair and never reapplies a consumed proposal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-commit-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initCairnStore(root);
  const paths = resolveCairnPaths(root);
  const op = key => ({ op: 'ASSERT', scope: 'global', key, option_code: 'yes', summary: 'yes' });
  stageOperators(root, { ops: [op('first')] });
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { commitStaged, resolveCairnPaths } from ${JSON.stringify(new URL('../src/kernel/store.mjs', import.meta.url).href)};
    const root = process.argv[1];
    const ledger = resolveCairnPaths(root).ledgerFile;
    const append = fs.appendFileSync;
    fs.appendFileSync = (file, ...args) => {
      append(file, ...args);
      if (file === ledger) process.exit(27);
    };
    commitStaged(root);
  `, root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 27, child.error?.message ?? child.stderr);
  assert.equal(readHead(root).revision, 0);
  assert.equal(readLedgerLog(root).length, 1);
  assert.equal(readStaged(root).proposals.length, 1);
  assert.ok(fs.existsSync(path.join(paths.cairnDir, '.write.lock.guard')));
  const next = stageOperators(root, { ops: [op('second')] }).proposal.proposal_id;
  assert.throws(() => commitStaged(root, { proposal_id: next }), /ledger_replay_required/u);
  assert.equal(readLedgerLog(root).length, 1);
  assert.equal(replayLedger(root, { repairHead: true }).valid, true);
  assert.equal(commitStaged(root, { rebase: true }).committed, true);
  assert.deepEqual(readLedgerLog(root).map(r => r.base_revision), [0, 1]);
  assert.equal(replayLedger(root).valid, true);
});

test('Legacy CLI writers serialize commits to the same store', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-shared-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initCairnStore(root);
  const proposals = ['first', 'second', 'third'].map(key =>
    stageOperators(root, { ops: [{ op: 'ASSERT', scope: 'global', key, option_code: 'yes', summary: 'yes' }] }).proposal.proposal_id);
  await Promise.all(proposals.map(id => new Promise((resolve, reject) =>
    execFile(process.execPath, [CLI_BIN_PATH, 'commit', id, '--rebase', '--cwd', root], { timeout: 10000 },
      (error, stdout, stderr) => error ? reject(new Error(stdout + stderr, { cause: error })) : resolve()))));
  assert.deepEqual(readLedgerLog(root).map(r => r.base_revision), [0, 1, 2]);
  assert.equal(readStaged(root).proposals.length, 0);
  assert.equal(replayLedger(root).valid, true);
});

const CLI_BIN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin/cairn.mjs'
);

function withTempWorkspace(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-m1-test-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Cairn Milestone 1 Slice 1: .cairn/ Store Persistence & Replay Engine (src/kernel/store.mjs)', () => {
  test('async CLI compact dispatches incremental/full modes and rejects invalid task IDs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-compact-cli-'));
    try {
      initCairnStore(tmpDir);
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'compact me' });
      const modes = [];
      const io = { cwd: tmpDir, stdout() {}, stderr() {}, llmClient: { async complete(input) { modes.push(input.messages[0].content); return { ok: true, content: '- local compact summary' }; } } };
      assert.equal(await runCairnCliAsync(['compact', '1'], io), 0);
      assert.equal(readTasksIndex(tmpDir).tasks[0].compacted_record_count, 1);
      appendTaskTurn(tmpDir, { task_id: 1, turn: 2, role: 'user', content: 'full compact me' });
      assert.equal(await runCairnCliAsync(['compact', '1', '--full'], io), 0);
      assert.equal(readTasksIndex(tmpDir).tasks[0].compacted_record_count, 2);
      assert.equal(modes.length, 2);
      assert.equal(await runCairnCliAsync(['compact', 'bad'], io), 1);
      assert.equal(await runCairnCliAsync(['compact', '0'], io), 1);
      assert.equal(await runCairnCliAsync(['compact', '99'], io), 1);
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });

  test('CLI checkout previews without mutation and sets or clears a validated workspace anchor', () => {
    withTempWorkspace(tmpDir => {
      initCairnStore(tmpDir);
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'Checkout task history' });
      const callCli = args => {
        const out = [];
        const err = [];
        const code = runCairnCli([...args, '--cwd', tmpDir], {
          cwd: tmpDir,
          stdout: line => out.push(line),
          stderr: line => err.push(line)
        });
        return { code, stdout: out.join('\n'), stderr: err.join('\n') };
      };

      const preview = callCli(['checkout', '1', '--preview']);
      assert.equal(preview.code, 0);
      assert.ok(preview.stdout.includes('Checkout task history'));
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, null);

      const checkout = callCli(['checkout', '1']);
      assert.equal(checkout.code, 0);
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, 1);

      const clear = callCli(['checkout', '--clear']);
      assert.equal(clear.code, 0);
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, null);

      const missing = callCli(['checkout', '9', '--preview']);
      assert.equal(missing.code, 1);
      assert.ok(missing.stderr.includes('Task not found: 9'));
    });
  });

  test('CLI lifecycle transitions filter active tasks and freeze non-active checkout, writes, and compaction', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-lifecycle-cli-'));
    try {
      appendTaskTurn(tmpDir, { task_id: 1, turn: 1, role: 'user', content: 'Task one' });
      appendTaskTurn(tmpDir, { task_id: 2, turn: 1, role: 'user', content: 'Task two' });
      upsertTask(tmpDir, { work_anchor_task_id: 1 });
      const callCli = args => {
        const out = [];
        const err = [];
        const code = runCairnCli([...args, '--cwd', tmpDir], {
          cwd: tmpDir,
          stdout: line => out.push(line),
          stderr: line => err.push(line)
        });
        return { code, stdout: out.join('\n'), stderr: err.join('\n') };
      };

      assert.equal(callCli(['close', '1']).code, 0);
      assert.equal(readTasksIndex(tmpDir).tasks.find(task => task.id === 1).status, 'done');
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, null);
      assert.throws(() => appendTaskTurn(tmpDir, { task_id: 1, role: 'assistant', content: 'must not write' }), /task_not_active/);
      assert.equal(readTaskThread(tmpDir, 1).length, 1);

      const active = callCli(['tasks']);
      assert.match(active.stdout, /task:2/);
      assert.doesNotMatch(active.stdout, /task:1/);
      assert.match(callCli(['tasks', '--status', 'done']).stdout, /task:1/);
      assert.match(callCli(['tasks', '--all']).stdout, /task:1[\s\S]*task:2/);
      assert.equal(callCli(['tasks', '--all', '--status', 'done']).code, 1);

      assert.equal(callCli(['checkout', '1', '--preview']).code, 0);
      assert.equal(callCli(['checkout', '1']).code, 1);
      assert.match(callCli(['archive', '1']).stdout, /done -> archived/);
      const compactCalls = [];
      assert.equal(await runCairnCliAsync(['compact', '1'], {
        cwd: tmpDir,
        stdout() {},
        stderr: message => compactCalls.push(message),
        llmClient: { async complete() { throw new Error('must not invoke'); } }
      }), 1);
      assert.match(compactCalls[0], /task_not_active/);

      assert.match(callCli(['reopen', '1']).stdout, /archived -> active/);
      assert.equal(callCli(['checkout', '1']).code, 0);
      assert.equal(readTasksIndex(tmpDir).work_anchor_task_id, 1);
      assert.equal(callCli(['archive', '2']).code, 1, 'active tasks must close before archive');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('idempotently initializes .cairn/ layout and preserves monotonic next_proposal_seq across drop and commit', () => {
    withTempWorkspace(tmpDir => {
      const init1 = initCairnStore(tmpDir);
      assert.equal(init1.initialized, true);
      assert.equal(init1.created_files.length, 4);
      assert.equal(init1.head.revision, 0);

      // Second init is idempotent and creates 0 files
      const init2 = initCairnStore(tmpDir);
      assert.equal(init2.created_files.length, 0);

      // NO_OP staging (`ops: []`) does not allocate a proposal or touch staged queue
      const noopRes = stageOperators(tmpDir, { ops: [], source_step: 'turn_1' });
      assert.equal(noopRes.staged, false);
      assert.equal(noopRes.reason, 'no_op');
      assert.equal(noopRes.next_proposal_seq, 1);

      // Stage stg_1 -> drop stg_1 -> next staged proposal MUST be stg_2 (no ID collision)
      const s1 = stageOperators(tmpDir, {
        source_step: 'turn_2',
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'cache_strategy',
            option_code: 'local_lru',
            summary: 'Local LRU'
          }
        ]
      });
      assert.equal(s1.staged, true);
      assert.equal(s1.proposal.proposal_id, 'stg_1');
      assert.equal(s1.next_proposal_seq, 2);

      const drop1 = dropStaged(tmpDir, { proposal_id: 'stg_1' });
      assert.equal(drop1.dropped, true);
      assert.equal(drop1.dropped_count, 1);
      assert.equal(drop1.remaining_proposals, 0);
      assert.equal(drop1.next_proposal_seq, 2);

      const s2 = stageOperators(tmpDir, {
        source_step: 'turn_3',
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'auth_token',
            option_code: 'jwt_ed25519',
            summary: 'Ed25519 signed JWT'
          }
        ]
      });
      assert.equal(s2.proposal.proposal_id, 'stg_2');
      assert.equal(s2.next_proposal_seq, 3);
    });
  });

  test('commits multiple proposals staged under the SAME HEAD revision in one batch without false self-conflict', () => {
    withTempWorkspace(tmpDir => {
      initCairnStore(tmpDir);

      // Both stg_1 and stg_2 are staged while HEAD is at revision 0 (base_revision: 0)
      const s1 = stageOperators(tmpDir, {
        source_step: 'turn_1',
        actor_id: 'worker-a',
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'cache_strategy',
            option_code: 'local_lru',
            summary: 'In-process LRU cache'
          }
        ]
      });
      const s2 = stageOperators(tmpDir, {
        source_step: 'turn_2',
        actor_id: 'worker-a',
        ops: [
          {
            op: 'SUPERSEDE',
            target_id: 'D1',
            option_code: 'redis_ttl',
            summary: 'Centralized Redis TTL cache',
            reason: 'stale_read_14pct under multi-replica writes'
          },
          {
            op: 'OPEN_QUESTION',
            key: 'failover_window',
            summary: 'Grace window during Redis failover'
          }
        ]
      });

      assert.equal(s1.proposal.base_revision, 0);
      assert.equal(s2.proposal.base_revision, 0);

      // Batch commit both proposals at once
      const commitRes = commitStaged(tmpDir);
      assert.equal(commitRes.committed, true);
      assert.equal(commitRes.conflict, false);
      assert.equal(commitRes.all_rejected, false);
      assert.equal(commitRes.commits.length, 2);
      assert.equal(commitRes.head.revision, 3);
      assert.equal(commitRes.remaining_proposals, 0);

      // Verify commit chain and audit provenance in ledger.jsonl
      const log = readLedgerLog(tmpDir);
      assert.equal(log.length, 2);
      assert.equal(log[0].proposal_id, 'stg_1');
      assert.equal(log[0].base_revision, 0);
      assert.equal(log[0].staged_base_revision, 0);
      assert.equal(log[0].new_revision, 1);

      assert.equal(log[1].proposal_id, 'stg_2');
      assert.equal(log[1].base_revision, 1);
      assert.equal(log[1].staged_base_revision, 0);
      assert.equal(log[1].new_revision, 3);

      // Replay ledger.jsonl from empty state and verify head.json equivalence
      const replay = replayLedger(tmpDir);
      assert.equal(replay.valid, true);
      assert.equal(replay.head_matches, true);
      assert.equal(replay.commit_count, 2);
      assert.equal(replay.replayed_ledger.active[0].id, 'D2');
      assert.equal(replay.replayed_ledger.tombstones[0].id, 'D1');
      assert.equal(replay.replayed_ledger.open_questions[0].id, 'Q1');
    });
  });

  test('intercepts genuine stale base_revision optimistic concurrency conflicts, preserves staged proposal, and supports --rebase', () => {
    withTempWorkspace(tmpDir => {
      initCairnStore(tmpDir);

      // Worker 1 stages and commits at revision 0 -> advances HEAD to revision 1
      stageOperators(tmpDir, {
        source_step: 'turn_1',
        actor_id: 'worker-1',
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'lock_strategy',
            option_code: 'fencing_cas',
            summary: 'Fencing token CAS'
          }
        ]
      });
      const c1 = commitStaged(tmpDir);
      assert.equal(c1.committed, true);
      assert.equal(c1.head.revision, 1);

      // Stale Worker 2 stages a proposal computed against stale base_revision: 0
      const staleStage = stageOperators(tmpDir, {
        source_step: 'turn_2_stale',
        actor_id: 'worker-2',
        base_revision: 0,
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'retry_policy',
            option_code: 'durable_outbox',
            summary: 'Durable outbox retry'
          }
        ]
      });
      assert.equal(staleStage.proposal.proposal_id, 'stg_2');
      assert.equal(staleStage.proposal.base_revision, 0);

      // Strict commit must reject with base_revision_conflict, leave head.json & ledger.jsonl untouched, and record last_conflict
      const conflictRes = commitStaged(tmpDir);
      assert.equal(conflictRes.committed, false);
      assert.equal(conflictRes.conflict, true);
      assert.equal(conflictRes.conflict_error, 'base_revision_conflict:expected_0_actual_1');
      assert.equal(conflictRes.failed_proposal_id, 'stg_2');
      assert.equal(conflictRes.remaining_proposals, 1);

      assert.equal(readHead(tmpDir).revision, 1);
      assert.equal(readLedgerLog(tmpDir).length, 1);

      const stagedAfterConflict = readStaged(tmpDir);
      assert.equal(stagedAfterConflict.proposals.length, 1);
      assert.equal(
        stagedAfterConflict.proposals[0].last_conflict.error,
        'base_revision_conflict:expected_0_actual_1'
      );

      // Explicit rebase folds the compatible operator onto current HEAD (revision 1 -> 2)
      const rebasedRes = commitStaged(tmpDir, { rebase: true });
      assert.equal(rebasedRes.committed, true);
      assert.equal(rebasedRes.conflict, false);
      assert.equal(rebasedRes.head.revision, 2);
      assert.equal(rebasedRes.remaining_proposals, 0);
      assert.equal(replayLedger(tmpDir).valid, true);
    });
  });

  test('retains proposal with last_rejected_ops and writes no empty commit when all operators in a proposal are illegal', () => {
    withTempWorkspace(tmpDir => {
      initCairnStore(tmpDir);

      stageOperators(tmpDir, {
        source_step: 'turn_illegal',
        ops: [
          {
            op: 'ASSERT',
            id: 'D99',
            scope: 'global',
            key: 'forbidden_id',
            option_code: 'x',
            summary: 'Model invented ID'
          },
          {
            op: 'ASSERT',
            scope: 'local',
            key: 'debug_port',
            option_code: '9229',
            summary: 'Local scope rule'
          }
        ]
      });

      const res = commitStaged(tmpDir);
      assert.equal(res.committed, false);
      assert.equal(res.conflict, false);
      assert.equal(res.all_rejected, true);
      assert.equal(res.failed_proposal_id, 'stg_1');
      assert.equal(res.rejected_ops.length, 2);

      // head.json and ledger.jsonl must remain untouched
      assert.equal(readHead(tmpDir).revision, 0);
      assert.equal(readLedgerLog(tmpDir).length, 0);

      // Proposal remains in staged.json with last_rejected_ops populated
      const staged = readStaged(tmpDir);
      assert.equal(staged.proposals.length, 1);
      assert.equal(staged.proposals[0].last_rejected_ops.length, 2);
      assert.equal(staged.proposals[0].last_rejected_ops[0].error, 'model_invented_id_forbidden');
      assert.equal(
        staged.proposals[0].last_rejected_ops[1].error,
        'assert_non_global_scope_rejected'
      );
    });
  });

  test('detects head.json tampering via replayLedger and repairs it deterministically from ledger.jsonl', () => {
    withTempWorkspace(tmpDir => {
      initCairnStore(tmpDir);
      stageOperators(tmpDir, {
        source_step: 'turn_1',
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'db_engine',
            option_code: 'postgres_16',
            summary: 'PostgreSQL 16'
          }
        ]
      });
      commitStaged(tmpDir);

      const paths = resolveCairnPaths(tmpDir);
      // Corrupt head.json on disk
      writeJsonAtomic(paths.headFile, {
        revision: 99,
        last_actor_id: 'tampered',
        next_decision_num: 10,
        next_question_num: 1,
        active: [],
        tombstones: [],
        open_questions: []
      });

      const checkBroken = replayLedger(tmpDir);
      assert.equal(checkBroken.valid, false);
      assert.equal(checkBroken.head_matches, false);
      assert.equal(checkBroken.mismatch_reason, 'head_json_diverged_from_ledger_jsonl');

      const repaired = replayLedger(tmpDir, { repairHead: true });
      assert.equal(repaired.valid, true);
      assert.equal(repaired.repaired, true);
      assert.equal(readHead(tmpDir).revision, 1);
      assert.equal(readHead(tmpDir).active[0].id, 'D1');
    });
  });

  test('manages tasks/index.json, numeric task threads (.cairn/tasks/<id>/thread.jsonl), and task-local compact.md', () => {
    withTempWorkspace(tmpDir => {
      initCairnStore(tmpDir);

      // Auto-creates task 2 and task 1 out of order, keeps tasks/index.json sorted by id ascending
      appendTaskTurn(tmpDir, {
        task_id: 2,
        turn: 4,
        role: 'user',
        content: 'Migrate cursor pagination for inventory endpoint'
      });
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 1,
        role: 'user',
        content: 'Refactor JWT auth middleware'
      });
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 2,
        role: 'assistant',
        content: 'Auth middleware updated to Ed25519.',
        raw_content: 'Auth middleware updated to Ed25519.\n<|task:1|>'
      });

      upsertTask(tmpDir, { id: 1, work_anchor_task_id: 1 });
      writeTaskCompaction(tmpDir, 1, 'Task 1 local summary: updated JWT verifier parameters.');

      const index = readTasksIndex(tmpDir);
      assert.equal(index.work_anchor_task_id, 1);
      assert.deepEqual(
        index.tasks.map(t => t.id),
        [1, 2]
      );
      assert.equal(index.tasks[0].turn_count, 2);
      assert.equal(index.tasks[0].has_compact, true);
      assert.equal(index.tasks[1].birth_turn, 4);

      const t1Thread = readTaskThread(tmpDir, 1);
      assert.equal(t1Thread.length, 2);
      assert.equal(t1Thread[1].raw_content, 'Auth middleware updated to Ed25519.\n<|task:1|>');

      const compactText = readTaskCompaction(tmpDir, 1);
      assert.ok(compactText.includes('Task 1 local summary'));

      const status = getStoreStatus(tmpDir);
      assert.ok(
        status.light_task_catalog.includes(
          '- <|task:1|>: Refactor JWT auth middleware (established turn 1)'
        )
      );
      assert.ok(
        status.light_task_catalog.includes(
          '- <|task:2|>: Migrate cursor pagination for inventory endpoint (established turn 4)'
        )
      );
    });
  });

  test('executes bin/cairn.mjs CLI subcommands (init / status / log / commit / drop / tasks) with correct exit codes', () => {
    withTempWorkspace(tmpDir => {
      const callCli = args => {
        const out = [];
        const err = [];
        const code = runCairnCli([...args, '--cwd', tmpDir], {
          cwd: tmpDir,
          stdout: line => out.push(line),
          stderr: line => err.push(line)
        });
        return { code, stdout: out.join('\n'), stderr: err.join('\n') };
      };

      // 1. cairn init
      const initRes = callCli(['init', '--json']);
      assert.equal(initRes.code, 0);
      assert.equal(JSON.parse(initRes.stdout).initialized, true);

      // 2. Stage a conflict and an illegal proposal to verify CLI exit code 1
      stageOperators(tmpDir, {
        source_step: 'step_1',
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'api_gateway',
            option_code: 'envoy_v3',
            summary: 'Envoy v3 gateway'
          }
        ]
      });
      const commit1 = callCli(['commit']);
      assert.equal(commit1.code, 0);
      assert.ok(commit1.stdout.includes('HEAD is now at revision 1'));

      // Stale proposal (base_revision: 0 when HEAD is 1) -> CLI must exit with code 1
      stageOperators(tmpDir, {
        source_step: 'step_2_stale',
        base_revision: 0,
        ops: [
          {
            op: 'ASSERT',
            scope: 'global',
            key: 'rate_limit',
            option_code: 'token_bucket',
            summary: 'Token bucket limiter'
          }
        ]
      });
      const conflictCli = callCli(['commit']);
      assert.equal(conflictCli.code, 1);
      assert.ok(conflictCli.stderr.includes('base_revision_conflict:expected_0_actual_1'));

      // Rebase via CLI flag `--rebase` -> exits 0
      const rebaseCli = callCli(['commit', '--rebase']);
      assert.equal(rebaseCli.code, 0);
      assert.ok(rebaseCli.stdout.includes('HEAD is now at revision 2'));

      // All-rejected proposal -> CLI exits 1, then drop via CLI `cairn drop`
      stageOperators(tmpDir, {
        source_step: 'step_3_bad',
        ops: [{ op: 'ASSERT', scope: 'local', key: 'bad', option_code: '1', summary: 'Bad' }]
      });
      const badCli = callCli(['commit']);
      assert.equal(badCli.code, 1);
      assert.ok(badCli.stderr.includes('all operators rejected'));

      const dropCli = callCli(['drop', 'stg_3']);
      assert.equal(dropCli.code, 0);
      assert.ok(dropCli.stdout.includes('Dropped 1 staged proposal(s)'));

      // 3. Verify `cairn log`, `cairn tasks`, and `cairn status` via child process spawnSync
      appendTaskTurn(tmpDir, {
        task_id: 1,
        turn: 1,
        role: 'user',
        content: 'Configure Envoy rate limit filter'
      });

      const procStatus = spawnSync(
        process.execPath,
        [CLI_BIN_PATH, 'status', '--cwd', tmpDir, '--json'],
        { encoding: 'utf8' }
      );
      assert.equal(procStatus.status, 0);
      const statusJson = JSON.parse(procStatus.stdout);
      assert.equal(statusJson.head.revision, 2);
      assert.equal(statusJson.integrity.valid, true);
      assert.equal(statusJson.tasks_index.tasks.length, 1);

      const procLog = callCli(['log']);
      assert.equal(procLog.code, 0);
      assert.ok(procLog.stdout.includes('commit #1'));
      assert.ok(procLog.stdout.includes('commit #2'));

      const procTasks = callCli(['tasks']);
      assert.equal(procTasks.code, 0);
      assert.ok(procTasks.stdout.includes('<|task:1|>: Configure Envoy rate limit filter'));
    });
  });

  test('Hub status matches doctor initialization truth without initializing an empty Hub', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-status-cli-'));
    const hubRoot = path.join(tmpDir, 'hub');
    const runJson = args => {
      const output = [];
      const code = runCairnCli(args, { stdout: value => output.push(value), stderr: value => output.push(value) });
      const json = output.find(value => value.startsWith('{'));
      return { code, value: json ? JSON.parse(json) : null };
    };
    try {
      const statusBefore = runJson(['status', '--store', hubRoot, '--json']);
      const doctorBefore = runJson(['doctor', '--store', hubRoot, '--json']);
      assert.equal(statusBefore.code, 0);
      assert.equal(statusBefore.value.initialized, false);
      assert.equal(doctorBefore.value.hub_initialized, false);
      assert.equal(fs.existsSync(hubRoot), false);

      assert.equal(runCairnCli(['init', '--store', hubRoot], { stdout: () => {}, stderr: () => {} }), 0);
      const statusAfter = runJson(['status', '--store', hubRoot, '--json']);
      const doctorAfter = runJson(['doctor', '--store', hubRoot, '--json']);
      assert.equal(statusAfter.code, 0);
      assert.equal(statusAfter.value.initialized, true);
      assert.equal(doctorAfter.value.hub_initialized, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
