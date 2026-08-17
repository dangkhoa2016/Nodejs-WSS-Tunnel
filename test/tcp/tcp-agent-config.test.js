import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = path.join(ROOT, 'serve/tcp-agent.js');

function runAgent(env, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [AGENT], {
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
  AGENT_USERNAME: 'test',
  AGENT_PASSWORD: 'test',
  AGENT_PORTS: '19999',
};

test('agent exits quickly for malformed WS_HIGH_WATER_BYTES', async () => {
  const result = await runAgent({ ...BASE_ENV, WS_HIGH_WATER_BYTES: 'abc' });
  assert.notEqual(result.status, 0, 'must exit nonzero for abc');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});

test('agent exits quickly for float WS_HIGH_WATER_BYTES', async () => {
  const result = await runAgent({ ...BASE_ENV, WS_HIGH_WATER_BYTES: '1.5' });
  assert.notEqual(result.status, 0, 'must exit nonzero for 1.5');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});

test('agent exits quickly for malformed AGENT_RECONNECT_DELAY_MS', async () => {
  const result = await runAgent({ ...BASE_ENV, AGENT_RECONNECT_DELAY_MS: 'xyz' });
  assert.notEqual(result.status, 0, 'must exit nonzero for xyz');
  assert.ok(result.elapsed < 3000, `must exit quickly, took ${result.elapsed}ms`);
});
