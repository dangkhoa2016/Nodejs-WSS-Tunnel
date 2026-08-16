import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function waitFor(cond, timeout = 10000, interval = 50) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve(true);
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

function waitForExit(proc, timeout = 8000) {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.removeAllListeners('exit');
      resolve(null);
    }, timeout);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function killAndWait(proc, timeout = 3000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve(proc?.exitCode ?? -1);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(-1);
    }, timeout);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    proc.kill();
  });
}

function createMockWsServer() {
  const wss = new WebSocketServer({ port: 0 });
  const connections = new Set();
  wss.on('connection', (ws) => {
    ws.binaryType = 'nodebuffer';
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
  });
  return {
    port: wss.address().port,
    connections,
    async close() {
      for (const ws of [...connections]) ws.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}

function spawnClient({ wsPort, workDir }) {
  return spawn('node', ['serve/client.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TUNNEL_SERVER_URL: `ws://127.0.0.1:${wsPort}/tunnel`,
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      TUNNEL_WORK_DIR: workDir,
      LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('tunnel client readiness', () => {
  it('C01: WSS open creates client.ready containing the PID', { timeout: 30000 }, async () => {
    const workDir = fs.mkdtempSync('/tmp/client-ready-c01-');
    const readyFile = path.join(workDir, 'client.ready');
    const mock = createMockWsServer();
    const proc = spawnClient({ wsPort: mock.port, workDir });
    try {
      await waitFor(() => fs.existsSync(readyFile));
      const pid = fs.readFileSync(readyFile, 'utf8').trim();
      assert.equal(pid, String(proc.pid), 'ready file must contain the client PID');
    } finally {
      await killAndWait(proc);
      await mock.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('C02: server closing the WSS removes client.ready', { timeout: 30000 }, async () => {
    const workDir = fs.mkdtempSync('/tmp/client-ready-c02-');
    const readyFile = path.join(workDir, 'client.ready');
    const mock = createMockWsServer();
    const proc = spawnClient({ wsPort: mock.port, workDir });
    try {
      await waitFor(() => fs.existsSync(readyFile));

      for (const client of [...mock.connections]) client.terminate();

      await waitFor(() => !fs.existsSync(readyFile));
      assert.equal(proc.exitCode, null, 'client process must stay alive after WSS close');
    } finally {
      await killAndWait(proc);
      await mock.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('C03: client reconnect recreates client.ready', { timeout: 30000 }, async () => {
    const workDir = fs.mkdtempSync('/tmp/client-ready-c03-');
    const readyFile = path.join(workDir, 'client.ready');
    const mock = createMockWsServer();
    const proc = spawnClient({ wsPort: mock.port, workDir });
    try {
      await waitFor(() => fs.existsSync(readyFile));

      for (const client of [...mock.connections]) client.terminate();
      await waitFor(() => !fs.existsSync(readyFile));

      await waitFor(() => mock.connections.size === 1);
      await waitFor(() => fs.existsSync(readyFile));

      const pid = fs.readFileSync(readyFile, 'utf8').trim();
      assert.equal(pid, String(proc.pid), 'recreated ready file must contain the same process PID');
    } finally {
      await killAndWait(proc);
      await mock.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('C04: SIGTERM removes client.ready and exits cleanly', { timeout: 30000 }, async () => {
    const workDir = fs.mkdtempSync('/tmp/client-ready-c04-');
    const readyFile = path.join(workDir, 'client.ready');
    const mock = createMockWsServer();
    const proc = spawnClient({ wsPort: mock.port, workDir });
    try {
      await waitFor(() => fs.existsSync(readyFile));

      proc.kill('SIGTERM');
      const exitCode = await waitForExit(proc, 5000);
      assert.equal(exitCode, 0, 'client must exit cleanly on SIGTERM');
      assert.equal(fs.existsSync(readyFile), false, 'ready file must be removed on shutdown');
    } finally {
      await killAndWait(proc);
      await mock.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('C05: client does not reconnect after SIGTERM (shutdown guard)', { timeout: 30000 }, async () => {
    const workDir = fs.mkdtempSync('/tmp/client-ready-c05-');
    const readyFile = path.join(workDir, 'client.ready');
    const mock = createMockWsServer();
    const proc = spawnClient({ wsPort: mock.port, workDir });
    try {
      await waitFor(() => fs.existsSync(readyFile));

      // Terminate all existing connections to simulate disconnect
      for (const ws of [...mock.connections]) ws.terminate();
      await new Promise((r) => setTimeout(r, 100));

      // Send SIGTERM while disconnected
      proc.kill('SIGTERM');
      const exitCode = await waitForExit(proc, 5000);
      assert.equal(exitCode, 0, 'client must exit cleanly on SIGTERM');

      // After SIGTERM, client should not attempt to reconnect
      const connCountAfter = mock.connections.size;
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(mock.connections.size, connCountAfter, 'no new connections should appear after shutdown');
    } finally {
      await killAndWait(proc);
      await mock.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
