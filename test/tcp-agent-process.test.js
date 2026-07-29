import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../src/protocol.js';
import { sleep } from './helpers/tcp-test-setup.js';

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

async function waitFor(cond, timeout = 5000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await sleep(interval);
  }
  throw new Error('waitFor timed out');
}

function waitForAgentListening(proc, port, timeout = 10000) {
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

function createMockWsServer({ echo = true, autoAck = true, onAuth } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const connections = new Set();
  const received = [];
  const waiters = [];
  const authHeaders = [];

  wss.on('connection', (ws, req) => {
    ws.binaryType = 'nodebuffer';
    connections.add(ws);
    if (req.headers.authorization) authHeaders.push(req.headers.authorization);
    if (onAuth) onAuth(req.headers.authorization);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      let frame;
      try {
        frame = FrameCodec.parseFrame(data);
      } catch {
        return;
      }
      received.push(frame);
      for (const w of waiters) {
        if (w.pred(frame)) {
          clearTimeout(w.timer);
          w.resolve(frame);
        }
      }
      if (frame.type === PROTO.TYPE.TCP_CONNECT) {
        let info = {};
        try {
          info = JSON.parse(frame.payload.toString());
        } catch {
          /* ignore */
        }
        if (autoAck) {
          ws.send(
            FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT_ACK, 1, Buffer.from(JSON.stringify({ port: info.port }))),
            { binary: true },
          );
        }
      } else if (frame.type === PROTO.TYPE.TCP_DATA && echo) {
        ws.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, frame.streamId, frame.payload), { binary: true });
      }
    });
    ws.on('close', () => connections.delete(ws));
  });

  return {
    wss,
    connections,
    received,
    authHeaders,
    waitFor(type, streamId = null, timeout = 5000) {
      const pred = (f) => f.type === type && (streamId === null || f.streamId === streamId);
      const existing = received.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve,
          timer: setTimeout(
            () => reject(new Error(`timeout waiting for frame type=${type} streamId=${streamId}`)),
            timeout,
          ),
        };
        waiters.push(w);
      });
    },
    async close() {
      for (const ws of [...connections]) ws.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}

