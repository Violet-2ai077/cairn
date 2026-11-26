// Optional integration test: node scripts/smoke-dsh.mjs /path/to/dsh/lib/bin.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHubTaskThread, readHubTasksIndex, readScopedHead, readScopedStaged, readSessionBinding, stageScopedOperators } from '../src/kernel/hub-store.mjs';
import { readTaskThread, replayLedger } from '../src/kernel/store.mjs';
import { upsertHubTask, readSessionMarkerBank, readTurnReceipts } from '../src/kernel/hub-store.mjs';

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
  assert.equal(res.status, expectedExit, res.error?.message ?? (res.stderr + res.stdout + (phase === 'file-write-crash' ? JSON.stringify(entries().filter(e => e.phase === phase)) : '')));
  return res.stdout;
}
function verifyWriteCrash(writer, projectId) {
  const priorRecords = readHubTaskThread(hub, 1).length;
  const priorBinding = readSessionBinding(hub, writer);
  const priorHeads = [readScopedHead(hub), readScopedHead(hub, { scope: 'project', projectId })];
  run('file-write-crash', 'Write the requested test artifact.', writer, cwd, 24);
  const cli = (args, code = 0, store = hub) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url)), ...args, '--store', store, '--json'],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, code, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  };
  const written = path.join(cwd, 'effect.txt'), previewWrites = () => cli(['checkout', '1', '--preview']).work_state.file_writes;
  const [intent] = previewWrites();
  assert.ok(intent, 'dsh must publish the intent before the native write');
  const calls = entries().filter(e => e.phase === 'file-write-crash' && e.event);
  assert.deepEqual(calls.map(e => e.event), ['tool/call', 'after-native-write']);
  assert.equal(intent.source.journal_seq, calls[0].seq);
  assert.equal(intent.source.call_id, calls[0].call_id);
  assert.equal(intent.source.session_id, writer);
  assert.equal(intent.relative_path, 'effect.txt');
  assert.equal(intent.last_check, null);
  // The child dsh has exited. Exercise the operator commands, not an in-memory clone of the Hub.
  const bundle = path.join(tmp, 'cold-backup'), restored = path.join(tmp, 'restored-hub');
  const checkoutArgs = ['checkout', '1', '--preview'], original = cli(checkoutArgs);
  assert.equal(cli(['backup', bundle]).ok, true);
  assert.equal(cli(['restore', bundle], 0, restored).ok, true);
  assert.equal(cli(['doctor'], 0, restored).ok, true);
  assert.deepEqual(cli(checkoutArgs, 0, restored), original);
  assert.equal(cli(['verify-write', '1', intent.id], 0, restored).status, 'matches');
  assert.equal(previewWrites()[0].last_check, null, 'restored verification cannot update the original Hub');
  console.log('PASS: cold backup of the stopped dsh Hub restored the same handoff; explicit verification updated only the new Hub.');
  assert.equal(fs.readFileSync(written, 'utf8'), 'exact UTF-8 bytes: \u03bb\r\n');
  const verify = code => cli(['verify-write', '1', intent.id], code);
  assert.equal(verify(0).status, 'matches');
  fs.writeFileSync(written, 'edit by another actor');
  assert.equal(previewWrites()[0].last_check.status, 'matches');
  assert.equal(verify(2).status, 'differs');
  assert.equal(fs.readFileSync(written, 'utf8'), 'edit by another actor');
  fs.unlinkSync(written);
  fs.mkdirSync(written);
  assert.equal(verify(3).status, 'unverifiable');
  assert.ok(fs.statSync(written).isDirectory());
  assert.equal(previewWrites()[0].last_check.status, 'unverifiable');
  assert.equal(readHubTaskThread(hub, 1).length, priorRecords);
  assert.deepEqual(readSessionBinding(hub, writer), priorBinding);
  assert.deepEqual([readScopedHead(hub), readScopedHead(hub, { scope: 'project', projectId })], priorHeads);
  console.log('PASS: native write exited before tool/result; separate CLI checks matched, detected a peer edit and declined a non-file, without replay.');
}
function configure(config) {
  const url = name => new URL(name, import.meta.url).href;
  fs.writeFileSync(patch, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'cairn-offline', model: 'fixture' } },
    { id: 'compaction-basic', config: { retainTokens: 1, headroomTokens: 1024 } },
    { insert: [
      { id: 'cairn-smoke-provider', name: url('./fixtures/dsh-offline-provider.mjs') },
      { id: 'cairn', name: url('../src/hosts/dsh/index.mjs'), config }
    ] }
  ]));
}
function verifyMarkerMatrix() {
  for (const mode of ['hub', 'autopilot', 'legacy']) {
    const storeRoot = path.join(tmp, 'marker-' + mode);
    const config = mode === 'legacy' ? { workspaceRoot: cwd } : { storeRoot };
    if (mode === 'autopilot') config.autopilot = { enabled: true };
    configure(config);
    if (mode === 'hub') stageScopedOperators(storeRoot, { ops: [{ op: 'ASSERT', key: 'scope_check', option_code: 'fixture', summary: 'Scope check' }] });
    const phase = 'marker-' + mode;
    const input = 'Write a two-paragraph progress note.';
    const output = run(phase, input);
    const answer = '  ' + 'Long result '.repeat(9).trimEnd() + '.';
    assert.match(output, /First paragraph\./u);
    assert.match(output, /Long result Long result/u);
    assert.doesNotMatch(output, /<\|task:/u);
    assert.deepEqual(entries().find(e => e.phase === phase && e.markerBlocks)?.markerBlocks, ['First paragraph.', answer]);
    const thread = mode === 'legacy' ? readTaskThread(cwd, 1) : readHubTaskThread(storeRoot, 1);
    assert.deepEqual(thread.map(r => r.content), [input, 'First paragraph.\n' + answer]);
    if (mode === 'legacy') assert.equal(replayLedger(cwd).valid, true);
    if (mode === 'hub') {
      const checks = entries().filter(e => e.phase === phase && e.slash).map(e => [e.slash, e.result]);
      assert.deepEqual(checks, ['commit proj', 'drop proj', 'archive 1', 'unknown'].map(command => [command, 'error']));
      assert.equal(readScopedHead(storeRoot).revision, 0);
      assert.equal(readScopedStaged(storeRoot).proposals.length, 1);
      run('marker-compat-continue', 'Continue the unrecognized deployment task.');
      assert.deepEqual(readHubTasksIndex(storeRoot).tasks.map(t => t.id), [1]);
      console.log('PASS: real dsh rejected wrong-scope slash writes, invalid lifecycle changes and unresolved continuation creation.');
    }
    console.log('PASS: real dsh ' + mode + ' hid the fragmented multi-block marker and archived the full answer.');
  }
}
function main() {
  fs.mkdirSync(cwd);
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd, windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(cwd, 'csv.test.cjs'), "require('node:test')('csv-header', () => require('node:assert/strict').equal('wrong', 'CSV_HEADER_EXPECTED'));");
  if (process.argv.includes('--marker-only')) return verifyMarkerMatrix();
  if (process.argv.includes('--marker-bank-only')) {
    const cli = (args, store = hub) => {
      const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url)),
        ...args, '--store', store, '--json'], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout);
    };
    cli(['init', '--extended-task-ids']);
    upsertHubTask(hub, { id: 1 }); upsertHubTask(hub, { id: 999 });
    configure({ storeRoot: hub, autopilot: { enabled: true, midSessionSwitch: { crossProject: true } } });
    run('bank-first', 'New task: publish a capacity report.');
    const { sessionId, snapshot } = entries().find(e => e.phase === 'bank-first' && e.snapshot) ?? {};
    assert.equal(snapshot?.task, 1, 'the real first-turn provider must receive the short alias');
    assert.equal(readSessionMarkerBank(hub, sessionId), 1);
    assert.equal(readTurnReceipts(hub, sessionId, 1).task_id, 1000);
    run('bank-resume', 'Continue task #1000.', sessionId);
    assert.equal(readHubTaskThread(hub, 1000).length, 4);
    assert.match(run('bank-cross', 'Continue task #1.', sessionId), /全新 dsh 会话/u);
    assert.ok(!entries().some(e => e.phase === 'bank-cross' && e.snapshot));
    assert.equal(readHubTaskThread(hub, 1).length, 0);
    const bundle = path.join(tmp, 'bank-backup'), restored = path.join(tmp, 'bank-restored');
    cli(['backup', bundle]); cli(['restore', bundle], restored);
    const args = ['checkout', '1000', '--preview'];
    assert.deepEqual(cli(args, restored), cli(args));
    assert.equal(readSessionMarkerBank(restored, sessionId), 1);
    console.log('PASS: native fresh session filed short marker 1 into durable task 1000, resumed after restart, rejected bank switch and restored #1000 unchanged.');
    return;
  }
  if (process.argv.includes('--separate-session-only')) {
    configure({ storeRoot: hub, autopilot: { enabled: true, midSessionSwitch: { historyMode: 'separate-session' } } });
    run('a', 'Investigate CSV export.\nUse npm\nLocal note: ALPHA_ONLY_CSV_WITNESS');
    const id = entries().find(e => e.sessionId)?.sessionId;
    assert.ok(id, 'first business request must reach provider');
    run('same-task', 'Verify the CSV status.', id);
    assert.equal(readHubTaskThread(hub, 1).length, 4);
    const switched = run('switch-blocked', 'New task: change the test runner.', id);
    assert.match(switched, /全新 dsh 会话/u);
    assert.ok(!entries().some(e => e.phase === 'switch-blocked' && e.snapshot));
    assert.equal(readHubTasksIndex(hub).tasks.length, 1);
    run('fresh-beta', 'New task: change the test runner.\nUse pnpm');
    assert.equal(readHubTaskThread(hub, 2).length, 2);
    const witness = entries().find(e => e.phase === 'fresh-beta' && 'oldNativeMessage' in e);
    assert.equal(witness?.oldNativeMessage, false, 'fresh provider request must not include the old authored note');
    console.log('PASS: separate-session kept the same task and tool turn, blocked the switch before business completion and accepted a fresh session.');
    return;
  }
  configure({ storeRoot: hub, autopilot: { enabled: true } });
  run('a', 'Investigate CSV export.\nUse npm');
  const id = entries().find(e => e.sessionId).sessionId;
  const projectId = readHubTasksIndex(hub).tasks[0].project_id;
  assert.ok(projectId);
  if (process.argv.includes('--file-write-only')) return verifyWriteCrash(id, projectId);
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
  verifyWriteCrash(native.find(e => e.snapshot).sessionId, projectId);
  console.log('PASS: dsh exited after the tool result, before turn/end; an independent CLI checkout retained evidence, not a completion or retry.');
  console.log('PASS: memory review follows the answer, survives restart, and injects the project exception only in its own checkout.');
  console.log('PASS: real dsh tool failure, Project supersession, native compaction, restart and natural-language checkout (offline provider).');
  console.log('PASS: native userQuestions selection and restarted text fallback; no business request before selection, original verification runs after selection.');
  verifyMarkerMatrix();
}
try { main(); } finally {
  if (path.dirname(tmp) === fs.realpathSync(os.tmpdir()) && path.basename(tmp).startsWith('cairn-live-')) fs.rmSync(tmp, { recursive: true, force: true });
}
