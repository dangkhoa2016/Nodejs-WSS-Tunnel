import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT = path.join(ROOT, 'serve/client.js');

function runClient(env, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [CLIENT], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stderr, elapsed: Date.now() - start });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stderr, elapsed: Date.now() - start });
    });
  });
}

const BASE_ENV = {
  TUNNEL_SERVER_URL: 'ws://localhost:19999/tcp',
  TUNNEL_USERNAME: 'test',
  TUNNEL_PASSWORD: 'test',
};

test('client exits quickly for malformed WS_HIGH_WATER_BYTES', async () => {
  const result = await runClient({ ...BASE_ENV, WS_HIGH_WATER_BYTES: 'abc' });
  assert.notEqual(result.status, 0, 'must exit nonzero for abc');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});

test('client exits quickly for float WS_HIGH_WATER_BYTES', async () => {
  const result = await runClient({ ...BASE_ENV, WS_HIGH_WATER_BYTES: '1.5' });
  assert.notEqual(result.status, 0, 'must exit nonzero for 1.5');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});

test('client exits quickly for negative MAX_CONCURRENT_STREAMS', async () => {
  const result = await runClient({ ...BASE_ENV, MAX_CONCURRENT_STREAMS: '-1' });
  assert.notEqual(result.status, 0, 'must exit nonzero for -1');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});

test('client exits quickly for malformed TCP_CONNECT_TIMEOUT_MS', async () => {
  const result = await runClient({ ...BASE_ENV, TCP_CONNECT_TIMEOUT_MS: 'xyz' });
  assert.notEqual(result.status, 0, 'must exit nonzero for xyz');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});
