# dsh memory scope and consent

**Goal:** Complete the current business turn without waiting for a memory decision.
The scope of a task and the scope of a preference are independent.

- [x] Split the three accepted examples into turn-only instructions, scoped
  preferences and unresolved preferences. Only authored clauses are eligible.
- [x] Prepare one restricted ASSERT draft per preference after confirmed task
  archival. Keep it out of authoritative context until a session-bound human
  reply confirms that particular draft and scope. Preserve normal extraction
  for unrelated project decisions.
- [x] Present a non-blocking notice after the final answer, and support reviewing,
  confirming and skipping from the original dsh session after process restart.
- [x] Check wrong scope, replay, stale revisions, mixed/quoted inputs, clean task
  history and cross-project checkout. Run the full Node suite and real dsh smoke.

Use the existing Hub lock, staging and fold. No new dependencies, automatic
User commits, preference replacements or relevance retrieval in this slice.
