#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCairnCliAsync } from '../src/commands/run-cairn.mjs';

export { runCairnCli, runCairnCliAsync } from '../src/commands/run-cairn.mjs';

// npm creates a symlink in .bin on POSIX. An import from stdin may instead
// have a non-file argv[1] (e.g. "-"); importing the command must not run it.
let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); }
catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
if (entry && entry === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCairnCliAsync();
}
