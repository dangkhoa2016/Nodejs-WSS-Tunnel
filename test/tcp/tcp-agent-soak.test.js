import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec } from '../../src/shared/protocol.js';
import { sleep } from '../helpers/tcp-test-setup.js';

process.env.TCP_TUNNEL_HOST = '127.0.0.2';
process.env.TCP_CLIENT_ALLOWED_HOSTS = '127.0.0.2';

const runSoak = process.env.RUN_SOAK === '1';

const MAX_CONCURRENT_STREAMS = 200;

function parsePositiveInt(value, fallback, name, max = 10000) {
  const raw = value === undefined || value === '' ? String(fallback) : String(value);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  if (n > max) {
    throw new Error(`${name} too large (${n}); maximum is ${max}`);
  }
  return n;
}

const PARAMS = runSoak
  ? {
      cycles: parsePositiveInt(process.env.SOAK_CYCLES, 100, 'SOAK_CYCLES'),
      concurrency: parsePositiveInt(process.env.SOAK_CONCURRENCY, 20, 'SOAK_CONCURRENCY', MAX_CONCURRENT_STREAMS),
      reconnectEvery: parsePositiveInt(process.env.SOAK_RECONNECT_EVERY, 10, 'SOAK_RECONNECT_EVERY'),
    }
  : { cycles: 0, concurrency: 0, reconnectEvery: 0 };

async function waitFor(cond, timeout = 5000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await sleep(interval);
  }
  throw new Error('waitFor timed out');
}

function listen(wss) {
  return new Promise((r) => wss.on('listening', r));
}

function closeWithTimeout(close, timeout = 5000) {
  return Promise.race([close(), sleep(timeout)]);
}

function open(ws) {
  return new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
}

function waitForAgentListening(proc, port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for agent listener')), timeout);
    const onData = (buf) => {
      if (buf.toString().includes(`port=${port}`)) {
        clearTimeout(timer);
        proc.stdout.removeListener('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
  });
}

function killAndWait(proc, timeout = 5000) {
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
      resolve(code ?? -1);
    });
    proc.kill();
  });
}

function createTrackedEchoServer(host) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (chunk) => socket.write(chunk));
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(0, host, () =>
      resolve({
        port: server.address().port,
        sockets,
        async close() {
          for (const socket of [...sockets]) socket.destroy();
          await new Promise((resolve2) => server.close(resolve2));
        },
      }),
    );
  });
}

const TCP_HANDLER_DEFAULTS = {
  MAX_CONCURRENT_STREAMS: 200,
  TCP_TUNNEL_HOST: '127.0.0.2',
  TCP_CLIENT_ALLOWED_HOSTS: ['127.0.0.2'],
  TCP_CONNECT_TIMEOUT_MS: 5000,
  WS_HIGH_WATER: 1024 * 1024,
  WS_LOW_WATER: 512 * 1024,
};

async function setupSoakEnv() {
  const { StreamManager } = await import('../../src/server/StreamManager.js');
  const { ClientManager } = await import('../../src/server/ClientManager.js');
  const { TcpRouter } = await import('../../src/tcp/TcpRouter.js');
  const { TcpAgentServer } = await import('../../src/tcp/TcpAgentServer.js');
  const { createTcpClientHandler } = await import('../../src/tcp/TcpClientHandler.js');

  const sm = new StreamManager();
  const cm = new ClientManager(sm);
  const tcpRouter = new TcpRouter(sm, cm);
  const echo = await createTrackedEchoServer('127.0.0.2');
  const agentServer = new TcpAgentServer(sm, tcpRouter, {
    allowedPorts: [echo.port],
    maxConnectionsPerPort: 0,
    maxStreamsPerAgent: 0,
  });
  agentServer.startHeartbeat();

  const tunnelWss = new WebSocketServer({ port: 0 });
  tunnelWss.on('connection', (ws) => {
    ws.binaryType = 'nodebuffer';
    cm.addClient(ws);
  });
  await listen(tunnelWss);

  const agentWss = new WebSocketServer({ port: 0 });
  agentWss.on('connection', (ws) => agentServer.handleConnection(ws));
  await listen(agentWss);

  const tunnelWs = new WebSocket(`ws://127.0.0.1:${tunnelWss.address().port}`);
  tunnelWs.binaryType = 'nodebuffer';
  await open(tunnelWs);
  await sleep(50);

  const clientStreams = new Map();
  const tcpHandler = createTcpClientHandler({
    ...TCP_HANDLER_DEFAULTS,
    streams: clientStreams,
    sendFrame: (ws, frame) => {
      if (ws.readyState === 1) ws.send(frame, { binary: true });
      return true;
    },
    sendJsonFrame: (ws, type, streamId, obj) => {
      if (ws.readyState === 1) {
        ws.send(FrameCodec.buildFrame(type, streamId, Buffer.from(JSON.stringify(obj))), { binary: true });
      }
      return true;
    },
    buildFrame: FrameCodec.buildFrame,
    parseJsonPayload: (p) => JSON.parse(p.toString('utf8')),
    resetIdleTimer: () => {},
    cleanupStream: () => {},
  });
  tunnelWs.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let frame;
    try {
      frame = FrameCodec.parseFrame(data);
    } catch {
      return;
    }
    tcpHandler.handleServerFrame(
      frame.type,
      tunnelWs,
      frame.streamId,
      frame.payload,
      clientStreams.get(frame.streamId),
    );
  });

  return {
    sm,
    cm,
    tcpRouter,
    agentServer,
    echo,
    agentWss,
    async cleanup() {
      agentServer.stopHeartbeat();
      for (const ws of [...agentServer._agentStreams.keys()]) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      try {
        tunnelWs.terminate();
      } catch {
        /* ignore */
      }
      await closeWithTimeout(() => new Promise((r) => agentWss.close(r)));
      await closeWithTimeout(() => new Promise((r) => tunnelWss.close(r)));
      await closeWithTimeout(() => echo.close());
    },
  };
}

