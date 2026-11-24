// Optional integration test: node scripts/smoke-dsh.mjs /path/to/dsh/lib/bin.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHubTaskThread, readHubTasksIndex, readScopedHead } from '../src/kernel/hub-store.mjs';

const requested = process.argv[2] ?? process.env.DSH_BIN;
if (!requested) throw new Error('Pass the installed dsh/lib/bin.js path, or set DSH_BIN.');
const bin = fs.realpathSync(requested);
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cairn-live-'));
const cwd = path.join(tmp, 'repo');
const hub = path.join(tmp, 'hub');
const patch = path.join(tmp, 'patch.yml');
const trace = path.join(tmp, 'trace.jsonl');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|programfiles.*|systemdrive|lang)$/iu.test(k)));
const entries = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(s => JSON.parse(s));
function run(phase, input, sessionId) {
  const args = [bin, '--profile', 'headless', '--patch', patch, ...(sessionId ? ['--session-id', sessionId] : []), input];
  const res = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...env, DSH_HOME: path.join(tmp, 'dsh'), CAIRN_DSH_BIN: bin, CAIRN_SMOKE_PHASE: phase, CAIRN_SMOKE_TRACE: trace } });
  assert.equal(res.status, 0, res.error?.message ?? (res.stderr + res.stdout));
  return res.stdout;
}
try {
  fs.mkdirSync(cwd);
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd, windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(cwd, 'csv.test.cjs'), "require('node:test')('csv-header', () => require('node:assert/strict').equal('wrong', 'CSV_HEADER_EXPECTED'));");
  const url = name => new URL(name, import.meta.url).href;
  fs.writeFileSync(patch, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'cairn-offline', model: 'fixture' } },
    { id: 'compaction-basic', config: { retainTokens: 1, headroomTokens: 1024 } },
    { insert: [
      { id: 'cairn-smoke-provider', name: url('./fixtures/dsh-offline-provider.mjs') },
      { id: 'cairn', name: url('../src/hosts/dsh/index.mjs'), config: { storeRoot: hub, autopilot: { enabled: true } } }
    ] }
  ]));
  run('a', 'Investigate CSV export.\nUse npm');
  const id = entries().find(e => e.sessionId).sessionId;
  const projectId = readHubTasksIndex(hub).tasks[0].project_id;
  assert.ok(projectId);
  assert.equal(readScopedHead(hub, { scope: 'project', projectId }).active[0]?.option_code, 'npm');
  assert.match(JSON.stringify(readHubTaskThread(hub, 1).at(-1).meta.tools), /CSV_HEADER_EXPECTED/);
  run('b', 'New task: change the project test runner.\nUse pnpm', id);
  const head = readScopedHead(hub, { scope: 'project', projectId });
  assert.equal(head.active[0]?.option_code, 'pnpm');
  assert.equal(head.tombstones[0]?.option_code, 'npm');
  run('compact', 'Confirm the current rule.', id);
  const claim = entries().find(e => e.recovered);
  assert.equal(claim?.recovered, 'success', claim?.recoveryMessage);
  assert.equal(readHubTaskThread(hub, 2).at(-1).meta.attribution, 'manual_recovery');
  assert.ok(entries().some(e => e.shadowed > 0));
  assert.ok(entries().some(e => e.nativeBoundary));
  run('resume', 'Back to the CSV export issue from yesterday.', id);
  assert.deepEqual(entries().find(e => e.phase === 'resume' && e.snapshot)?.snapshot,
    { task: 1, blocker: true, current: true, superseded: true });
  assert.equal(readHubTaskThread(hub, 1).at(-2).content, 'Back to the CSV export issue from yesterday.');
  console.log('PASS: real dsh tool failure, Project supersession, native compaction, restart and natural-language checkout (offline provider).');
} finally {
  if (path.dirname(tmp) === fs.realpathSync(os.tmpdir()) && path.basename(tmp).startsWith('cairn-live-')) fs.rmSync(tmp, { recursive: true, force: true });
}
