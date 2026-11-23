import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveGitProjectHint, normalizeProjectPath } from '../src/hosts/dsh/git-project.mjs';

test('Git project hint resolves roots read-only and canonicalizes identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-git-hint-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const child = path.join(root, 'nested');
    fs.mkdirSync(child);
    const before = fs.readdirSync(root).sort();
    const hint = resolveGitProjectHint(child);
    assert.ok(hint?.project_id.startsWith('p_'));
    assert.equal(path.resolve(hint.canonical_root), path.resolve(root));
    assert.deepEqual(fs.readdirSync(root).sort(), before);
    assert.equal(resolveGitProjectHint(os.tmpdir()), null);
    const broken = path.join(root, 'broken-worktree'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ../missing-worktree-metadata\n');
    assert.equal(resolveGitProjectHint(broken), null);
    assert.equal(normalizeProjectPath('C:\\Work\\Repo'), 'c:/work/repo');
    assert.equal(normalizeProjectPath('c:/work/repo/'), 'c:/work/repo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
