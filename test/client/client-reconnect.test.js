import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test('client stays alive and reconnects after the server closes the connection', async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;

  let connectionCount = 0;
  wss.on('connection', () => {
    connectionCount++;
  });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-reconnect-'));
  const child = spawn(process.execPath, ['serve/client.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TUNNEL_SERVER_URL: `ws://127.0.0.1:${port}/tunnel`,
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      TUNNEL_WORK_DIR: workDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  t.after(async () => {
    try {
      child.kill();
    } catch {}
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 500);
    });
    await new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(resolve);
    });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  await waitFor(() => connectionCount === 1, 5000);
  assert.equal(connectionCount, 1);

  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  try {
    await waitFor(() => connectionCount >= 2, 8000);
  } catch {
    assert.fail(
      `client did not reconnect after server shutdown (connectionCount=${connectionCount}, exitCode=${child.exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  assert.equal(connectionCount, 2);
});
