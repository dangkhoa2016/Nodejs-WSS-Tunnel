import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

const { generateSignedUrl, validateHmacSignature } = await import('../../src/shared/utils.js');

describe('generateSignedUrl', () => {
  it('returns expires and sig strings', () => {
    const result = generateSignedUrl('/test', 'secret', 3600);
    assert.equal(typeof result.expires, 'number');
    assert.equal(typeof result.sig, 'string');
    assert.equal(result.sig.length, 64);
  });

  it('expires is approximately expiresInSec in the future', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = generateSignedUrl('/test', 'secret', 100);
    const after = Math.floor(Date.now() / 1000);
    assert.ok(result.expires >= before + 100);
    assert.ok(result.expires <= after + 100);
  });

  it('produces different sigs for different paths', () => {
    const a = generateSignedUrl('/path-a', 'secret', 3600);
    const b = generateSignedUrl('/path-b', 'secret', 3600);
    assert.notEqual(a.sig, b.sig);
  });

  it('produces different sigs for different secrets', () => {
    const a = generateSignedUrl('/test', 'secret1', 3600);
    const b = generateSignedUrl('/test', 'secret2', 3600);
    assert.notEqual(a.sig, b.sig);
  });

  it('produces different sigs at different times', () => {
    const a = generateSignedUrl('/test', 'secret', 3600);
    const b = generateSignedUrl('/test', 'secret', 3600);
    // Expires may differ by 1 second, so sigs should differ
    // (unless generated in the same second — accept either)
    if (a.expires === b.expires) {
      assert.equal(a.sig, b.sig);
    } else {
      assert.notEqual(a.sig, b.sig);
    }
  });
});

describe('validateHmacSignature', () => {
  it('returns true for valid signature', () => {
    const { expires, sig } = generateSignedUrl('/config', 'mysecret', 3600);
    assert.equal(validateHmacSignature('/config', 'mysecret', expires, sig), true);
  });

  it('returns false for wrong secret', () => {
    const { expires, sig } = generateSignedUrl('/config', 'correct', 3600);
    assert.equal(validateHmacSignature('/config', 'wrong', expires, sig), false);
  });

  it('returns false for wrong path', () => {
    const { expires, sig } = generateSignedUrl('/config', 'secret', 3600);
    assert.equal(validateHmacSignature('/other', 'secret', expires, sig), false);
  });

  it('returns false for expired timestamp', () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const payload = `/config|${past}`;
    const sig = crypto.createHmac('sha256', 'secret').update(payload).digest('hex');
    assert.equal(validateHmacSignature('/config', 'secret', past, sig), false);
  });

  it('returns false for missing parameters', () => {
    assert.equal(validateHmacSignature('/config', '', '123', 'abc'), false);
    assert.equal(validateHmacSignature('/config', 'secret', '', 'abc'), false);
    assert.equal(validateHmacSignature('/config', 'secret', '123', ''), false);
    assert.equal(validateHmacSignature('/config', null, null, null), false);
  });

  it('returns false for non-numeric expires', () => {
    assert.equal(validateHmacSignature('/config', 'secret', 'not-a-number', 'abc'), false);
  });

  it('returns false for tampered sig', () => {
    const { expires, sig } = generateSignedUrl('/config', 'secret', 3600);
    const tampered = `${sig.slice(0, -2)}ff`;
    assert.equal(validateHmacSignature('/config', 'secret', expires, tampered), false);
  });

  it('returns false for sig with wrong length (not hex)', () => {
    const { expires } = generateSignedUrl('/config', 'secret', 3600);
    assert.equal(validateHmacSignature('/config', 'secret', expires, 'zzz'), false);
  });

  it('works with large expiresInSec', () => {
    const { expires, sig } = generateSignedUrl('/config', 'secret', 86400 * 365);
    assert.equal(validateHmacSignature('/config', 'secret', expires, sig), true);
  });

  it('works with short expiresInSec', () => {
    const { expires, sig } = generateSignedUrl('/config', 'secret', 1);
    assert.equal(validateHmacSignature('/config', 'secret', expires, sig), true);
  });
});

describe('roundtrip: generate then validate', () => {
  it('multiple paths and secrets', () => {
    const cases = [
      { path: '/a-config', secret: 's1', ttl: 3600 },
      { path: '/b-config', secret: 's2', ttl: 60 },
      { path: '/uuid-config', secret: 'my-admin-secret', ttl: 86400 },
    ];

    for (const { path, secret, ttl } of cases) {
      const { expires, sig } = generateSignedUrl(path, secret, ttl);
      assert.equal(validateHmacSignature(path, secret, expires, sig), true, `Failed for ${path}`);
    }
  });
});
