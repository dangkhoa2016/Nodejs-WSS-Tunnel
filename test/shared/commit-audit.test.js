import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { validateSubject, validateBody, parseNumstat } = await import('../../scripts/audit-commits.js');

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
