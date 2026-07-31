import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isIpAllowed } from '../../src/shared/ipAllowlist.js';

describe('isIpAllowed', () => {
  it('allows all when allowlist is empty', () => {
    assert.strictEqual(isIpAllowed('1.2.3.4', []), true);
    assert.strictEqual(isIpAllowed('1.2.3.4', null), true);
    assert.strictEqual(isIpAllowed('1.2.3.4', undefined), true);
  });

  it('matches exact IP', () => {
    assert.strictEqual(isIpAllowed('192.168.1.5', ['192.168.1.5']), true);
    assert.strictEqual(isIpAllowed('192.168.1.6', ['192.168.1.5']), false);
  });

  it('matches /32 CIDR (single host)', () => {
    assert.strictEqual(isIpAllowed('10.0.0.1', ['10.0.0.1/32']), true);
    assert.strictEqual(isIpAllowed('10.0.0.2', ['10.0.0.1/32']), false);
  });

  it('matches /24 CIDR', () => {
    assert.strictEqual(isIpAllowed('10.0.0.250', ['10.0.0.0/24']), true);
    assert.strictEqual(isIpAllowed('10.0.1.1', ['10.0.0.0/24']), false);
  });

  it('matches /16 CIDR', () => {
    assert.strictEqual(isIpAllowed('172.16.5.5', ['172.16.0.0/16']), true);
    assert.strictEqual(isIpAllowed('172.17.0.1', ['172.16.0.0/16']), false);
  });

  it('matches /0 CIDR (allow all)', () => {
    assert.strictEqual(isIpAllowed('8.8.8.8', ['0.0.0.0/0']), true);
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    assert.strictEqual(isIpAllowed('::ffff:127.0.0.1', ['127.0.0.1']), true);
    assert.strictEqual(isIpAllowed('::ffff:10.0.0.1', ['10.0.0.0/8']), true);
  });

  it('rejects invalid input gracefully', () => {
    assert.strictEqual(isIpAllowed('not.an.ip', ['10.0.0.0/24']), false);
    assert.strictEqual(isIpAllowed(null, ['10.0.0.0/24']), false);
    assert.strictEqual(isIpAllowed('', ['10.0.0.0/24']), false);
  });

  it('handles multiple allowlist entries', () => {
    const allowlist = ['192.168.1.0/24', '10.0.0.5'];
    assert.strictEqual(isIpAllowed('192.168.1.100', allowlist), true);
    assert.strictEqual(isIpAllowed('10.0.0.5', allowlist), true);
    assert.strictEqual(isIpAllowed('172.16.0.1', allowlist), false);
  });

  it('rejects invalid CIDR gracefully', () => {
    assert.strictEqual(isIpAllowed('10.0.0.1', ['10.0.0.0/99']), false);
    assert.strictEqual(isIpAllowed('10.0.0.1', ['not-a-cidr/24']), false);
  });
});
