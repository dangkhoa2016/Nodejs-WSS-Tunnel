process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { isAgentRequestSecure } = await import('../../src/server/HttpRouter.js');

function makeReq({ encrypted = false, remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    socket: { encrypted, remoteAddress },
    headers,
  };
}

describe('isAgentRequestSecure', () => {
  it('trusts an encrypted socket regardless of headers', () => {
    const req = makeReq({ encrypted: true, headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(isAgentRequestSecure(req, []), true);
  });

  it('rejects a plain socket when no proxies are trusted', () => {
    const req = makeReq({ headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(isAgentRequestSecure(req, []), false);
  });

  it('rejects a plain socket from an untrusted peer even with forwarded https', () => {
    const req = makeReq({ remoteAddress: '10.0.0.9', headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(isAgentRequestSecure(req, ['127.0.0.1']), false);
  });

  it('accepts forwarded https from a trusted proxy', () => {
    const req = makeReq({ headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(isAgentRequestSecure(req, ['127.0.0.1']), true);
  });

  it('rejects forwarded http from a trusted proxy', () => {
    const req = makeReq({ headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(isAgentRequestSecure(req, ['127.0.0.1']), false);
  });

  it('accepts a peer matching a trusted CIDR prefix', () => {
    const req = makeReq({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(isAgentRequestSecure(req, ['127.0.0.0/8']), true);
  });

  it('accepts an IPv4-mapped address when the proxy is allowlisted', () => {
    const req = makeReq({ remoteAddress: '::ffff:127.0.0.1', headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(isAgentRequestSecure(req, ['127.0.0.1']), true);
  });

  it('takes the first entry of a forwarded proto list', () => {
    const req = makeReq({ headers: { 'x-forwarded-proto': 'https,http' } });
    assert.equal(isAgentRequestSecure(req, ['127.0.0.1']), true);
  });
});
