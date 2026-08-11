import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const repoRoot = process.cwd();
const script = join(repoRoot, 'scripts', 'audit-push.sh');
const ZERO_SHA = '0000000000000000000000000000000000000000';

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-push-'));
  tmpDirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  return dir;
}

function git(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function runPushAudit(dir, before, after) {
  const res = spawnSync('bash', [script, before, after], { cwd: dir, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('audit-push.sh', () => {
  it('audits a before..after range on a normal push', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const before = commitAll(dir, 'feat: base setup');
    writeFileSync(join(dir, 'b.txt'), 'y\n');
    const after = commitAll(dir, 'feat: second commit');

    const res = runPushAudit(dir, before, after);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Auditing range/);
  });

  it('audits the whole history on an initial push', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const after = commitAll(dir, 'feat: base setup');

    const res = runPushAudit(dir, ZERO_SHA, after);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Initial or force push detected/);
  });

  it('audits the whole history when before is unreachable after a force push', () => {
    const beforeRepo = makeRepo();
    writeFileSync(join(beforeRepo, 'old.txt'), 'o\n');
    const before = commitAll(beforeRepo, 'feat: old base');

    const checkout = makeRepo();
    writeFileSync(join(checkout, 'new.txt'), 'n\n');
    const after = commitAll(checkout, 'feat: new base');

    const res = runPushAudit(checkout, before, after);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Initial or force push detected/);
  });

  it('audits the whole history when before is present but not an ancestor', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const before = commitAll(dir, 'feat: base setup');
    git(dir, ['checkout', '--orphan', 'side']);
    git(dir, ['reset', '--hard']);
    writeFileSync(join(dir, 'b.txt'), 'y\n');
    const after = commitAll(dir, 'feat: new root');

    const res = runPushAudit(dir, before, after);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Initial or force push detected/);
  });
});
