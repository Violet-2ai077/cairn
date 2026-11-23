import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_OP_TYPES,
  createEmptyLedger,
  foldLedger,
  projectReadOnlyLedger,
  parseTaskMarker,
  stripTaskMarker,
  buildLightTaskCatalog,
  buildHubTaskCatalog,
  buildAntiRecencyContract,
  buildStagingExtractorPrompt,
  buildStrictCompactorPrompt,
  buildAuthorityCheckoutContract
} from '../src/kernel/index.mjs';

describe('Cairn Kernel 1: Workspace State Ledger & Folding Engine (src/kernel/ledger.mjs)', () => {
  test('folds multi-hop legal transitions (ASSERT -> SUPERSEDE -> OPEN_QUESTION -> NO_OP -> SUPERSEDE + RESOLVE_QUESTION)', () => {
    assert.deepEqual(VALID_OP_TYPES, ['ASSERT', 'SUPERSEDE', 'OPEN_QUESTION', 'RESOLVE_QUESTION']);
    const l0 = createEmptyLedger();
    assert.equal(l0.revision, 0);
    assert.equal(l0.last_actor_id, null);

    // Step 1: ASSERT D1 (default actor_id = "default")
    const f1 = foldLedger(
      l0,
      [
        {
          op: 'ASSERT',
          scope: 'global',
          key: 'cache_strategy',
          option_code: 'local_lru',
          summary: 'In-process LRU cache'
        }
      ],
      { source_step: 'step_1' }
    );
    assert.equal(f1.conflict, false);
    assert.equal(f1.rejected_count, 0);
    assert.equal(f1.ledger.revision, 1);
    assert.equal(f1.ledger.last_actor_id, 'default');
    assert.equal(f1.ledger.active[0].id, 'D1');
    assert.equal(f1.ledger.active[0].actor_id, 'default');

    // Step 2: SUPERSEDE D1 -> D2 + OPEN_QUESTION Q1 with explicit actor_id and matching base_revision
    const f2 = foldLedger(
      f1.ledger,
      [
        {
          op: 'SUPERSEDE',
          target_id: 'D1',
          option_code: 'redis_ttl',
          summary: 'Centralized Redis TTL cache',
          reason: 'stale_read_14pct under multi-replica writes'
        },
        {
          op: 'OPEN_QUESTION',
          key: 'failover_grace_window',
          summary: 'Grace window during Redis failover'
        }
      ],
      { source_step: 'step_2', actor_id: 'worker-arch', base_revision: 1 }
    );
    assert.equal(f2.conflict, false);
    assert.equal(f2.rejected_count, 0);
    assert.equal(f2.ledger.revision, 3);
    assert.equal(f2.ledger.last_actor_id, 'worker-arch');
    assert.equal(f2.ledger.active.length, 1);
    assert.equal(f2.ledger.active[0].id, 'D2');
    assert.equal(f2.ledger.active[0].option_code, 'redis_ttl');
    assert.equal(f2.ledger.active[0].actor_id, 'worker-arch');
    assert.equal(f2.ledger.tombstones.length, 1);
    assert.equal(f2.ledger.tombstones[0].id, 'D1');
    assert.equal(f2.ledger.tombstones[0].superseded_by, 'D2');
    assert.equal(f2.ledger.open_questions.length, 1);
    assert.equal(f2.ledger.open_questions[0].id, 'Q1');
    assert.equal(f2.ledger.open_questions[0].status, 'open');

    // Step 3: NO_OP
    const f3 = foldLedger(f2.ledger, [], { source_step: 'step_3', base_revision: 3 });
    assert.equal(f3.conflict, false);
    assert.equal(f3.ledger.revision, 3);

    // Step 4: SUPERSEDE D2 -> D3 + RESOLVE_QUESTION Q1
    const f4 = foldLedger(
      f3.ledger,
      [
        {
          op: 'SUPERSEDE',
          target_id: 'D2',
          option_code: 'versioned_etag',
          summary: 'L1 cache with versioned ETag invalidation',
          reason: 'p99_840ms serialization latency on redis_ttl'
        },
        {
          op: 'RESOLVE_QUESTION',
          target_id: 'Q1',
          resolution: '200ms replay buffer verified in failover test'
        }
      ],
      { source_step: 'step_4', actor_id: 'worker-qa', base_revision: 3 }
    );
    assert.equal(f4.conflict, false);
    assert.equal(f4.rejected_count, 0);
    assert.equal(f4.ledger.revision, 5);
    assert.equal(f4.ledger.last_actor_id, 'worker-qa');
    assert.equal(f4.ledger.active[0].id, 'D3');
    assert.equal(f4.ledger.tombstones.length, 2);
    assert.equal(f4.ledger.open_questions[0].status, 'resolved');

    const fullSnapshot = projectReadOnlyLedger(f4.ledger, { includeTombstones: true });
    assert.equal(fullSnapshot.tombstones.length, 2);
    const strippedSnapshot = projectReadOnlyLedger(f4.ledger, { includeTombstones: false });
    assert.equal('tombstones' in strippedSnapshot, false);
  });

  test('detects base_revision optimistic concurrency conflicts without mutating ledger', () => {
    const l0 = createEmptyLedger();
    const f1 = foldLedger(
      l0,
      [
        {
          op: 'ASSERT',
          scope: 'global',
          key: 'lock_strategy',
          option_code: 'fencing_token_cas',
          summary: 'Fencing token CAS'
        }
      ],
      { source_step: 'step_1', actor_id: 'agent-1', base_revision: 0 }
    );
    assert.equal(f1.conflict, false);
    assert.equal(f1.ledger.revision, 1);

    // Stale agent-2 tries to commit against base_revision: 0 when current revision is 1
    const staleAttempt = foldLedger(
      f1.ledger,
      [
        {
          op: 'ASSERT',
          scope: 'global',
          key: 'retry_policy',
          option_code: 'durable_outbox',
          summary: 'Outbox'
        }
      ],
      { source_step: 'step_2_stale', actor_id: 'agent-2', base_revision: 0 }
    );
    assert.equal(staleAttempt.conflict, true);
    assert.equal(staleAttempt.conflict_error, 'base_revision_conflict:expected_0_actual_1');
    assert.equal(staleAttempt.accepted_ops.length, 0);
    assert.equal(staleAttempt.rejected_count, 1);
    assert.equal(staleAttempt.ledger.revision, 1);
    assert.equal(staleAttempt.ledger.active.length, 1);
  });

  test('rejects all 7 categories of illegal operator transitions without silent repair', () => {
    const l0 = createEmptyLedger();
    const f1 = foldLedger(l0, [
      {
        op: 'ASSERT',
        scope: 'global',
        key: 'cache_strategy',
        option_code: 'local_lru',
        summary: 'Initial'
      }
    ]);
    const f2 = foldLedger(f1.ledger, [
      {
        op: 'SUPERSEDE',
        target_id: 'D1',
        option_code: 'redis_ttl',
        summary: 'Second',
        reason: 'stale_read_14pct'
      },
      {
        op: 'OPEN_QUESTION',
        key: 'q_key',
        summary: 'Open question'
      }
    ]);
    const f3 = foldLedger(f2.ledger, [
      {
        op: 'RESOLVE_QUESTION',
        target_id: 'Q1',
        resolution: 'Resolved'
      }
    ]);

    const illegalBatch = [
      { op: 'ASSERT', id: 'D99', scope: 'global', key: 'k', option_code: 'v', summary: 'Invented ID' },
      { op: 'ASSERT', scope: 'local', key: 'local_port', option_code: '9229', summary: 'Local scope' },
      { op: 'ASSERT', scope: 'global', key: 'cache_strategy', option_code: 'x', summary: 'Duplicate active key' },
      { op: 'SUPERSEDE', target_id: 'D1', option_code: 'y', summary: 'Already tombstoned', reason: 'r' },
      { op: 'SUPERSEDE', target_id: 'D404', option_code: 'z', summary: 'Missing D', reason: 'r' },
      { op: 'RESOLVE_QUESTION', target_id: 'Q1', resolution: 'Already resolved' },
      { op: 'RESOLVE_QUESTION', target_id: 'Q404', resolution: 'Missing Q' }
    ];

    const res = foldLedger(f3.ledger, illegalBatch);
    assert.equal(res.accepted_ops.length, 0);
    assert.equal(res.rejected_count, 7);
    assert.equal(res.ledger.revision, f3.ledger.revision);
  });
});

