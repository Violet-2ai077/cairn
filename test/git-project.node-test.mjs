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
    // The parent of this fixture may itself be a Git worktree (including TMPDIR).
    const empty = path.join(root, 'unverified-project');
    fs.mkdirSync(path.join(empty, '.git'), { recursive: true });
    assert.equal(resolveGitProjectHint(empty), null);
    fs.writeFileSync(path.join(empty, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(resolveGitProjectHint(empty), null);
    const pointer = path.join(root, 'bad-pointer');
    fs.mkdirSync(pointer);
    fs.writeFileSync(path.join(pointer, '.git'), 'gitdir: ../unverified-project/.git\n');
    assert.equal(resolveGitProjectHint(pointer), null);
    const broken = path.join(root, 'broken-worktree'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ../missing-worktree-metadata\n');
    assert.equal(resolveGitProjectHint(broken), null);
    assert.equal(normalizeProjectPath('C:\\Work\\Repo'), 'c:/work/repo');
    assert.equal(normalizeProjectPath('c:/work/repo/'), 'c:/work/repo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a real linked worktree gets its own project identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-worktree-'));
  try {
    const main = path.join(root, 'main'), linked = path.join(root, 'linked');
    execFileSync('git', ['init', '-q', main]);
    execFileSync('git', ['-C', main, '-c', 'user.name=Cairn', '-c', 'user.email=test@invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', linked]);
    assert.equal(resolveGitProjectHint(linked)?.canonical_root, linked);
    assert.notEqual(resolveGitProjectHint(linked).project_id, resolveGitProjectHint(main).project_id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
