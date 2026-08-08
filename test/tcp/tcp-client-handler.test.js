import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTO } from '../../src/shared/protocol.js';
import { syncSocketReadState } from '../../src/tcp/TcpFlowControl.js';

function mockWs(readyState = 1) {
  const sent = [];
  return {
    readyState,
    bufferedAmount: 0,
    send(data, _opts, cb) {
      sent.push(data);
      if (typeof cb === 'function') cb();
    },
    _sent() {
      return sent;
    },
    _clear() {
      sent.length = 0;
    },
  };
}

async function createHandler(overrides = {}) {
  const streams = new Map();
  const sent = [];

  const deps = {
    streams,
    MAX_CONCURRENT_STREAMS: 200,
    TCP_TUNNEL_HOST: '127.0.0.1',
    TCP_CLIENT_ALLOWED_HOSTS: ['127.0.0.1', 'localhost'],
    TCP_CONNECT_TIMEOUT_MS: 5000,
    WS_HIGH_WATER: 1024 * 1024,
    WS_LOW_WATER: 512 * 1024,
    sendFrame: (ws, frame) => {
      sent.push({ ws, frame });
      return true;
    },
    sendJsonFrame: (ws, type, streamId, obj) => {
      sent.push({ ws, type, streamId, obj });
      return true;
    },
    buildFrame: (type, streamId, payload) => {
      const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
      const buf = Buffer.allocUnsafe(6 + p.length);
      buf[0] = 1;
      buf[1] = type;
      buf.writeUInt32BE(streamId >>> 0, 2);
      if (p.length > 0) p.copy(buf, 6);
      return buf;
    },
    parseJsonPayload: (payload) => {
      if (!payload || payload.length === 0) throw new Error('Empty');
      return JSON.parse(payload.toString('utf8'));
    },
    resetIdleTimer: () => {},
    cleanupStream: () => {},
    ...overrides,
  };

  const { createTcpClientHandler } = await import('../../src/tcp/TcpClientHandler.js');
  const handler = createTcpClientHandler(deps);

  return { handler, streams, sent, deps };
}

