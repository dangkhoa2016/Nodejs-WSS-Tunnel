import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../../src/shared/protocol.js';
import { canConnect, createEchoServer } from '../helpers/tcp-test-setup.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const REDIS_PORT = 6379;

function requireServices() {
  return process.env.REQUIRE_TCP_SERVICES === '1';
}

describe('TCP Stress Tests', () => {
  it('50 concurrent Redis PINGs through tunnel', { timeout: 30000 }, async (t) => {
    if (!(await canConnect('127.0.0.1', REDIS_PORT))) {
      if (requireServices()) throw new Error(`Redis not available on port ${REDIS_PORT}`);
      t.skip(`Redis not available on port ${REDIS_PORT}`);
      return;
    }
    const wsPort = 25390;
    const cleanup = [];
    try {
      const { StreamManager } = await import('../../src/StreamManager.js');
      const { createTcpClientHandler } = await import('../../src/tcp/TcpClientHandler.js');

      const streamManager = new StreamManager();
      const streams = streamManager.streams;

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

      const wss = new WebSocketServer({ port: wsPort });
      cleanup.push(() => new Promise((r) => wss.close(r)));
      await new Promise((r) => wss.on('listening', r));

      wss.on('connection', (ws) => {
        ws.binaryType = 'nodebuffer';
        ws.on('message', (data, isBinary) => {
          if (!isBinary) return;
          let frame;
          try {
            frame = FrameCodec.parseFrame(data);
          } catch {
            return;
          }
          tcpHandler.handleServerFrame(frame.type, ws, frame.streamId, frame.payload, streams.get(frame.streamId));
        });
      });

      const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      clientWs.binaryType = 'nodebuffer';
      cleanup.push(() => clientWs.terminate());
      await new Promise((r, j) => {
        clientWs.on('open', r);
        clientWs.on('error', j);
      });
      await sleep(50);
      const results = {};
      clientWs.on('message', (data, isBinary) => {
        if (!isBinary) return;
        try {
          const f = FrameCodec.parseFrame(data);
          if (f.type === PROTO.TYPE.TCP_DATA) {
            if (!results[f.streamId]) results[f.streamId] = [];
            results[f.streamId].push(f.payload.toString());
          }
        } catch {}
      });

      const COUNT = 50;
      for (let i = 0; i < COUNT; i++) {
        clientWs.send(
          FrameCodec.buildFrame(
            PROTO.TYPE.TCP_OPEN,
            1000 + i,
            Buffer.from(JSON.stringify({ host: '127.0.0.1', port: REDIS_PORT })),
          ),
        );
      }
      await sleep(500);

      for (let i = 0; i < COUNT; i++) {
        clientWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, 1000 + i, Buffer.from('*1\r\n$4\r\nPING\r\n')));
      }
      await sleep(2000);

      let passCount = 0;
      for (let i = 0; i < COUNT; i++) {
        const id = 1000 + i;
        const data = (results[id] || []).join('');
        if (data.includes('PONG')) passCount++;
      }

      assert.ok(passCount >= COUNT * 0.9, `expected >= ${Math.floor(COUNT * 0.9)} PONGs, got ${passCount}/${COUNT}`);

      for (let i = 0; i < COUNT; i++) {
        clientWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, 1000 + i));
      }
      await sleep(200);
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });

  it('rapid open/close cycles', { timeout: 15000 }, async () => {
    let echo;
    const wsPort = 25391;
    const cleanup = [];
    try {
      echo = await createEchoServer();
      const { StreamManager } = await import('../../src/StreamManager.js');
      const { createTcpClientHandler } = await import('../../src/tcp/TcpClientHandler.js');

      const streamManager = new StreamManager();
      const streams = streamManager.streams;

      const tcpHandler = createTcpClientHandler({
        streams,
        MAX_CONCURRENT_STREAMS: 200,
        TCP_TUNNEL_HOST: '127.0.0.1',
        TCP_CLIENT_ALLOWED_HOSTS: ['1270.0.0.1', '127.0.0.1'],
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

      const wss = new WebSocketServer({ port: wsPort });
      cleanup.push(() => new Promise((r) => wss.close(r)));
      await new Promise((r) => wss.on('listening', r));

      wss.on('connection', (ws) => {
        ws.binaryType = 'nodebuffer';
        ws.on('message', (data, isBinary) => {
          if (!isBinary) return;
          let frame;
          try {
            frame = FrameCodec.parseFrame(data);
          } catch {
            return;
          }
          tcpHandler.handleServerFrame(frame.type, ws, frame.streamId, frame.payload, streams.get(frame.streamId));
        });
      });

      const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      clientWs.binaryType = 'nodebuffer';
      cleanup.push(() => clientWs.terminate());
      await new Promise((r, j) => {
        clientWs.on('open', r);
        clientWs.on('error', j);
      });
      await sleep(50);

      const COUNT = 100;
      for (let i = 0; i < COUNT; i++) {
        const id = 2000 + i;
        clientWs.send(
          FrameCodec.buildFrame(
            PROTO.TYPE.TCP_OPEN,
            id,
            Buffer.from(JSON.stringify({ host: '127.0.0.1', port: echo.port })),
          ),
        );
        await sleep(10);
        clientWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, id));
      }
      await sleep(500);

      let leaked = 0;
      for (const [key, val] of streams) {
        if (val.mode === 'tcp' && !val.cleaned) leaked++;
      }
      assert.equal(leaked, 0, `expected 0 leaked TCP streams, got ${leaked}`);
    } finally {
      if (echo) await echo.close();
      for (const fn of cleanup.reverse()) fn();
    }
  });
});