describe('Cairn Kernel 2: Closed-Fence-Aware Inline Task Marker Parser (src/kernel/marker.mjs)', () => {
  test('parses and strips standard <|task:N|> and <|task:UNRESOLVED|> markers', () => {
    const raw1 = '已完成配置更新。\n<|task:12|>';
    const p1 = parseTaskMarker(raw1);
    assert.equal(p1.valid, true);
    assert.equal(p1.marker, '12');
    assert.equal(p1.task_number, 12);
    assert.equal(p1.is_unresolved, false);
    assert.equal(p1.closed_fence_before_marker, false);
    assert.equal(p1.display_text, '已完成配置更新。');
    assert.equal(stripTaskMarker(raw1), '已完成配置更新。');

    const rawUnres = '该请求同时匹配任务 1 与任务 2，请确认要修改哪一项？\n<|task:UNRESOLVED|>';
    const pUnres = parseTaskMarker(rawUnres);
    assert.equal(pUnres.valid, true);
    assert.equal(pUnres.marker, 'UNRESOLVED');
    assert.equal(pUnres.is_unresolved, true);
    assert.equal(pUnres.task_number, null);
    assert.equal(stripTaskMarker(rawUnres), '该请求同时匹配任务 1 与任务 2，请确认要修改哪一项？');
  });

  test('accepts tail marker on its own trailing line immediately after a CLOSED Markdown code fence (TC5-B t3 fix)', () => {
    const sqlWithClosedFence = [
      '对应查询语句如下：',
      '```sql',
      'SELECT sku, qty, updated_at',
      'FROM inventory_stock',
      'WHERE qty > 0;',
      '```',
      '<|task:1|>'
    ].join('\n');

    const parsed = parseTaskMarker(sqlWithClosedFence);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.marker, '1');
    assert.equal(parsed.task_number, 1);
    assert.equal(parsed.closed_fence_before_marker, true);
    assert.ok(parsed.display_text.endsWith('```'));
    assert.ok(!parsed.display_text.includes('<|task:1|>'));
    assert.equal(stripTaskMarker(sqlWithClosedFence), parsed.display_text);
  });

  test('rejects tail marker trapped inside an UNCLOSED Markdown code fence or glued to closing fence line', () => {
    const unclosedFence = [
      '```sql',
      'SELECT * FROM stock;',
      '<|task:1|>'
    ].join('\n');
    const pUnclosed = parseTaskMarker(unclosedFence);
    assert.equal(pUnclosed.valid, false);
    assert.equal(pUnclosed.error, 'marker_inside_unclosed_code_fence');

    const wrappedInsideClosedFence = [
      '```sql',
      'SELECT * FROM stock;',
      '<|task:1|>',
      '```'
    ].join('\n');
    const pWrapped = parseTaskMarker(wrappedInsideClosedFence);
    assert.equal(pWrapped.valid, false);
    assert.equal(pWrapped.error, 'missing_duplicate_or_malformed_marker');

    const gluedToClosingFence = [
      '```sql',
      'SELECT * FROM stock;',
      '``` <|task:1|>'
    ].join('\n');
    const pGlued = parseTaskMarker(gluedToClosingFence);
    assert.equal(pGlued.valid, false);
    assert.equal(pGlued.error, 'marker_not_on_own_line_after_closed_fence');
  });

  test('rejects duplicate, leading-zero, out-of-range, or empty-body markers and formats light task catalog', () => {
    assert.equal(parseTaskMarker('<|task:1|>').valid, false);
    assert.equal(parseTaskMarker('text <|task:0|>').valid, false);
    assert.equal(parseTaskMarker('text <|task:01|>').valid, false);
    assert.equal(parseTaskMarker('text <|task:1000|>').valid, false);
    assert.equal(parseTaskMarker('text <|task:1|> and <|task:2|>').valid, false);

    const catalog = buildLightTaskCatalog([
      { id: 1, title: 'Auth middleware refactor', birth_turn: 1 },
      { id: 2, title: 'Pagination cursor migration', birth_turn: 4 }
    ]);
    assert.ok(catalog.includes('- <|task:1|>: Auth middleware refactor (established turn 1)'));
    assert.ok(catalog.includes('- <|task:2|>: Pagination cursor migration (established turn 4)'));
    const activeOnly = buildLightTaskCatalog([
      { id: 1, title: 'Active task' },
      { id: 2, title: 'Done task', status: 'done' },
      { id: 3, title: 'Archived task', status: 'archived' }
    ]);
    assert.match(activeOnly, /Active task/);
    assert.doesNotMatch(activeOnly, /Done task|Archived task/);
    const hubCatalog = buildHubTaskCatalog([
      { id: 7, title: 'Project task', project_id: 'p_alpha' },
      { id: 8, title: 'General task', project_id: null },
      { id: 9, title: 'Closed task', status: 'done' }
    ]);
    assert.match(hubCatalog, /<\|task:7\|> \[project:p_alpha; id:p_alpha\]/);
    assert.match(hubCatalog, /<\|task:8\|> \[general\]/);
    assert.doesNotMatch(hubCatalog, /Closed task/);
  });
});

