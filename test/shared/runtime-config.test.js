import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { readBoolean, readInteger } from '../../src/shared/runtime-config.js';

describe('readInteger', () => {
  afterEach(() => {
    delete process.env.TEST_INT;
  });

  it('returns default when env is absent', () => {
    assert.equal(readInteger('TEST_INT', 42), 42);
  });

  it('returns default when env is empty', () => {
    process.env.TEST_INT = '';
    assert.equal(readInteger('TEST_INT', 42), 42);
  });

  it('accepts a valid integer', () => {
    process.env.TEST_INT = '100';
    assert.equal(readInteger('TEST_INT', 0), 100);
  });

  it('trims whitespace', () => {
    process.env.TEST_INT = '  100  ';
    assert.equal(readInteger('TEST_INT', 0), 100);
  });

  it('rejects a float', () => {
    process.env.TEST_INT = '1.5';
    assert.throws(() => readInteger('TEST_INT', 0), /invalid integer/);
  });

  it('rejects a non-numeric string', () => {
    process.env.TEST_INT = 'abc';
    assert.throws(() => readInteger('TEST_INT', 0), /invalid integer/);
  });

  it('rejects a signed float', () => {
    process.env.TEST_INT = '-3.14';
    assert.throws(() => readInteger('TEST_INT', 0), /invalid integer/);
  });

  it('enforces min boundary', () => {
    process.env.TEST_INT = '5';
    assert.throws(() => readInteger('TEST_INT', 0, { min: 10 }), /below minimum/);
  });

  it('accepts min boundary exactly', () => {
    process.env.TEST_INT = '10';
    assert.equal(readInteger('TEST_INT', 0, { min: 10 }), 10);
  });

  it('enforces max boundary', () => {
    process.env.TEST_INT = '100';
    assert.throws(() => readInteger('TEST_INT', 0, { max: 50 }), /exceeds maximum/);
  });

  it('accepts max boundary exactly', () => {
    process.env.TEST_INT = '50';
    assert.equal(readInteger('TEST_INT', 0, { max: 50 }), 50);
  });

  // P2-3: unsafe integer regression
  it('rejects unsafe integer 2^53 + 1', () => {
    process.env.TEST_INT = '9007199254740993';
    assert.throws(() => readInteger('TEST_INT', 0), /invalid integer/);
  });

  it('rejects unsafe integer -(2^53 + 1)', () => {
    process.env.TEST_INT = '-9007199254740993';
    assert.throws(() => readInteger('TEST_INT', 0), /invalid integer/);
  });

  it('accepts MAX_SAFE_INTEGER', () => {
    process.env.TEST_INT = '9007199254740991';
    assert.equal(readInteger('TEST_INT', 0), 9007199254740991);
  });

  it('accepts MIN_SAFE_INTEGER', () => {
    process.env.TEST_INT = '-9007199254740991';
    assert.equal(readInteger('TEST_INT', 0), -9007199254740991);
  });

  it('rejects whitespace-only string', () => {
    process.env.TEST_INT = '   ';
    assert.throws(() => readInteger('TEST_INT', 77), /invalid integer/);
  });
});

describe('readBoolean', () => {
  afterEach(() => {
    delete process.env.TEST_BOOL;
  });

  it('returns default when env is absent', () => {
    assert.equal(readBoolean('TEST_BOOL', true), true);
  });

  it('returns default when env is empty', () => {
    process.env.TEST_BOOL = '';
    assert.equal(readBoolean('TEST_BOOL', true), true);
  });

  it('accepts "true"', () => {
    process.env.TEST_BOOL = 'true';
    assert.equal(readBoolean('TEST_BOOL', false), true);
  });

  it('accepts "1"', () => {
    process.env.TEST_BOOL = '1';
    assert.equal(readBoolean('TEST_BOOL', false), true);
  });

  it('accepts "false"', () => {
    process.env.TEST_BOOL = 'false';
    assert.equal(readBoolean('TEST_BOOL', true), false);
  });

  it('accepts "0"', () => {
    process.env.TEST_BOOL = '0';
    assert.equal(readBoolean('TEST_BOOL', true), false);
  });

  it('rejects non-boolean string', () => {
    process.env.TEST_BOOL = 'yes';
    assert.throws(() => readBoolean('TEST_BOOL', false), /invalid boolean/);
  });

  it('rejects numeric 2', () => {
    process.env.TEST_BOOL = '2';
    assert.throws(() => readBoolean('TEST_BOOL', false), /invalid boolean/);
  });
});
