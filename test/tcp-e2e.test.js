import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../src/protocol.js';

describe('TCP tunnel e2e', () => {
  it('tunnels TCP data end-to-end through WebSocket', { timeout: 10000 }, async () => {
    const cleanup = [];
    const port = 19876 + Math.floor(Math.random() * 1000);
    const localPort = port + 1;
    try {
      const localData = [];
      const localServer = net.createServer((socket) => {
        socket.on('data', (chunk) => {
          localData.push(chunk);
          socket.write(`echo:${chunk.toString()}`);
        });
      });
      cleanup.push(() => new Promise((r) => localServer.close(r)));
      await new Promise((r, j) => {
        localServer.listen(localPort, '127.0.0.1', r);
        localServer.on('error', j);
      });

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
        buildFrame: (type, streamId, payload) => FrameCodec.buildFrame(type, streamId, payload),
        parseJsonPayload: (p) => JSON.parse(p.toString('utf8')),
        resetIdleTimer: () => {},
        cleanupStream: () => {},
      });

      const serverWss = new WebSocketServer({ port });
      cleanup.push(() => new Promise((r) => serverWss.close(r)));
      await new Promise((r) => serverWss.on('listening', r));

      let serverWs = null;
      serverWss.on('connection', (ws) => {
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
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(serverWs, 'server should have received a WS connection');

      const serverReceived = [];
      serverWs.on('message', (data, isBinary) => {
        if (!isBinary) return;
        try {
          const f = FrameCodec.parseFrame(data);
          serverReceived.push(f);
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

      const streamId = 42;
      serverWs.send(
        FrameCodec.buildFrame(
          PROTO.TYPE.TCP_OPEN,
          streamId,
          Buffer.from(JSON.stringify({ host: '127.0.0.1', port: localPort })),
        ),
      );
      await new Promise((r) => setTimeout(r, 500));

      serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('hello-tunnel')));
      await new Promise((r) => setTimeout(r, 500));

      assert.ok(localData.length > 0, 'local server should have received data');
      assert.equal(localData[0].toString(), 'hello-tunnel');

      const echoFrames = serverReceived.filter((f) => f.type === PROTO.TYPE.TCP_DATA && f.streamId === streamId);
      assert.ok(echoFrames.length > 0, 'server should receive echo data');
      assert.ok(
        Buffer.concat(echoFrames.map((f) => f.payload))
          .toString()
          .includes('echo:'),
      );

      serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });
});