function spawnSoakAgent(agentWssPort, echoPort) {
  return spawn(process.execPath, ['serve/tcp-agent.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TUNNEL_SERVER_URL: `ws://127.0.0.1:${agentWssPort}/tcp`,
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      AGENT_BIND_HOST: '127.0.0.1',
      AGENT_PORTS: String(echoPort),
      AGENT_RECONNECT_DELAY_MS: '100',
      LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function openTunneledEcho(port, marker, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`echo timeout for marker "${marker}"`));
    }, timeoutMs);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString().includes(marker)) {
        clearTimeout(timer);
        resolve(socket);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('connect', () => socket.write(marker));
  });
}

async function runBatch(env, ownedSockets, cycle) {
  const sockets = [];
  for (let i = 0; i < PARAMS.concurrency; i++) {
    const marker = `soak-c${cycle}-s${i}-${Date.now()}`;
    const socket = await openTunneledEcho(env.echo.port, marker, 10000);
    sockets.push(socket);
    socket.on('close', () => ownedSockets.delete(socket));
    ownedSockets.add(socket);
  }

  for (let i = 0; i < sockets.length; i++) {
    if (i % 2 === 0) sockets[i].end();
    else sockets[i].destroy();
  }

  await waitFor(() => env.sm.streams.size === 0, 8000, 25);
  await waitFor(() => ownedSockets.size === 0, 8000, 25);
  await waitFor(() => env.echo.sockets.size === 0, 8000, 25);

  assert.equal(env.sm.streams.size, 0, 'streams must return to baseline');
  assert.equal(
    env.agentServer._connCountByPort.get(env.echo.port) || 0,
    0,
    'per-port connection counter must return to baseline',
  );
  assert.equal(ownedSockets.size, 0, 'all test-owned sockets must close');
  assert.equal(env.echo.sockets.size, 0, 'echo server must not retain sockets');
  const [agentStreams] = [...env.agentServer._agentStreams.values()];
  assert.equal(agentStreams?.size ?? 0, 0, 'agent must not retain stream ids');
}

async function forceAgentReconnect(env) {
  const oldWs = [...env.agentServer._agentStreams.keys()][0];
  assert.ok(oldWs, 'expected an active agent WebSocket to terminate');
  oldWs.terminate();
  await waitFor(
    () => {
      const keys = [...env.agentServer._agentStreams.keys()];
      return keys.length === 1 && keys[0] !== oldWs;
    },
    10000,
    25,
  );
  assert.equal(env.agentServer._agentStreams.size, 1, 'agent must reconnect after the WebSocket drop');
}

describe('TCP agent soak', { skip: !runSoak }, () => {
  it('keeps streams, sockets, and counters clean across bounded reconnect cycles', { timeout: 1800000 }, async (t) => {
    const echo = await createTrackedEchoServer('127.0.0.2').catch((err) => {
      if (['EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'ENODEV', 'EAFNOSUPPORT'].includes(err.code)) {
        return null;
      }
      throw err;
    });
    if (!echo) {
      t.skip('127.0.0.2 loopback alias unavailable');
      return;
    }
    await closeWithTimeout(() => echo.close());
    const env = await setupSoakEnv();
    const agentProc = spawnSoakAgent(env.agentWss.address().port, env.echo.port);
    const ownedSockets = new Set();
    try {
      await waitForAgentListening(agentProc, env.echo.port, 15000);
      await waitFor(() => env.agentServer._agentStreams.size === 1, 10000, 25);
      await waitFor(() => env.cm.getActiveClient() !== null, 10000, 25);

      assert.equal(env.sm.streams.size, 0, 'baseline: no streams');
      assert.equal(env.agentServer._connCountByPort.get(env.echo.port) || 0, 0, 'baseline: no per-port connections');
      assert.equal(ownedSockets.size, 0, 'baseline: no owned sockets');

      for (let cycle = 0; cycle < PARAMS.cycles; cycle++) {
        await runBatch(env, ownedSockets, cycle);
        if ((cycle + 1) % PARAMS.reconnectEvery === 0) {
          await forceAgentReconnect(env);
        }
      }

      // shutdown() clears the agent reconnect timer; a clean exit is the evidence.
      const exitCode = await killAndWait(agentProc);
      assert.equal(exitCode, 0, 'agent must exit cleanly on SIGTERM');
    } finally {
      if (agentProc.exitCode === null && agentProc.signalCode === null) {
        agentProc.kill();
        await killAndWait(agentProc);
      }
      for (const socket of [...ownedSockets]) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      await env.cleanup();
    }
  });
});