describe('Cairn Kernel 3: Parameterized Prompt Contract Builders (src/kernel/contracts.mjs)', () => {
  test('verifies all 4 contract builders contain required mechanism rules and zero hardcoded test corpus leaks', () => {
    const c1 = buildAntiRecencyContract({
      tasks: [{ id: 1, title: 'Cache eviction policy', birth_turn: 1 }],
      workAnchorTaskId: 1
    });
    assert.ok(c1.includes('<|task:N|>'));
    assert.ok(c1.includes('<|task:UNRESOLVED|>'));
    assert.ok(c1.includes('Recency'));
    assert.ok(c1.includes('Primacy'));
    assert.ok(c1.includes('Host-verified WorkAnchor'));

    const head = projectReadOnlyLedger(createEmptyLedger());
    const stagingPrompt = buildStagingExtractorPrompt(head);
    assert.ok(stagingPrompt.includes('{"ops":[...]}'));
    assert.ok(stagingPrompt.includes('ASSERT'));
    assert.ok(stagingPrompt.includes('SUPERSEDE'));
    assert.ok(stagingPrompt.includes('OPEN_QUESTION'));
    assert.ok(stagingPrompt.includes('RESOLVE_QUESTION'));
    assert.ok(stagingPrompt.includes('current_ledger_head'));

    const compactorPrompt = buildStrictCompactorPrompt({ taskId: 2 });
    assert.ok(compactorPrompt.includes('COMPRESSOR_STRICT'));
    assert.ok(compactorPrompt.includes('<|task:2|>'));

    const checkoutPrompt = buildAuthorityCheckoutContract(head);
    assert.ok(checkoutPrompt.includes('RECEIVER_C1'));
    assert.ok(checkoutPrompt.includes('workspace_ledger.active'));
    assert.ok(checkoutPrompt.includes('workspace_ledger.tombstones'));
    assert.ok(checkoutPrompt.includes('workspace_ledger.open_questions'));

    // Ensure zero experimental test-corpus strings leaked into kernel contracts
    const allContractsText = [c1, stagingPrompt, compactorPrompt, checkoutPrompt].join('\n');
    for (const forbiddenToken of ['云栖读书会', '云溪读书会', '溪岸书店', 'M16', 'M94', 'cold_stock', 'ambient_stock']) {
      assert.equal(
        allContractsText.includes(forbiddenToken),
        false,
        `Forbidden test-corpus token "${forbiddenToken}" found in kernel contracts`
      );
    }
  });
});
