import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHubDshHost } from '../src/hosts/dsh/hub-host.mjs';
import { initHubStore, readProjectsIndex, upsertHubTask } from '../src/kernel/hub-store.mjs';

function mockCtx() {
  const contexts = [];
  const handlers = new Map();
  const registeredCommands = [];
  const tools = [];
  return {
    contexts, handlers, registeredCommands, tools,
    systemPrompt: { context(def) { contexts.push(def); return () => {}; } },
    on(name, handler) { handlers.set(name, handler); return () => {}; },
    commands: { register(def) { registeredCommands.push(def); return () => {}; } },
    tools: { register(def) { tools.push(def); assert.ok(def.output?.schema && typeof def.output.render === 'function'); return () => {}; } },
    llm: { async *stream() { yield { type: 'text-delta', text: '' }; } }
  };
}

test('Hub host withholds cwd project ledger until pre-step locks the project and keeps task ledgers isolated', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-host-'));
  const hub = path.join(temp, 'hub');
  const projectA = path.join(temp, 'project-a');
  const projectB = path.join(temp, 'project-b');
  for (const dir of [projectA, projectB]) { fs.mkdirSync(dir); execFileSync('git', ['init', '-q'], { cwd: dir }); }
  const hintA = (await import('../src/hosts/dsh/git-project.mjs')).resolveGitProjectHint(projectA);
  const hintB = (await import('../src/hosts/dsh/git-project.mjs')).resolveGitProjectHint(projectB);
  initHubStore(hub);
  upsertHubTask(hub, { id: 1, project_id: hintB.project_id, project: hintB, title: 'Beta service migration' });
  const ctx = mockCtx();
  const host = await createHubDshHost(ctx, { storeRoot: hub, llmClient: { complete: async () => ({ ok: true, content: JSON.stringify({ decision: 'match', task_id: 1, project_id: hintB.project_id, candidates: [1], reason: 'specific beta service' }) }) } });
  try {
    const base = ctx.contexts[0].text({ agent: { session: { id: 's1', header: { cwd: projectA } } } });
    assert.doesNotMatch(base, /Current Project Ledger[\s\S]*beta service/u);
    await ctx.handlers.get('agent/pre-step')({ agent: { session: { id: 's1', header: { cwd: projectA } } }, modelSelection: { provider: 'p', model: 'm' }, messages: [{ source: { kind: 'user' }, content: 'continue beta service migration' }] }, async () => ({ kind: 'enter' }));
    const locked = ctx.contexts[1].text({ agent: { session: { id: 's1' } } });
    assert.match(locked, new RegExp(hintB.project_id));
    assert.doesNotMatch(locked, new RegExp(hintA.project_id));
    const inspectResult = await ctx.registeredCommands[0].handler({ rawInput: 'inspect', agent: { session: { id: 's1' } } });
    const inspect = JSON.parse(inspectResult.text);
    assert.match(inspect.selected_project_fingerprint, /^ws_[0-9a-f]{8}$/u);
    assert.equal(inspect.binding_source, 'cold_router_match');
    assert.doesNotMatch(inspectResult.text, /[A-Z]:[\\/]|Continue beta|specific beta service/iu);
    const doctor = await ctx.registeredCommands[0].handler({ rawInput: 'doctor', agent: { session: { id: 's1' } } });
    assert.match(doctor.text, /task_thread_missing/u);
    assert.equal(fs.existsSync(path.join(projectA, '.cairn')), false);
    assert.equal(fs.existsSync(path.join(projectB, '.cairn')), false);
  } finally { await host.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Hub session event persists marker-labelled turns centrally and session flush drains staging', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hub-event-'));
  const hub = path.join(temp, 'hub');
  const project = path.join(temp, 'project'); fs.mkdirSync(project); execFileSync('git', ['init', '-q'], { cwd: project });
  const ctx = mockCtx();
  let stagingCalls = 0;
  const host = await createHubDshHost(ctx, { storeRoot: hub, llmClient: { complete: async () => { stagingCalls++; await ctx.handlers.get('session/flush')?.({ id: 'new-session' }); return { ok: true, content: '{"ops":[]}' }; } } });
  try {
    await ctx.handlers.get('agent/pre-step')({ agent: { session: { id: 'new-session', header: { cwd: project } } }, messages: [{ source: { kind: 'user' }, content: 'Create a project task' }] }, async () => ({ kind: 'enter' }));
    const event = ctx.handlers.get('session/event');
    const session = { id: 'new-session', header: { cwd: project } };
    event(session, { type: 'turn/start', data: { turn: 1 } });
    event(session, { type: 'user/message', data: { message: { content: 'Build the alpha endpoint' } } });
    event(session, { type: 'assistant/message', data: { message: { content: 'I will create the endpoint.\n<|task:1|>' } } });
    event(session, { type: 'turn/end', data: { turn: 1 } });
    await ctx.handlers.get('session/flush')(session);
    const thread = JSON.parse(fs.readFileSync(path.join(hub, 'tasks', '1', 'thread.jsonl'), 'utf8').split(/\r?\n/u)[0]);
    assert.equal(thread.project_id.startsWith('p_'), true);
    const firstTurn = fs.readFileSync(path.join(hub, 'tasks', '1', 'thread.jsonl'), 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.deepEqual(firstTurn.map(record => record.role), ['user', 'assistant']);
    assert.ok(firstTurn.every(record => record.meta?.dsh_session_id === 'new-session' && record.turn === 1));
    assert.match(thread.content, /Build the alpha endpoint/);
    assert.doesNotMatch(thread.content, /<system-reminder>/);
    assert.equal(readProjectsIndex(hub).projects[0].name, 'project');
    event(session, { type: 'turn/start', data: { turn: 1 } });
    event(session, { type: 'user/message', data: { message: { content: 'Build the alpha endpoint' } } });
    event(session, { type: 'assistant/message', data: { message: { content: 'I will create the endpoint.\n<|task:1|>' } } });
    event(session, { type: 'turn/end', data: { turn: 1 } });
    await ctx.handlers.get('session/flush')(session);
    assert.equal(fs.readFileSync(path.join(hub, 'tasks', '1', 'thread.jsonl'), 'utf8').trim().split(/\r?\n/u).length, 2);
    assert.equal(stagingCalls, 1, 'duplicate session turn must not enqueue staging or auto-compaction');
    assert.equal(fs.existsSync(path.join(project, '.cairn')), false);
  } finally { await host.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
});
