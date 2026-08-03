process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it, test } from 'node:test';

describe('config helpers', () => {
  it('readInteger returns default when env not set', async () => {
    const { readInteger } = await import('../src/config.js');
    delete process.env.TEST_INT;
    assert.equal(readInteger('TEST_INT', 42), 42);
  });

  it('readInteger parses valid number', async () => {
    const { readInteger } = await import('../src/config.js');
    process.env.TEST_INT = '100';
    assert.equal(readInteger('TEST_INT', 42), 100);
    delete process.env.TEST_INT;
  });

  it('readInteger rejects invalid number', async () => {
    const { readInteger } = await import('../src/config.js');
    process.env.TEST_INT = 'abc';
    assert.throws(() => readInteger('TEST_INT', 42), /TEST_INT/);
    delete process.env.TEST_INT;
  });

  it('readInteger enforces min', async () => {
    const { readInteger } = await import('../src/config.js');
    process.env.TEST_INT = '0';
    assert.throws(() => readInteger('TEST_INT', 42, { min: 1 }), /TEST_INT/);
    delete process.env.TEST_INT;
  });

  it('readInteger enforces max', async () => {
    const { readInteger } = await import('../src/config.js');
    process.env.TEST_INT = '99999';
    assert.throws(() => readInteger('TEST_INT', 42, { max: 65535 }), /TEST_INT/);
    delete process.env.TEST_INT;
  });

  it('readBoolean returns default when env not set', async () => {
    const { readBoolean } = await import('../src/config.js');
    delete process.env.TEST_BOOL;
    assert.equal(readBoolean('TEST_BOOL', true), true);
    assert.equal(readBoolean('TEST_BOOL', false), false);
  });

  it('readBoolean parses valid boolean strings', async () => {
    const { readBoolean } = await import('../src/config.js');
    process.env.TEST_BOOL = 'true';
    assert.equal(readBoolean('TEST_BOOL', false), true);
    process.env.TEST_BOOL = 'false';
    assert.equal(readBoolean('TEST_BOOL', true), false);
    process.env.TEST_BOOL = '1';
    assert.equal(readBoolean('TEST_BOOL', false), true);
    process.env.TEST_BOOL = '0';
    assert.equal(readBoolean('TEST_BOOL', true), false);
    delete process.env.TEST_BOOL;
  });

  it('readBoolean rejects invalid value', async () => {
    const { readBoolean } = await import('../src/config.js');
    process.env.TEST_BOOL = 'yes';
    assert.throws(() => readBoolean('TEST_BOOL', false), /TEST_BOOL/);
    delete process.env.TEST_BOOL;
  });

  it('readUrl accepts valid http URL', async () => {
    const { readUrl } = await import('../src/config.js');
    const url = readUrl('TEST_URL', 'http://localhost:8080');
    assert.equal(url, 'http://localhost:8080');
  });

  it('readUrl rejects non-http URL', async () => {
    const { readUrl } = await import('../src/config.js');
    process.env.TEST_URL = 'ftp://example.com';
    assert.throws(() => readUrl('TEST_URL', ''), /TEST_URL/);
    delete process.env.TEST_URL;
  });

  it('readUrl rejects invalid URL string', async () => {
    const { readUrl } = await import('../src/config.js');
    process.env.TEST_URL = 'not a url';
    assert.throws(() => readUrl('TEST_URL', ''), /TEST_URL/);
    delete process.env.TEST_URL;
  });

  it('readPortList deduplicates', async () => {
    const { readPortList } = await import('../src/config.js');
    process.env.TEST_PORTS = '8080,9090,8080';
    assert.deepEqual(readPortList('TEST_PORTS'), [8080, 9090]);
    delete process.env.TEST_PORTS;
  });

  it('readInteger rejects fractional number', async () => {
    const { readInteger } = await import('../src/config.js');
    process.env.TEST_INT = '1.5';
    assert.throws(() => readInteger('TEST_INT', 42), /TEST_INT/);
    delete process.env.TEST_INT;
  });

  it('readInteger rejects integer with trailing text', async () => {
    const { readInteger } = await import('../src/config.js');
    process.env.TEST_INT = '100abc';
    assert.throws(() => readInteger('TEST_INT', 42), /TEST_INT/);
    delete process.env.TEST_INT;
  });

  it('readPortList rejects invalid port', async () => {
    const { readPortList } = await import('../src/config.js');
    process.env.TEST_PORTS = '8080,99999';
    assert.throws(() => readPortList('TEST_PORTS'), /TEST_PORTS/);
    delete process.env.TEST_PORTS;
  });

  it('readPortList rejects port with trailing text', async () => {
    const { readPortList } = await import('../src/config.js');
    process.env.TEST_PORTS = '6379abc';
    assert.throws(() => readPortList('TEST_PORTS'), /TEST_PORTS/);
    delete process.env.TEST_PORTS;
  });

  it('readPortList returns empty for no env', async () => {
    const { readPortList } = await import('../src/config.js');
    delete process.env.TEST_PORTS;
    assert.deepEqual(readPortList('TEST_PORTS'), []);
  });
});

describe('live config values', () => {
  it('accepts valid defaults', async () => {
    const mod = await import('../src/config.js');
    assert.ok(mod.PORT >= 1 && mod.PORT <= 65535);
    assert.ok(mod.TUNNEL_PATH.startsWith('/'));
    assert.ok(mod.SERVER_HOST.startsWith('http'));
    assert.ok(Number.isFinite(mod.STREAM_IDLE_TIMEOUT_MS) && mod.STREAM_IDLE_TIMEOUT_MS >= 0);
    assert.ok(Number.isInteger(mod.MAX_CONCURRENT_STREAMS) && mod.MAX_CONCURRENT_STREAMS > 0);
    assert.ok(Array.isArray(mod.TCP_TUNNEL_PORTS));
    assert.ok(mod.TCP_AGENT_PATH.startsWith('/'));
    assert.ok(Array.isArray(mod.TCP_AGENT_ALLOWED_PORTS));
    assert.equal(mod.TCP_AGENT_USERNAME, mod.USERNAME);
    assert.equal(mod.TCP_AGENT_PASSWORD, mod.PASSWORD);
    assert.ok(Array.isArray(mod.TCP_AGENT_ALLOWED_ORIGINS));
    assert.equal(typeof mod.TCP_AGENT_REQUIRE_TLS, 'boolean');
    assert.ok(Number.isInteger(mod.TCP_AGENT_MAX_STREAMS_PER_AGENT) && mod.TCP_AGENT_MAX_STREAMS_PER_AGENT >= 0);
  });
});

test('validateConfig rejects TUNNEL_PATH equal to TCP_AGENT_PATH', async () => {
  const proc = spawn(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TUNNEL_USERNAME: 'a',
      TUNNEL_PASSWORD: 'b',
      TUNNEL_PATH: '/tcp',
      TCP_AGENT_PATH: '/tcp',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /TUNNEL_PATH/);
});
