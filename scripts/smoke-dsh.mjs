// Optional integration test: node scripts/smoke-dsh.mjs /path/to/dsh/lib/bin.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHubTaskThread, readHubTasksIndex, readScopedHead, readSessionBinding } from '../src/kernel/hub-store.mjs';

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
function run(phase, input, sessionId, workdir = cwd, expectedExit = 0) {
  const args = [bin, '--profile', 'headless', '--patch', patch, ...(sessionId ? ['--session-id', sessionId] : []), input];
  const res = spawnSync(process.execPath, args, { cwd: workdir, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...env, DSH_HOME: path.join(tmp, 'dsh'), CAIRN_DSH_BIN: bin, CAIRN_SMOKE_PHASE: phase, CAIRN_SMOKE_TRACE: trace } });
  assert.equal(res.status, expectedExit, res.error?.message ?? (res.stderr + res.stdout));
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
  const original = '继续，把失败的测试修掉';
  run('picker-native', original);
  const native = entries().filter(e => e.phase === 'picker-native');
  assert.equal(native[0].event, 'human-choice');
  assert.equal(native.find(e => e.snapshot)?.snapshot.task, 1);
  assert.ok(native.some(e => e.event === 'verify-tool'), 'selection must proceed to verification, not another question');
  const before = readHubTaskThread(hub, 1).length;
  const menu = run('picker-menu', original);
  assert.match(menu, /CSV export/u);
  assert.doesNotMatch(menu, /<\|task:/u);
  assert.equal(entries().filter(e => e.phase === 'picker-menu' && (e.snapshot || e.event === 'verify-tool')).length, 0);
  assert.equal(readHubTaskThread(hub, 1).length, before);
  run('picker-reply', 'CSV 那个', entries().find(e => e.menuSession).menuSession);
  assert.ok(entries().some(e => e.phase === 'picker-reply' && e.event === 'verify-tool'));
  assert.equal(readHubTaskThread(hub, 1).at(-2).content, original);
  const review = run('memory-offer', '所有项目默认中文，但这个项目用英文。', id);
  assert.match(review, /长期记忆尚未生效/u);
  const token = /(\d+)\.1「所有项目默认中文」/u.exec(review)?.[1];
  assert.ok(token, review);
  assert.deepEqual(entries().filter(e => e.phase === 'memory-offer' && e.draft).map(e => e.draft),
    ['所有项目默认中文', '这个项目用英文']);
  assert.equal(readScopedHead(hub).revision, 0);
  assert.equal(readHubTaskThread(hub, 1).at(-1).content, 'Done');
  assert.match(run('memory-user', '记忆 ' + token + '.1 所有项目', id), /已生效/u);
  assert.match(run('memory-project', '记忆 ' + token + '.2 仅本项目', id), /已生效/u);
  assert.equal(entries().some(e => ['memory-user', 'memory-project'].includes(e.phase) && e.snapshot), false);
  assert.equal(readScopedHead(hub).active[0].option_code, 'zh');
  assert.equal(readScopedHead(hub, { scope: 'project', projectId }).active.find(d => d.key === 'reply_language').option_code, 'en');
  run('memory-same', 'Check the preference in this checkout.', id);
  const other = path.join(tmp, 'second-repo');
  fs.mkdirSync(other);
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: other, windowsHide: true }).status, 0);
  run('memory-other', 'New task: list available workflows.', null, other);
  assert.deepEqual(entries().filter(e => e.preference).map(e => e.preference),
    [{ user: 'zh', project: 'en' }, { user: 'zh', project: null }]);
  const priorRecords = readHubTaskThread(hub, 1).length;
  const binding = readSessionBinding(hub, id);
  const input = 'Inspect the current CSV output.';
  run('handoff-crash', input, id, cwd, 23);
  const preview = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url)),
    'checkout', '1', '--preview', '--json', '--store', hub], { encoding: 'utf8', windowsHide: true });
  assert.equal(preview.status, 0, preview.stderr);
  const { work_state: packet, total_record_count } = JSON.parse(preview.stdout);
  const [pending] = packet.pending_turns;
  assert.equal(packet.pending_count, 1);
  assert.equal(pending.source.session_id, id);
  assert.deepEqual(pending.source, entries().find(e => e.nativeResult)?.nativeResult);
  assert.ok(Number.isSafeInteger(pending.source.journal_seq));
  assert.equal(pending.turn_status, 'in_progress');
  assert.equal(pending.request_excerpt, input);
  assert.equal(pending.last_tool.name, 'probe_csv');
  assert.equal(pending.last_tool.ok, false);
  assert.match(pending.last_tool.output, /CSV_HEADER_EXPECTED/u);
  assert.equal(pending.disposition, 'verify_before_retry');
  assert.equal(packet.task.status, 'active');
  assert.ok(packet.authority.project.active.some(d => d.option_code === 'pnpm'));
  assert.ok(packet.authority.project.tombstones.some(d => d.option_code === 'npm'));
  assert.equal(total_record_count, priorRecords);
  assert.deepEqual(readSessionBinding(hub, id), binding);
  assert.equal(entries().filter(e => e.phase === 'handoff-crash' && e.event === 'verify-tool').length, 1);
  console.log('PASS: dsh exited after the tool result, before turn/end; an independent CLI checkout retained evidence, not a completion or retry.');
  console.log('PASS: memory review follows the answer, survives restart, and injects the project exception only in its own checkout.');
  console.log('PASS: real dsh tool failure, Project supersession, native compaction, restart and natural-language checkout (offline provider).');
  console.log('PASS: native userQuestions selection and restarted text fallback; no business request before selection, original verification runs after selection.');
} finally {
  if (path.dirname(tmp) === fs.realpathSync(os.tmpdir()) && path.basename(tmp).startsWith('cairn-live-')) fs.rmSync(tmp, { recursive: true, force: true });
}
