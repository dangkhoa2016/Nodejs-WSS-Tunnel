import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../src/protocol.js';
import { canConnect } from './helpers/tcp-test-setup.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setupPair(port) {
  return new Promise(async (resolve) => {
    const cleanup = [];
    const { StreamManager } = await import('../src/StreamManager.js');
    const { createTcpClientHandler } = await import('../src/TcpClientHandler.js');

    const sm = new StreamManager();
    const streams = sm.streams;

    const tcpHandler = createTcpClientHandler({
      streams,
      MAX_CONCURRENT_STREAMS: 200,
      TCP_TUNNEL_HOST: '127.0.0.1',
      TCP_CLIENT_ALLOWED_HOSTS: ['127.0.0.1'],
      TCP_CONNECT_TIMEOUT_MS: 5000,
      WS_HIGH_WATER: 1024 * 1024,
      WS_LOW_WATER: 512 * 1024,
      sendFrame: (ws, frame) => {
        if (ws.readyState === 1) ws.send(frame, { binary: true });
        return true;
      },
      sendJsonFrame: (ws, type, streamId, obj) => {
        if (ws.readyState === 1)
          ws.send(FrameCodec.buildFrame(type, streamId, Buffer.from(JSON.stringify(obj))), { binary: true });
        return true;
      },
      buildFrame: FrameCodec.buildFrame,
      parseJsonPayload: (p) => JSON.parse(p.toString('utf8')),
      resetIdleTimer: () => {},
      cleanupStream: () => {},
    });

    const wss = new WebSocketServer({ port });
    cleanup.push(() => new Promise((r) => wss.close(r)));
    await new Promise((r) => wss.on('listening', r));

    let serverWs = null;
    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.binaryType = 'nodebuffer';
    });

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
    clientWs.binaryType = 'nodebuffer';
    cleanup.push(() => clientWs.terminate());
    await new Promise((r, j) => {
      clientWs.on('open', r);
      clientWs.on('error', j);
    });
    await sleep(50);

    const received = [];
    serverWs.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        const f = FrameCodec.parseFrame(data);
        received.push(f);
      } catch {}
    });

    clientWs.on('message', (data, isBinary) => {
      if (!isBinary) return;
      let frame;
      try {
        frame = FrameCodec.parseFrame(data);
      } catch {
        return;
      }
      tcpHandler.handleServerFrame(frame.type, clientWs, frame.streamId, frame.payload, streams.get(frame.streamId));
    });

    resolve({ serverWs, cleanup, received, streams });
  });
}

function openTunnel(serverWs, id, port) {
  serverWs.send(
    FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN, id, Buffer.from(JSON.stringify({ host: '127.0.0.1', port }))),
  );
}

function sendData(serverWs, id, data) {
  serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, id, Buffer.from(data)));
}

function closeTunnel(serverWs, id) {
  serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, id));
}

function getDataFrames(received, streamId) {
  return received.filter((f) => f.type === PROTO.TYPE.TCP_DATA && f.streamId === streamId);
}

const REDIS_PORT = 6379;
const PG_PORT = 5432;

function requireServices() {
  return process.env.REQUIRE_TCP_SERVICES === '1';
}

describe('Real TCP Integration Tests', () => {
  it('Redis: PING/PONG', { timeout: 10000 }, async (t) => {
    if (!(await canConnect('127.0.0.1', REDIS_PORT))) {
      if (requireServices()) throw new Error(`Redis not available on port ${REDIS_PORT}`);
      t.skip(`Redis not available on port ${REDIS_PORT}`);
      return;
    }
    const { serverWs, cleanup, received } = await setupPair(25379);
    try {
      openTunnel(serverWs, 1, REDIS_PORT);
      await sleep(500);

      sendData(serverWs, 1, '*1\r\n$4\r\nPING\r\n');
      await sleep(1000);

      const frames = getDataFrames(received, 1);
      assert.ok(frames.length > 0, 'should receive Redis response');
      const data = frames.map((f) => f.payload.toString()).join('');
      assert.ok(data.includes('PONG'), `expected PONG, got: ${data}`);

      closeTunnel(serverWs, 1);
      await sleep(100);
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });

  it('Redis: SET/GET/DEL', { timeout: 10000 }, async (t) => {
    if (!(await canConnect('127.0.0.1', REDIS_PORT))) {
      if (requireServices()) throw new Error(`Redis not available on port ${REDIS_PORT}`);
      t.skip(`Redis not available on port ${REDIS_PORT}`);
      return;
    }
    const { serverWs, cleanup, received } = await setupPair(25380);
    try {
      openTunnel(serverWs, 2, REDIS_PORT);
      await sleep(500);

      sendData(serverWs, 2, '*3\r\n$3\r\nSET\r\n$11\r\ntun-testkey\r\n$13\r\ntunnel-value!\r\n');
      await sleep(500);
      sendData(serverWs, 2, '*2\r\n$3\r\nGET\r\n$11\r\ntun-testkey\r\n');
      await sleep(500);

      const frames = getDataFrames(received, 2);
      const data = frames.map((f) => f.payload.toString()).join('');
      assert.ok(data.includes('OK'), `expected SET OK, got: ${data}`);
      assert.ok(data.includes('tunnel-value!'), `expected GET tunnel-value!, got: ${data}`);

      sendData(serverWs, 2, '*2\r\n$3\r\nDEL\r\n$11\r\ntun-testkey\r\n');
      await sleep(300);
      closeTunnel(serverWs, 2);
      await sleep(100);
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });

  it('Postgres: TCP connect through tunnel', { timeout: 10000 }, async (t) => {
    if (!(await canConnect('127.0.0.1', PG_PORT))) {
      if (requireServices()) throw new Error(`Postgres not available on port ${PG_PORT}`);
      t.skip(`Postgres not available on port ${PG_PORT}`);
      return;
    }
    const { serverWs, cleanup, streams } = await setupPair(25381);
    try {
      openTunnel(serverWs, 3, PG_PORT);
      await sleep(500);

      const state = streams.get(3);
      assert.ok(state, 'TCP stream should exist');
      assert.equal(state.mode, 'tcp');
      assert.ok(state.localSocket, 'should have local socket');
      assert.equal(state.localSocket.destroyed, false, 'local socket should be alive');

      closeTunnel(serverWs, 3);
      await sleep(100);
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });

  it('concurrent: 5 parallel Redis PINGs', { timeout: 10000 }, async (t) => {
    if (!(await canConnect('127.0.0.1', REDIS_PORT))) {
      if (requireServices()) throw new Error(`Redis not available on port ${REDIS_PORT}`);
      t.skip(`Redis not available on port ${REDIS_PORT}`);
      return;
    }
    const { serverWs, cleanup, received } = await setupPair(25382);
    try {
      for (let i = 0; i < 5; i++) {
        openTunnel(serverWs, 10 + i, REDIS_PORT);
      }
      await sleep(500);

      for (let i = 0; i < 5; i++) {
        sendData(serverWs, 10 + i, '*1\r\n$4\r\nPING\r\n');
      }
      await sleep(1000);

      for (let i = 0; i < 5; i++) {
        const frames = getDataFrames(received, 10 + i);
        const data = frames.map((f) => f.payload.toString()).join('');
        assert.ok(data.includes('PONG'), `stream ${10 + i}: expected PONG, got: ${data}`);
      }

      for (let i = 0; i < 5; i++) closeTunnel(serverWs, 10 + i);
      await sleep(100);
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });
});
