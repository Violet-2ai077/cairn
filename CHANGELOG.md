# Changelog

## 0.4.3 - 2026-11-26

- Document the verified source installation and the default dsh Hub entrypoints.
- Reject empty or incomplete Git metadata, including invalid worktree pointers.
- Recognize top-level Markdown fences by line, delimiter and closing length when
  validating a task marker; inline mentions are not fence openers.
- Share command dispatch between the CLI and workspace adapter without importing the executable.
- Fail fast on a contended dsh snapshot or retryable operator write, without
  serving stale data. Durable turn archival keeps its bounded write wait.
- Select English or Chinese runtime prompts and task/memory dialogs from the
  process locale, with an explicit `CAIRN_LOCALE` override. Task IDs, ledger
  operators and stored user-authored content are not translated.
- Distribute under MIT with an explicit license file. GitHub release archives
  are the distribution channel, not the unrelated public npm package.
