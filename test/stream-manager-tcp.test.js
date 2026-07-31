import assert from 'node:assert/strict';
import net from 'node:net';
import { beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';

const { StreamManager } = await import('../src/StreamManager.js');
const { PROTO, FrameCodec } = await import('../src/shared/protocol.js');
const { syncSocketReadState } = await import('../src/TcpFlowControl.js');

function mockWs(readyState = WebSocket.OPEN) {
  const sent = [];
  return {
    readyState,
    bufferedAmount: 0,
    _socket: { remoteAddress: '127.0.0.1' },
    send(data, opts, cb) {
      sent.push({ data, opts });
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

function mockSocket() {
  const events = {};
  let _paused = false;
  return {
    destroyed: false,
    remoteAddress: '127.0.0.1',
    remotePort: 12345,
    on(ev, fn) {
      (events[ev] = events[ev] || []).push(fn);
    },
    once(ev, fn) {
      (events[ev] = events[ev] || []).push(fn);
    },
    removeListener() {},
    emit(ev, ...args) {
      for (const fn of events[ev] || []) fn(...args);
    },
    destroy() {
      this.destroyed = true;
    },
    pause() {
      _paused = true;
    },
    resume() {
      _paused = false;
    },
    isPaused() {
      return _paused;
    },
    _events: events,
  };
}

describe('StreamManager - TCP lifecycle', () => {
  let sm;

  beforeEach(() => {
    sm = new StreamManager();
  });

  describe('createTcpStream', () => {
    it('stores all required state properties', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      assert.ok(state);
      assert.equal(state.id, streamId);
      assert.equal(state.ws, ws);
      assert.equal(state.socket, socket);
      assert.equal(state.serverPort, 6379);
      assert.equal(state.mode, 'tcp');
      assert.equal(state.cleaned, false);
    });

    it('registers stream in streams map', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      assert.equal(sm.size, 1);
    });
  });

  describe('cleanupTcpStream', () => {
    it('removes stream from map', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });
      assert.equal(sm.size, 1);

      sm.cleanupTcpStream(state);
      assert.equal(sm.size, 0);
      assert.equal(state.cleaned, true);
    });

    it('is idempotent', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      sm.cleanupTcpStream(state);
      sm.cleanupTcpStream(state);
      assert.equal(state.cleaned, true);
      assert.equal(sm.size, 0);
    });

    it('calls onCleanup callback', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });
      let called = false;
      state.onCleanup = () => {
        called = true;
      };

      sm.cleanupTcpStream(state);
      assert.equal(called, true);
    });
  });

  describe('abortTcpStream', () => {
    it('sends TCP_ABORT to client when notifyClient=true', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });
      ws._clear();

      sm.abortTcpStream(state, 'test abort', true);

      const sent = ws._sent();
      assert.ok(sent.length > 0);
      assert.equal(sent[0].data[1], PROTO.TYPE.TCP_ABORT);
    });

    it('does not send TCP_ABORT when notifyClient=false', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });
      ws._clear();

      sm.abortTcpStream(state, 'test abort', false);

      const sent = ws._sent();
      assert.equal(sent.length, 0);
    });

    it('does nothing if already cleaned', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });
      sm.cleanupTcpStream(state);
      ws._clear();

      sm.abortTcpStream(state, 'after cleanup', true);
      const sent = ws._sent();
      assert.equal(sent.length, 0);
    });
  });

  describe('getTcpStreams', () => {
    it('returns only TCP streams', () => {
      const ws = mockWs();
      const s1 = sm.allocateStreamId();
      const s2 = sm.allocateStreamId();

      sm.createTcpStream({ ws, socket: mockSocket(), serverPort: 6379, streamId: s1 });
      sm.createStream({
        ws,
        req: { method: 'GET', destroy() {} },
        res: { writableEnded: false, writeHead() {}, end() {}, destroy() {} },
        meta: { method: 'GET', url: '/', headers: {} },
        streamId: s2,
      });

      const tcpStreams = sm.getTcpStreams();
      assert.equal(tcpStreams.length, 1);
      assert.equal(tcpStreams[0].mode, 'tcp');
    });
  });

  describe('handleClientFrame TCP', () => {
    it('handles TCP_DATA by writing to socket', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      let written = null;
      socket.write = (data) => {
        written = data;
      };

      const payload = Buffer.from('hello');
      const frame = FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, payload);
      sm.handleClientFrame(ws, frame);

      assert.ok(written);
      assert.equal(written.toString(), 'hello');
    });

    it('handles TCP_CLOSE by cleaning up', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      const frame = FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId);
      sm.handleClientFrame(ws, frame);

      assert.equal(sm.size, 0);
      assert.equal(state.cleaned, true);
    });

    it('handles PAUSE for TCP stream', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      const frame = FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId);
      sm.handleClientFrame(ws, frame);

      assert.equal(state.peerPausedRead, true);
      assert.equal(socket.isPaused?.(), true);
    });

    it('handles RESUME for TCP stream', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });
      state.peerPausedRead = true;

      const frame = FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId);
      sm.handleClientFrame(ws, frame);

      assert.equal(state.peerPausedRead, false);
    });
  });

  describe('pause reason coordination', () => {
    it('peer resume alone keeps socket paused when WS still paused', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();
      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      const pauseFrame = FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId);
      sm.handleClientFrame(ws, pauseFrame);
      state.localPausedForWs = true;

      const resumeFrame = FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId);
      sm.handleClientFrame(ws, resumeFrame);
      assert.equal(socket.isPaused(), true, 'should still be paused');

      state.localPausedForWs = false;
      syncSocketReadState(state, socket);
      assert.equal(socket.isPaused(), false, 'should be resumed after WS clears');
    });

    it('WS release alone keeps socket paused when peer still paused', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();
      const state = sm.createTcpStream({ ws, socket, serverPort: 6379, streamId });

      const pauseFrame = FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId);
      sm.handleClientFrame(ws, pauseFrame);
      state.localPausedForWs = true;

      state.localPausedForWs = false;
      assert.equal(socket.isPaused(), true, 'flag only: syncSocketReadState not yet called');

      state.peerPausedRead = false;
      const resumeFrame = FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId);
      sm.handleClientFrame(ws, resumeFrame);
      assert.equal(socket.isPaused(), false, 'both clear: socket resumes');
    });
  });

  describe('abortAnyStream with TCP', () => {
    it('destroys socket and removes from map', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 9999, streamId });
      let cleanupCalls = 0;
      state.onCleanup = () => {
        cleanupCalls++;
      };

      sm.abortAnyStream(state, 'test abort', false);

      assert.equal(socket.destroyed, true);
      assert.equal(cleanupCalls, 1);
      assert.equal(sm.streams.has(streamId), false);
    });

    it('notifies client with TCP_ABORT when notifyClient=true', () => {
      const ws = mockWs();
      const socket = mockSocket();
      const streamId = sm.allocateStreamId();

      const state = sm.createTcpStream({ ws, socket, serverPort: 9999, streamId });
      ws._clear();

      sm.abortAnyStream(state, 'test abort', true);

      const sent = ws._sent();
      assert.ok(sent.length > 0);
      assert.equal(sent[0].data[1], PROTO.TYPE.TCP_ABORT);
    });
  });
});
