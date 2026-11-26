import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendTaskTurn, initCairnStore, transitionTaskStatus } from '../src/kernel/index.mjs';
import { initHubStore } from '../src/kernel/hub-store.mjs';

const bin = fileURLToPath(new URL('../bin/cairn.mjs', import.meta.url));

test('CLI subprocesses localize help, Hub and workspace text while preserving data, JSON, codes and exit status', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cli-locale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  initCairnStore(workspace);
  initHubStore(path.join(root, 'cairn'));
  const title = '原文 / Original';
  appendTaskTurn(workspace, { task_id: 1, role: 'user', content: title });
  transitionTaskStatus(workspace, { taskId: 1, action: 'close' });
  const run = (locale, args, expected = 0) => {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8',
      env: { ...process.env, DSH_HOME: root, CAIRN_LOCALE: locale } });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
    return expected === 0 ? result.stdout : result.stderr;
  };
  for (const [locale, help, hub, status, error] of [
    ['zh', '用法：', '没有符合此状态', '账本状态：', '请先运行'],
    ['en', 'Usage:', 'No tasks in this lifecycle filter.', 'Ledger state  :', "run 'cairn reopen 1' first"]
  ]) {
    assert.ok(run(locale, ['--help']).includes(help));
    assert.ok(run(locale, ['tasks']).includes(hub));
    assert.ok(run(locale, ['status', '--cwd', workspace]).includes(status));
    assert.ok(run(locale, ['tasks', '--all', '--cwd', workspace]).includes(title));
    const frozen = run(locale, ['checkout', '1', '--cwd', workspace], 1);
    assert.ok(frozen.includes('task_not_active:1:done'));
    assert.ok(frozen.includes(error));
  }
  for (const args of [['tasks', '--json'], ['tasks', '--cwd', workspace, '--all', '--json']]) {
    const en = run('en', args);
    assert.equal(run('zh', args), en);
    assert.ok(Array.isArray(JSON.parse(en).tasks));
  }
});