describe('TcpClientHandler', () => {
  describe('handleServerFrame routing', () => {
    it('handles TCP_OPEN and returns true', async () => {
      const { handler } = await createHandler();

      const ws = mockWs();
      const payload = Buffer.from(JSON.stringify({ host: '127.0.0.1', port: 6379 }));

      const result = handler.handleServerFrame(PROTO.TYPE.TCP_OPEN, ws, 1, payload, null);

      assert.equal(result, true);
      handler.cleanupTcpStreams();
    });

    it('handles TCP_DATA and returns true', async () => {
      const { handler, streams } = await createHandler();

      const ws = mockWs();
      const streamId = 1;

      streams.set(streamId, {
        id: streamId,
        ws,
        mode: 'tcp',
        localSocket: {
          destroyed: false,
          write: () => {},
        },
        cleaned: false,
        timer: null,
      });

      const result = handler.handleServerFrame(
        PROTO.TYPE.TCP_DATA,
        ws,
        streamId,
        Buffer.from('hello'),
        streams.get(streamId),
      );

      assert.equal(result, true);
    });

    it('handles TCP_CLOSE and returns true', async () => {
      const { handler, streams } = await createHandler();

      const ws = mockWs();
      const streamId = 1;

      streams.set(streamId, {
        id: streamId,
        ws,
        mode: 'tcp',
        localSocket: { destroyed: false, destroy() {} },
        cleaned: false,
        timer: null,
      });

      const result = handler.handleServerFrame(
        PROTO.TYPE.TCP_CLOSE,
        ws,
        streamId,
        Buffer.alloc(0),
        streams.get(streamId),
      );

      assert.equal(result, true);
      assert.equal(streams.has(streamId), false);
    });

    it('handles TCP_ABORT and returns true', async () => {
      const { handler, streams } = await createHandler();

      const ws = mockWs();
      const streamId = 1;

      streams.set(streamId, {
        id: streamId,
        ws,
        mode: 'tcp',
        localSocket: { destroyed: false, destroy() {} },
        cleaned: false,
        timer: null,
      });

      const payload = Buffer.from(JSON.stringify({ message: 'error' }));
      const result = handler.handleServerFrame(PROTO.TYPE.TCP_ABORT, ws, streamId, payload, streams.get(streamId));

      assert.equal(result, true);
      assert.equal(streams.has(streamId), false);
    });

    it('handles PAUSE for TCP stream', async () => {
      const { handler, streams } = await createHandler();

      let paused = false;
      const localSocket = {
        destroyed: false,
        pause() {
          paused = true;
        },
      };

      const streamId = 1;
      streams.set(streamId, {
        id: streamId,
        ws: mockWs(),
        mode: 'tcp',
        localSocket,
        cleaned: false,
        timer: null,
      });

      const result = handler.handleServerFrame(
        PROTO.TYPE.PAUSE,
        mockWs(),
        streamId,
        Buffer.alloc(0),
        streams.get(streamId),
      );

      assert.equal(result, true);
      assert.equal(paused, true);
    });

    it('handles RESUME for TCP stream', async () => {
      const { handler, streams } = await createHandler();

      let resumed = false;
      const localSocket = {
        destroyed: false,
        resume() {
          resumed = true;
        },
      };

      const streamId = 1;
      streams.set(streamId, {
        id: streamId,
        ws: mockWs(),
        mode: 'tcp',
        localSocket,
        cleaned: false,
        timer: null,
      });

      const result = handler.handleServerFrame(
        PROTO.TYPE.RESUME,
        mockWs(),
        streamId,
        Buffer.alloc(0),
        streams.get(streamId),
      );

      assert.equal(result, true);
      assert.equal(resumed, true);
    });

    it('releases pause only after both reasons clear (peer first)', async () => {
      await createHandler();
      const streamId = 1;

      let _pauseCalls = 0;
      let resumeCalls = 0;
      const localSocket = {
        destroyed: false,
        pause() {
          _pauseCalls++;
        },
        resume() {
          resumeCalls++;
        },
      };

      const state = {
        id: streamId,
        mode: 'tcp',
        localSocket,
        peerPausedRead: true,
        localPausedForWs: true,
      };

      state.peerPausedRead = false;
      syncSocketReadState(state, localSocket);
      assert.equal(resumeCalls, 0, 'peer cleared but WS still paused');

      state.localPausedForWs = false;
      syncSocketReadState(state, localSocket);
      assert.equal(resumeCalls, 1, 'both clear');
    });

    it('releases pause only after both reasons clear (WS first)', async () => {
      await createHandler();
      const streamId = 1;

      let _pauseCalls = 0;
      let resumeCalls = 0;
      const localSocket = {
        destroyed: false,
        pause() {
          _pauseCalls++;
        },
        resume() {
          resumeCalls++;
        },
      };

      const state = {
        id: streamId,
        mode: 'tcp',
        localSocket,
        peerPausedRead: true,
        localPausedForWs: true,
      };

      state.localPausedForWs = false;
      syncSocketReadState(state, localSocket);
      assert.equal(resumeCalls, 0, 'WS cleared but peer still paused');

      state.peerPausedRead = false;
      syncSocketReadState(state, localSocket);
      assert.equal(resumeCalls, 1, 'both clear');
    });

    it('returns false for unknown frame types', async () => {
      const { handler } = await createHandler();

      const result = handler.handleServerFrame(0xff, mockWs(), 1, Buffer.alloc(0), null);

      assert.equal(result, false);
    });

    it('rejects TCP_OPEN with disallowed host', async () => {
      const { handler, sent } = await createHandler({
        TCP_CLIENT_ALLOWED_HOSTS: ['10.0.0.1'],
      });

      const ws = mockWs();
      const payload = Buffer.from(JSON.stringify({ host: 'evil.com', port: 6379 }));

      handler.handleServerFrame(PROTO.TYPE.TCP_OPEN, ws, 1, payload, null);

      assert.ok(sent.length > 0);
      assert.equal(sent[0].type, PROTO.TYPE.TCP_ABORT);
    });

    it('sends TCP_ABORT when TCP_OPEN payload is invalid', async () => {
      const { handler, sent } = await createHandler();

      const ws = mockWs();
      const payload = Buffer.from('not json');

      handler.handleServerFrame(PROTO.TYPE.TCP_OPEN, ws, 7, payload, null);

      assert.ok(sent.length > 0);
      assert.equal(sent[0].type, PROTO.TYPE.TCP_ABORT);
      assert.equal(sent[0].streamId, 7);
    });

    it('sends TCP_OPEN_ACK after the local connection succeeds', async () => {
      const net = await import('node:net');
      const echo = net.createServer((s) => s.pipe(s));
      await new Promise((r) => echo.listen(0, '127.0.0.1', r));
      const port = echo.address().port;

      const { handler, sent } = await createHandler();
      try {
        const ws = mockWs();
        const payload = Buffer.from(JSON.stringify({ host: '127.0.0.1', port }));

        handler.handleServerFrame(PROTO.TYPE.TCP_OPEN, ws, 5, payload, null);

        for (let i = 0; i < 50; i++) {
          const ack = sent.find((s) => s.type === PROTO.TYPE.TCP_OPEN_ACK && s.streamId === 5);
          if (ack) break;
          await new Promise((r) => setTimeout(r, 10));
        }

        const ack = sent.find((s) => s.type === PROTO.TYPE.TCP_OPEN_ACK && s.streamId === 5);
        assert.ok(ack, 'client should send TCP_OPEN_ACK once the local TCP connection is established');
      } finally {
        handler.cleanupTcpStreams();
        await new Promise((r) => echo.close(r));
      }
    });
  });

  describe('cleanupTcpStreams', () => {
    it('cleans up all TCP streams', async () => {
      const { handler, streams } = await createHandler();

      streams.set(1, {
        id: 1,
        mode: 'tcp',
        cleaned: false,
        timer: null,
        localSocket: { destroyed: false, destroy() {} },
      });
      streams.set(2, {
        id: 2,
        mode: 'http',
        cleaned: false,
        timer: null,
      });

      handler.cleanupTcpStreams();

      assert.equal(streams.has(1), false);
      assert.equal(streams.has(2), true);
    });
  });
});
