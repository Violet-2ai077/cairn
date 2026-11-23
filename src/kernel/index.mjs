// Cairn Kernel Public Surface (src/kernel/index.mjs)
// Deterministic, zero-LLM, host-agnostic primitives validated by ACMI Path 1 (484 ablation calls).

export {
  VALID_OP_TYPES,
  freezeDeep,
  createEmptyLedger,
  foldLedger,
  projectReadOnlyLedger
} from './ledger.mjs';

export { foldScopedLedger } from './scoped-ledger.mjs';

export {
  parseTaskMarker,
  stripTaskMarker,
  buildLightTaskCatalog,
  buildHubTaskCatalog
} from './marker.mjs';

export {
  buildAntiRecencyContract,
  buildStagingExtractorPrompt,
  buildStrictCompactorPrompt,
  buildAuthorityCheckoutContract,
  buildScopedAuthorityContract,
  buildScopedStagingExtractorPrompt
} from './contracts.mjs';

export {
  resolveHubPaths,
  isHubInitialized,
  initHubStore,
  readProjectsIndex,
  registerProject,
  ensureScopedLedger,
  readScopedHead,
  readScopedLedgerLog,
  readScopedStaged,
  stageScopedOperators,
  commitScopedStaged,
  dropScopedStaged,
  replayScopedLedger,
  syncScopedLedger,
  revertScopedCommit,
  readHubTasksIndex,
  upsertHubTask,
  appendHubTaskTurn,
  appendHubTaskTurnPair,
  readHubTaskThread,
  readHubTaskCompaction,
  writeHubTaskCompaction,
  readSessionBinding,
  writeSessionBinding,
  clearSessionBinding,
  transitionHubTaskStatus,
  normalizeProjectId,
  validateLedgerScope
} from './hub-store.mjs';

export {
  writeTextAtomic,
  writeJsonAtomic,
  resolveCairnPaths,
  normalizeTaskId,
  isCairnInitialized,
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
  transitionTaskStatus,
  appendTaskTurn,
  readTaskThread,
  writeTaskCompaction,
  readTaskCompaction,
  getStoreStatus
} from './store.mjs';
