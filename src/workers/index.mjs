// Cairn Workers Layer Placeholder (src/workers/index.mjs)
// Low-frequency, out-of-band asynchronous model capabilities:
// 1. staging-extractor: Runs buildStagingExtractorPrompt(head) after committed turns -> staged.json
// 2. strict-compactor: Runs buildStrictCompactorPrompt() on task threads -> tasks/<id>/compact.md
// 3. cold-router: Optional cold-start task candidate retrieval

export const WORKERS_LAYER_STATUS = 'placeholder_ready_for_phase1_implementation';
