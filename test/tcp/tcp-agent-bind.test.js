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

test('agent exits nonzero for AGENT_BIND_HOST=0.0.0.0 without override', async () => {
  const result = await runAgent({
    ...BASE_ENV,
    AGENT_BIND_HOST: '0.0.0.0',
    // ALLOW_REMOTE_AGENT_BIND is NOT set
  });
  assert.notEqual(result.status, 0, 'must exit nonzero');
  assert.match(result.stderr, /Refusing non-loopback/);
  assert.ok(result.elapsed < 2000, `must exit quickly, took ${result.elapsed}ms`);
});

test('agent allows AGENT_BIND_HOST=0.0.0.0 with ALLOW_REMOTE_AGENT_BIND=1', async () => {
  const result = await runAgent({
    ...BASE_ENV,
    AGENT_BIND_HOST: '0.0.0.0',
    ALLOW_REMOTE_AGENT_BIND: '1',
    AGENT_PORTS: '19999',
  });
  // Process should start (not exit immediately from bind guard)
  // It will timeout trying to connect to non-existent server
  assert.ok(result.elapsed > 2000, `should run for a while, took ${result.elapsed}ms`);
});
