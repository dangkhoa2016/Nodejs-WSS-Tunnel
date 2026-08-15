import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';

import { sleep } from '../helpers/tcp-test-setup.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitFor(cond, timeout = 10000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await sleep(interval);
  }
  throw new Error('waitFor timed out');
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

// A WSS server that holds the HTTP upgrade so the agent's ws.open only fires
// once release() is called. Lets a test prove readiness requires the WSS to
// actually be open, even when every local listener is already listening.
function createGatedWsServer() {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set();
  const held = [];

  wss.on('connection', (ws) => {
    ws.binaryType = 'nodebuffer';
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
  });

  httpServer.on('upgrade', (req, socket, head) => {
    held.push({ req, socket, head });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve({
        port: httpServer.address().port,
        connections,
        get heldUpgrades() {
          return held.length;
        },
        releaseAll() {
          for (const { req, socket, head } of held.splice(0)) {
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
          }
        },
        async close() {
          for (const { socket } of held) socket.destroy();
          for (const ws of [...connections]) ws.terminate();
          await new Promise((r) => wss.close(r));
          await new Promise((r) => httpServer.close(r));
        },
      });
    });
  });
}

function spawnAgent({ wsPort, agentPorts, readyFile, env = {} }) {
  return spawn('node', ['serve/tcp-agent.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TUNNEL_SERVER_URL: `ws://127.0.0.1:${wsPort}/tcp`,
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      AGENT_BIND_HOST: '127.0.0.1',
      AGENT_PORTS: agentPorts.join(','),
      AGENT_RECONNECT_DELAY_MS: '200',
      LOG_FORMAT: 'text',
      ...(readyFile ? { AGENT_READY_FILE: readyFile } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('TCP agent readiness', () => {
  it('N01: a single occupied port fails startup: exits nonzero and writes no ready file', {
    timeout: 30000,
  }, async () => {
    const sandbox = fs.mkdtempSync('/tmp/agent-ready-n01-');
    const agentPort = await findFreePort();
    const occupied = await occupyPort(agentPort);
    const readyFile = path.join(sandbox, 'agent.ready');
    const mock = createMockWsServer();
    const proc = spawnAgent({ wsPort: mock.port, agentPorts: [agentPort], readyFile });
    try {
      const exitCode = await waitForExit(proc, 10000);
      assert.notEqual(exitCode, null, 'agent must exit when a requested listener cannot bind');
      assert.notEqual(exitCode, 0, 'agent must exit nonzero on listener bind failure');
      assert.equal(fs.existsSync(readyFile), false, 'ready file must not be written');
    } finally {
      await killAndWait(proc);
      await occupied.close();
      await mock.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('N02: a partial listener failure never reports ready', { timeout: 30000 }, async () => {
    const sandbox = fs.mkdtempSync('/tmp/agent-ready-n02-');
    const portA = await findFreePort();
    const portB = await findFreePort();
    const occupied = await occupyPort(portB);
    const readyFile = path.join(sandbox, 'agent.ready');
    const mock = createMockWsServer();
    const proc = spawnAgent({ wsPort: mock.port, agentPorts: [portA, portB], readyFile });
    try {
      const exitCode = await waitForExit(proc, 10000);
      assert.notEqual(exitCode, null, 'agent must exit when any requested listener fails');
      assert.notEqual(exitCode, 0, 'agent must exit nonzero on listener bind failure');
      assert.equal(fs.existsSync(readyFile), false, 'ready file must not be written');
    } finally {
      await killAndWait(proc);
      await occupied.close();
      await mock.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('N03: ready requires the WSS to be open AND all listeners listening', { timeout: 30000 }, async () => {
    const sandbox = fs.mkdtempSync('/tmp/agent-ready-n03-');
    const portA = await findFreePort();
    const portB = await findFreePort();
    const readyFile = path.join(sandbox, 'agent.ready');
    const gated = await createGatedWsServer();
    const proc = spawnAgent({ wsPort: gated.port, agentPorts: [portA, portB], readyFile });
    try {
      await waitFor(async () => (await canConnect(portA)) && (await canConnect(portB)));
      await waitFor(() => gated.heldUpgrades >= 1, 5000);
      assert.equal(
        fs.existsSync(readyFile),
        false,
        'ready file must not be written before the WSS is open, even with all listeners listening',
      );

      gated.releaseAll();
      await waitFor(() => gated.connections.size > 0);
      await waitFor(() => fs.existsSync(readyFile));

      const pid = fs.readFileSync(readyFile, 'utf8').trim();
      assert.equal(pid, String(proc.pid), 'ready file must contain the agent PID');
    } finally {
      await killAndWait(proc);
      await gated.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