function spawnAgent({ mockPort, agentPort, reconnectDelay = 200, env = {} }) {
  return spawn('node', ['serve/tcp-agent.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TUNNEL_SERVER_URL: `ws://127.0.0.1:${mockPort}/tcp`,
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      AGENT_BIND_HOST: '127.0.0.1',
      AGENT_PORTS: String(agentPort),
      AGENT_RECONNECT_DELAY_MS: String(reconnectDelay),
      LOG_FORMAT: 'text',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function connectSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);
    socket.on('connect', () => resolve(socket));
    socket.on('error', reject);
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

describe('TCP agent process', () => {
  it('listens on AGENT_PORTS and relays bytes through the WebSocket', { timeout: 20000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer();
    const proc = spawnAgent({ mockPort: mock.wss.address().port, agentPort });
    try {
      await waitForAgentListening(proc, agentPort);
      await waitFor(() => mock.connections.size > 0);

      const local = await connectSocket(agentPort);
      try {
        const connect = await mock.waitFor(PROTO.TYPE.TCP_CONNECT, 0);
        assert.equal(JSON.parse(connect.payload.toString()).port, agentPort);

        // Data only flows once the agent has processed the ACK and registered
        // the stream, so this round-trip doubles as the readiness check.
        local.write('ping');
        const data = await mock.waitFor(PROTO.TYPE.TCP_DATA, 1);
        assert.equal(data.payload.toString(), 'ping');

        const echo = await new Promise((resolve, reject) => {
          const chunks = [];
          const t = setTimeout(() => reject(new Error('timeout waiting for echo')), 5000);
          local.on('data', (c) => {
            chunks.push(c);
            if (Buffer.concat(chunks).toString().includes('ping')) {
              clearTimeout(t);
              resolve(Buffer.concat(chunks));
            }
          });
        });
        assert.ok(echo.toString().includes('ping'));
      } finally {
        local.destroy();
      }
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });

  it('sends TCP_CLOSE to the server when the local socket closes', { timeout: 20000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer({ echo: false });
    const proc = spawnAgent({ mockPort: mock.wss.address().port, agentPort });
    try {
      await waitForAgentListening(proc, agentPort);
      await waitFor(() => mock.connections.size > 0);

      const local = await connectSocket(agentPort);
      await mock.waitFor(PROTO.TYPE.TCP_CONNECT, 0);

      local.write('ping');
      await mock.waitFor(PROTO.TYPE.TCP_DATA, 1);

      local.end();
      await mock.waitFor(PROTO.TYPE.TCP_CLOSE, 1);
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });

  it('closes the local socket when the server sends TCP_ABORT', { timeout: 20000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer({ echo: false });
    const proc = spawnAgent({ mockPort: mock.wss.address().port, agentPort });
    try {
      await waitForAgentListening(proc, agentPort);
      await waitFor(() => mock.connections.size > 0);

      const local = await connectSocket(agentPort);
      try {
        await mock.waitFor(PROTO.TYPE.TCP_CONNECT, 0);

        local.write('ping');
        await mock.waitFor(PROTO.TYPE.TCP_DATA, 1);

        // Keep the local socket in flowing mode, like a real client reading a
        // response, so it observes the remote close.
        local.resume();

        const closed = new Promise((resolve) => local.on('close', resolve));
        const ws = [...mock.connections][0];
        ws.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_ABORT, 1, Buffer.from(JSON.stringify({ message: 'aborted' }))), {
          binary: true,
        });

        await closed;
        assert.equal(local.destroyed, true);
      } finally {
        local.destroy();
      }
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });

  it('exits cleanly on SIGTERM', { timeout: 10000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer();
    const proc = spawnAgent({ mockPort: mock.wss.address().port, agentPort });
    try {
      await waitForAgentListening(proc, agentPort);
      await waitFor(() => mock.connections.size > 0);

      const exitCode = await killAndWait(proc);
      assert.equal(exitCode, 0);
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });

  it('sends AGENT_USERNAME/AGENT_PASSWORD when provided', { timeout: 20000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer();
    const proc = spawnAgent({
      mockPort: mock.wss.address().port,
      agentPort,
      env: { AGENT_USERNAME: 'agent', AGENT_PASSWORD: 'agentpass' },
    });
    try {
      await waitFor(() => mock.authHeaders.length > 0);
      const expected = `Basic ${Buffer.from('agent:agentpass').toString('base64')}`;
      assert.equal(mock.authHeaders[0], expected);
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });

  it('falls back to TUNNEL_USERNAME/TUNNEL_PASSWORD', { timeout: 20000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer();
    const proc = spawnAgent({ mockPort: mock.wss.address().port, agentPort });
    try {
      await waitFor(() => mock.authHeaders.length > 0);
      const expected = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
      assert.equal(mock.authHeaders[0], expected);
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });

  it('removes pending sockets that close before the ACK arrives', { timeout: 20000 }, async () => {
    const agentPort = await findFreePort();
    const mock = createMockWsServer({ autoAck: false });
    const proc = spawnAgent({ mockPort: mock.wss.address().port, agentPort });
    try {
      await waitForAgentListening(proc, agentPort);
      await waitFor(() => mock.connections.size > 0);

      const local = await connectSocket(agentPort);
      await mock.waitFor(PROTO.TYPE.TCP_CONNECT, 0);
      local.destroy();
      await sleep(100);

      const [ws] = [...mock.connections];
      ws.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT_ACK, 1, Buffer.from(JSON.stringify({ port: agentPort }))), {
        binary: true,
      });
      await sleep(150);

      assert.equal(proc.exitCode, null);
      assert.equal(
        mock.received.some((f) => f.type === PROTO.TYPE.TCP_CLOSE),
        false,
        'no stream should have been registered for the closed socket',
      );

      ws.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, 1, Buffer.from('probe')), { binary: true });
      await sleep(150);
      assert.equal(
        mock.received.some((f) => f.streamId === 1),
        false,
        'late ACK must not register the closed socket as a stream',
      );

      const local2 = await connectSocket(agentPort);
      try {
        await waitFor(() => mock.received.filter((f) => f.type === PROTO.TYPE.TCP_CONNECT).length === 2);
        assert.equal(mock.received.filter((f) => f.type === PROTO.TYPE.TCP_CONNECT).length, 2);
      } finally {
        local2.destroy();
      }
    } finally {
      proc.kill();
      await killAndWait(proc);
      await mock.close();
    }
  });
});
