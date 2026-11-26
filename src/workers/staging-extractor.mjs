// Cairn Workers: Out-of-Band Asynchronous State Operator Extractor (src/workers/staging-extractor.mjs)
// Reads read-only HEAD snapshot, distills turn trajectory, calls buildStagingExtractorPrompt,
// parses strictly via JSON.parse (zero markdown fence strippers), pre-checks operators via
// in-memory foldLedger (sanitizing partial valid batches and rejecting all-illegal batches),
// and stages accepted operators bound to the pre-extraction base_revision.

import {
  isCairnInitialized,
  initCairnStore,
  readHead,
  projectReadOnlyLedger,
  foldLedger,
  stageOperators
} from '../kernel/index.mjs';
import { buildStagingExtractorPrompt } from '../i18n/contracts.mjs';
import { pick } from '../i18n/locale.mjs';
import { createOpenAICompatibleClient } from './llm-client.mjs';
import { distillTurnTrajectory } from './distill.mjs';

export async function runStagingExtractor({
  workspaceRoot = process.cwd(),
  turnInput = {},
  source_step = null,
  actor_id = 'default',
  llmClient = null,
  distillOptions = {},
  reasoningEffort,
  signal
} = {}) {
  if (!isCairnInitialized(workspaceRoot)) {
    initCairnStore(workspaceRoot);
  }

  // 1. Lock pre-extraction HEAD revision & read-only snapshot
  const head = readHead(workspaceRoot);
  const baseRevision = head.revision;
  const readOnlyHead = projectReadOnlyLedger(head, { includeTombstones: true });

  // 2. Distill turn trajectory
  const distilled = distillTurnTrajectory(turnInput, distillOptions);
  const effectiveSourceStep =
    typeof source_step === 'string' && source_step.trim()
      ? source_step.trim()
      : turnInput.turn !== undefined && turnInput.turn !== null
        ? `turn_${turnInput.turn}`
        : `step_${baseRevision + 1}`;

  // 3. Build prompt & call LLM
  const systemPrompt = buildStagingExtractorPrompt(readOnlyHead);
  const userContent = pick('### 最新单步对话（latest_step_dialogue）', '### Latest turn (latest_step_dialogue)') + '\n' + distilled.distilled_text;

  const client = llmClient ?? createOpenAICompatibleClient();
  const llmRes = await client.complete({
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    temperature: 0,
    reasoningEffort,
    signal
  });

  if (!llmRes.ok) {
    return {
      ok: false,
      stage_status: 'transport_error',
      staged: false,
      proposal: null,
      ops: [],
      precheck_rejected_ops: [],
      base_revision: baseRevision,
      error_code: llmRes.error_code,
      error: llmRes.error_message,
      distill_stats: distilled.stats
    };
  }

  // 4. Strict JSON parsing (Path 1 discipline: forbid markdown code fences & output repairers)
  const rawTrimmed = String(llmRes.content ?? '').trim();
  if (rawTrimmed.startsWith('```')) {
    return {
      ok: false,
      stage_status: 'invalid_json_output',
      staged: false,
      proposal: null,
      ops: [],
      precheck_rejected_ops: [],
      base_revision: baseRevision,
      error_code: 'markdown_fence_forbidden',
      error: 'Extractor output wrapped in Markdown code fence is strictly forbidden',
      raw_output: llmRes.content,
      distill_stats: distilled.stats
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawTrimmed);
  } catch (err) {
    return {
      ok: false,
      stage_status: 'invalid_json_output',
      staged: false,
      proposal: null,
      ops: [],
      precheck_rejected_ops: [],
      base_revision: baseRevision,
      error_code: 'strict_json_parse_failed',
      error: err.message,
      raw_output: llmRes.content,
      distill_stats: distilled.stats
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.ops)) {
    return {
      ok: false,
      stage_status: 'invalid_json_output',
      staged: false,
      proposal: null,
      ops: [],
      precheck_rejected_ops: [],
      base_revision: baseRevision,
      error_code: 'missing_ops_array',
      error: 'Extractor JSON must be an object containing an "ops" array',
      raw_output: llmRes.content,
      distill_stats: distilled.stats
    };
  }

  // 5. Fast-path NO_OP (`{"ops":[]}`)
  if (parsed.ops.length === 0) {
    return {
      ok: true,
      stage_status: 'no_op',
      staged: false,
      proposal: null,
      ops: [],
      precheck_rejected_ops: [],
      base_revision: baseRevision,
      distill_stats: distilled.stats
    };
  }

  // 6. Kernel dry-run pre-check against locked `head`:
  //    - If all operators are rejected, return error and never pollute `.cairn/staged.json`.
  //    - If partially valid, sanitize to stage only `accepted_ops` while returning `precheck_rejected_ops`.
  const dryFold = foldLedger(head, parsed.ops, {
    source_step: effectiveSourceStep,
    actor_id,
    base_revision: baseRevision
  });

  if (dryFold.accepted_ops.length === 0) {
    return {
      ok: false,
      stage_status: 'operators_rejected_by_kernel',
      staged: false,
      proposal: null,
      ops: [],
      precheck_rejected_ops: dryFold.rejected_ops,
      base_revision: baseRevision,
      error_code: 'all_operators_rejected_in_precheck',
      error: `All ${dryFold.rejected_count} extracted operator(s) rejected by kernel pre-check`,
      distill_stats: distilled.stats
    };
  }

  const sanitizedOps = dryFold.accepted_ops.map(a => a.op);
  const stageRes = stageOperators(workspaceRoot, {
    ops: sanitizedOps,
    source_step: effectiveSourceStep,
    actor_id,
    base_revision: baseRevision
  });

  return {
    ok: true,
    stage_status: 'staged',
    staged: stageRes.staged,
    proposal: stageRes.proposal,
    ops: sanitizedOps,
    precheck_rejected_ops: dryFold.rejected_ops,
    base_revision: baseRevision,
    distill_stats: distilled.stats
  };
}
