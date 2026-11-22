// Cairn Kernel Public Surface (src/kernel/index.mjs)
// Deterministic, zero-LLM, host-agnostic primitives validated by ACMI Path 1 (484 ablation calls).

export {
  VALID_OP_TYPES,
  freezeDeep,
  createEmptyLedger,
  foldLedger,
  projectReadOnlyLedger
} from './ledger.mjs';

export {
  parseTaskMarker,
  stripTaskMarker,
  buildLightTaskCatalog
} from './marker.mjs';

export {
  buildAntiRecencyContract,
  buildStagingExtractorPrompt,
  buildStrictCompactorPrompt,
  buildAuthorityCheckoutContract
} from './contracts.mjs';
