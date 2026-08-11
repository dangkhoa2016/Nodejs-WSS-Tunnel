import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { validateSubject, validateBody, parseNumstat, auditRange } = await import('../../scripts/audit-commits.js');
const AUDIT_SCRIPT = fileURLToPath(new URL('../../scripts/audit-commits.js', import.meta.url));

const fixtureDirs = [];
after(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'commit-audit-'));
  fixtureDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function commitAll(dir, message, body) {
  git(dir, ['add', '-A']);
  const args = ['commit', '-m', message];
  if (body !== undefined) {
    args.push('-m', body);
  }
  git(dir, args);
  return git(dir, ['rev-parse', 'HEAD']);
}

function inRepo(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function runCli(dir, args) {
  return spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

describe('validateSubject', () => {
  it('accepts a valid conventional commit subject', () => {
    assert.deepEqual(validateSubject('feat(tcp): add stream guard'), []);
  });

  it('accepts every allowed type', () => {
    const types = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
    for (const type of types) {
      assert.deepEqual(validateSubject(`${type}: do the thing`), [], `type ${type} rejected`);
    }
  });

  it('rejects a subject over 72 characters', () => {
    assert.match(validateSubject(`feat: ${'x'.repeat(80)}`)[0], /72/);
  });

  it('rejects a non-conventional subject', () => {
    assert.match(validateSubject('Merge pull request #1')[0], /Conventional Commit/);
  });

  it('rejects a subject with an uppercase scope', () => {
    assert.match(validateSubject('feat(TCP): add guard')[0], /Conventional Commit/);
  });
});

describe('validateBody', () => {
  it('accepts bullet-only bodies', () => {
    assert.deepEqual(validateBody('- First change.\n- Second change.\n'), []);
  });

  it('accepts bullets and a valid trailer', () => {
    assert.deepEqual(validateBody('- Upgrade ws.\n\nSigned-off-by: Bot <bot@example.com>\n'), []);
  });

  it('rejects prose lines', () => {
    assert.match(validateBody('This is prose.')[0], /bullet or trailer/);
  });

  it('accepts an empty body', () => {
    assert.deepEqual(validateBody(''), []);
  });
});

describe('parseNumstat', () => {
  it('sums additions and deletions', () => {
    const text = '10\t4\tfile.js\n3\t7\tfile2.js\n';
    assert.equal(parseNumstat(text), 24);
  });

  it('ignores binary rows without throwing', () => {
    const text = '10\t4\tfile.js\n-\t-\tlogo.png\n2\t1\tfile2.js\n';
    assert.equal(parseNumstat(text), 17);
  });

  it('returns 0 for empty input', () => {
    assert.equal(parseNumstat(''), 0);
  });
});

describe('auditRange integration', () => {
  it('audits a single valid commit in a temporary repository', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const base = commitAll(dir, 'feat: base setup');
    writeFileSync(join(dir, 'feature.txt'), 'y\n');
    commitAll(dir, 'feat: add feature');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const result = inRepo(dir, () => auditRange(base, head));
    assert.equal(result.total, 1);
    assert.deepEqual(result.violations, []);
  });

  it('reports each violation prefixed with the full offending SHA', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const base = commitAll(dir, 'feat: base setup');
    writeFileSync(join(dir, 'merge.txt'), 'm\n');
    commitAll(dir, 'Merge pull request #1 from evil/patch');
    writeFileSync(join(dir, 'prose.txt'), 'p\n');
    commitAll(dir, 'feat: prose body', 'This is prose and not a bullet.');
    writeFileSync(join(dir, 'big.txt'), `${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')}\n`);
    commitAll(dir, 'feat: large churn');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const shas = git(dir, ['rev-list', `${base}..${head}`])
      .split('\n')
      .filter(Boolean);
    assert.equal(shas.length, 3);

    const result = inRepo(dir, () => auditRange(base, head));
    assert.equal(result.violations.length, 3);
    for (const violation of result.violations) {
      assert.match(violation, /^[0-9a-f]{40} /);
    }

    const subjectOf = new Map(shas.map((sha) => [git(dir, ['show', '-s', '--format=%s', sha]), sha]));
    const mergeViolation = result.violations.find((v) =>
      v.startsWith(subjectOf.get('Merge pull request #1 from evil/patch')),
    );
    assert.match(mergeViolation, /Conventional Commit/);
    const proseViolation = result.violations.find((v) => v.startsWith(subjectOf.get('feat: prose body')));
    assert.match(proseViolation, /bullet or trailer/);
    const churnViolation = result.violations.find((v) => v.startsWith(subjectOf.get('feat: large churn')));
    assert.match(churnViolation, /1000-line threshold/);
  });

  it('does not count binary file churn against the numeric threshold', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const base = commitAll(dir, 'feat: base setup');
    writeFileSync(join(dir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    commitAll(dir, 'feat: add binary asset');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const result = inRepo(dir, () => auditRange(base, head));
    assert.equal(result.total, 1);
    assert.deepEqual(result.violations, []);
  });

  it('audits a merge commit exactly once and passes', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const base = commitAll(dir, 'feat: base setup');
    git(dir, ['checkout', '-b', 'feature']);
    writeFileSync(join(dir, 'feature.txt'), 'y\n');
    commitAll(dir, 'feat: feature work');
    git(dir, ['checkout', 'main']);
    git(dir, ['merge', '--no-ff', 'feature', '-m', 'feat: merge feature branch', '-m', '- Merge the feature branch.']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const reachable = git(dir, ['rev-list', `${base}..${head}`])
      .split('\n')
      .filter(Boolean);
    assert.equal(reachable.length, 2);
    const result = inRepo(dir, () => auditRange(base, head));
    assert.equal(result.total, reachable.length);
    assert.deepEqual(result.violations, []);
  });
});

describe('audit-commits CLI', () => {
  it('exits 0 for a valid range', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const base = commitAll(dir, 'feat: base setup');
    writeFileSync(join(dir, 'second.txt'), 's\n');
    commitAll(dir, 'feat: second commit');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const res = runCli(dir, ['--base', base, '--head', head]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /All commits pass/);
  });

  it('exits 1 with hash-specific diagnostics for a violation', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const base = commitAll(dir, 'feat: base setup');
    writeFileSync(join(dir, 'bad.txt'), 'b\n');
    commitAll(dir, 'Merge pull request #9 from bad/patch');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const res = runCli(dir, ['--base', base, '--head', head]);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(head));
    assert.match(res.stderr, /Conventional Commit/);
  });

  it('exits 2 when arguments are missing', () => {
    const dir = makeRepo();
    const res = runCli(dir, []);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it('exits 0 for an empty range', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    commitAll(dir, 'feat: base setup');
    const res = runCli(dir, ['--base', 'HEAD', '--head', 'HEAD']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /No commits/);
  });

  it('exits 0 when a single commit passes', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'base.txt'), 'x\n');
    const sha = commitAll(dir, 'feat: root setup');
    const res = runCli(dir, ['--single', sha]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /passes the history policy/);
  });

  it('exits 1 when a single commit violates policy', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'bad.txt'), 'b\n');
    const sha = commitAll(dir, 'Merge pull request #7 from bad/patch');
    const res = runCli(dir, ['--single', sha]);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(sha));
    assert.match(res.stderr, /Conventional Commit/);
  });

  it('exits 2 when --single lacks a revision', () => {
    const dir = makeRepo();
    const res = runCli(dir, ['--single']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it('exits non-zero with a bounded diagnostic for an invalid revision', () => {
    const dir = makeRepo();
    const res = runCli(dir, ['--base', 'does-not-exist', '--head', 'HEAD']);
    assert.notEqual(res.status, 0);
    const output = res.stdout + res.stderr;
    assert.ok(output.length < 4000, `diagnostic too large (${output.length} bytes)`);
    assert.ok(!output.includes('TUNNEL_'), 'output must not dump environment');
  });
});
