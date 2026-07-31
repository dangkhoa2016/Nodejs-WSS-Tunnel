import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';

const { StreamManager } = await import('../src/StreamManager.js');
const { PROTO, FrameCodec } = await import('../src/shared/protocol.js');

function mockWs(readyState = WebSocket.OPEN) {
  const sent = [];
  return {
    readyState,
    bufferedAmount: 0,
    send(data, opts) {
      sent.push({ data, opts });
    },
    _sent() {
      return sent;
    },
    _clear() {
      sent.length = 0;
    },
  };
}

function mockReq() {
  return { method: 'GET', destroy() {} };
}

function mockRes() {
  let headersWritten = false;
  let ended = false;
  return {
    get writableEnded() {
      return ended;
    },
    writeHead(status, msg, headers) {
      headersWritten = true;
    },
    end() {
      ended = true;
    },
    destroy() {},
    _headersWritten() {
      return headersWritten;
    },
    _ended() {
      return ended;
    },
  };
}

describe('StreamManager', () => {
  let sm;

  beforeEach(() => {
    sm = new StreamManager();
  });

  describe('allocateStreamId', () => {
    it('returns incrementing ids', () => {
      const id1 = sm.allocateStreamId();
      const id2 = sm.allocateStreamId();
      assert.equal(id2, id1 + 1);
    });

    it('returns 1 initially', () => {
      assert.equal(sm.allocateStreamId(), 1);
    });
  });

  describe('createStream', () => {
    it('stores meta on state object', () => {
      const ws = mockWs();
      const req = mockReq();
      const res = mockRes();
      const meta = { method: 'GET', url: '/test', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req, res, meta, streamId });

      assert.ok(state, 'createStream should return state');
      assert.equal(state.meta, meta, 'state.meta should be the same reference as meta');
      assert.equal(state.meta.method, 'GET');
      assert.equal(state.meta.url, '/test');
    });

    it('stores all required state properties', () => {
      const ws = mockWs();
      const req = mockReq();
      const res = mockRes();
      const meta = { method: 'POST', url: '/api/data', headers: { 'content-type': 'application/json' } };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req, res, meta, streamId });

      assert.equal(state.id, streamId);
      assert.equal(state.ws, ws);
      assert.equal(state.req, req);
      assert.equal(state.res, res);
      assert.equal(state.cleaned, false);
      assert.equal(state.abortSent, false);
      assert.equal(state.responseStarted, false);
      assert.equal(state.responseEnded, false);
      assert.equal(state.requestEnded, false);
    });

    it('registers stream in streams map', () => {
      const ws = mockWs();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      sm.createStream({ ws, req: mockReq(), res: mockRes(), meta, streamId });

      assert.equal(sm.size, 1);
    });

    it('returns null and sends 503 when ws.send fails', () => {
      const ws = mockWs(WebSocket.OPEN);
      ws.send = () => {
        throw new Error('send failed');
      };
      const res = mockRes();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res, meta, streamId });

      assert.equal(state, null);
      assert.equal(sm.size, 0);
      assert.equal(res._ended(), true);
    });
  });

  describe('cleanupStream', () => {
    it('removes stream from map', () => {
      const ws = mockWs();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res: mockRes(), meta, streamId });
      assert.equal(sm.size, 1);

      sm.cleanupStream(state);
      assert.equal(sm.size, 0);
      assert.equal(state.cleaned, true);
    });

    it('is idempotent', () => {
      const ws = mockWs();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res: mockRes(), meta, streamId });

      sm.cleanupStream(state);
      sm.cleanupStream(state);
      assert.equal(state.cleaned, true);
      assert.equal(sm.size, 0);
    });
  });

  describe('abortStream', () => {
    it('sends REQ_ABORT to client when notifyClient=true and response not started', () => {
      const ws = mockWs();
      const res = mockRes();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res, meta, streamId });
      ws._clear();

      sm.abortStream(state, 'test abort', true);

      const sent = ws._sent();
      assert.ok(sent.length > 0, 'should send a frame');

      const frame = sent[0].data;
      assert.equal(frame[1], PROTO.TYPE.REQ_ABORT);
      assert.equal(state.abortSent, true);
    });

    it('does not send REQ_ABORT when notifyClient=false', () => {
      const ws = mockWs();
      const res = mockRes();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res, meta, streamId });
      ws._clear();

      sm.abortStream(state, 'test abort', false);

      const sent = ws._sent();
      assert.equal(sent.length, 0);
    });

    it('writes 502 response when response not started', () => {
      const ws = mockWs();
      const res = mockRes();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res, meta, streamId });

      sm.abortStream(state, 'timeout', true);

      assert.equal(res._headersWritten(), true);
      assert.equal(res._ended(), true);
    });

    it('does not send duplicate REQ_ABORT', () => {
      const ws = mockWs();
      const res = mockRes();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res, meta, streamId });

      sm.abortStream(state, 'first', true);
      ws._clear();
      sm.abortStream(state, 'second', true);

      const sent = ws._sent();
      assert.equal(sent.length, 0, 'should not send second abort');
    });

    it('does nothing if already cleaned', () => {
      const ws = mockWs();
      const res = mockRes();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      const state = sm.createStream({ ws, req: mockReq(), res, meta, streamId });
      sm.cleanupStream(state);
      ws._clear();

      sm.abortStream(state, 'after cleanup', true);

      const sent = ws._sent();
      assert.equal(sent.length, 0);
    });
  });

  describe('handleClientFrame', () => {
    it('ignores frames for unknown stream ids', () => {
      const ws = mockWs();
      const frame = FrameCodec.buildFrame(
        PROTO.TYPE.RES_META,
        9999,
        Buffer.from(
          JSON.stringify({
            statusCode: 200,
            headers: {},
          }),
        ),
      );

      assert.doesNotThrow(() => sm.handleClientFrame(ws, frame));
    });

    it('ignores frames from wrong ws', () => {
      const ws = mockWs();
      const otherWs = mockWs();
      const meta = { method: 'GET', url: '/', headers: {} };
      const streamId = sm.allocateStreamId();

      sm.createStream({ ws, req: mockReq(), res: mockRes(), meta, streamId });

      const frame = FrameCodec.buildFrame(
        PROTO.TYPE.RES_META,
        streamId,
        Buffer.from(
          JSON.stringify({
            statusCode: 200,
            headers: {},
          }),
        ),
      );

      assert.doesNotThrow(() => sm.handleClientFrame(otherWs, frame));
      const state = sm.streams.get(streamId);
      assert.equal(state.responseStarted, false);
    });
  });
});
