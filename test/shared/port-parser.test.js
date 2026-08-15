process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAgentPorts } from '../../src/shared/port-parser.js';

describe('parseAgentPorts', () => {
  // ── accepted ────────────────────────────────────────────────────────

  it('AP01 single port', () => {
    assert.deepEqual(parseAgentPorts('6379'), [6379]);
  });

  it('AP02 two ports', () => {
    assert.deepEqual(parseAgentPorts('6379,5432'), [6379, 5432]);
  });

  it('AP11 leading zeros canonicalized', () => {
    assert.deepEqual(parseAgentPorts('006379'), [6379]);
  });

  // ── rejected ────────────────────────────────────────────────────────

  it('AP03 non-numeric token', () => {
    assert.throws(() => parseAgentPorts('6379,abc'), /non-numeric/);
  });

  it('AP04 empty entry in middle', () => {
    assert.throws(() => parseAgentPorts('6379,,5432'), /empty entry/);
  });

  it('AP05 trailing comma', () => {
    assert.throws(() => parseAgentPorts('6379,'), /empty entry/);
  });

  it('AP06 leading comma', () => {
    assert.throws(() => parseAgentPorts(',6379'), /empty entry/);
  });

  it('AP07 port zero', () => {
    assert.throws(() => parseAgentPorts('0'), /out of range/);
  });

  it('AP08 port above 65535', () => {
    assert.throws(() => parseAgentPorts('65536'), /out of range/);
  });

  it('AP09 exact duplicate', () => {
    assert.throws(() => parseAgentPorts('6379,6379'), /duplicate port/);
  });

  it('AP10 numeric-alias duplicate after canonicalization', () => {
    assert.throws(() => parseAgentPorts('06379,6379'), /duplicate port/);
  });

  it('empty string', () => {
    assert.throws(() => parseAgentPorts(''), /required/);
  });

  it('whitespace only', () => {
    assert.throws(() => parseAgentPorts('   '), /required/);
  });

  it('undefined', () => {
    assert.throws(() => parseAgentPorts(undefined), /required/);
  });

  it('port with spaces around comma', () => {
    assert.deepEqual(parseAgentPorts('6379 , 5432'), [6379, 5432]);
  });

  it('rejects fractional string', () => {
    assert.throws(() => parseAgentPorts('1.5'), /non-numeric/);
  });

  it('rejects negative number', () => {
    assert.throws(() => parseAgentPorts('-1'), /non-numeric/);
  });
});
