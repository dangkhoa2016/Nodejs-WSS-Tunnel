import assert from 'node:assert/strict';
import test from 'node:test';
import { syncSocketReadState, syncTcpBackpressure } from '../src/TcpFlowControl.js';
import { FrameCodec, PROTO } from '../src/protocol.js';

function fakeSocket() {
  return {
    destroyed: false,
    pauseCalls: 0,
    resumeCalls: 0,
    pause() {
      this.pauseCalls += 1;
    },
    resume() {
      this.resumeCalls += 1;
    },
  };
}

for (const row of [
  { peerPausedRead: false, localPausedForWs: false, paused: false },
  { peerPausedRead: true, localPausedForWs: false, paused: true },
  { peerPausedRead: false, localPausedForWs: true, paused: true },
  { peerPausedRead: true, localPausedForWs: true, paused: true },
]) {
  test(`peer=${row.peerPausedRead} ws=${row.localPausedForWs}`, () => {
    const socket = fakeSocket();
    const actual = syncSocketReadState(row, socket);
    assert.equal(actual, row.paused);
    assert.equal(socket.pauseCalls, row.paused ? 1 : 0);
    assert.equal(socket.resumeCalls, row.paused ? 0 : 1);
  });
}

test('does not touch a destroyed socket', () => {
  const socket = fakeSocket();
  socket.destroyed = true;
  assert.equal(syncSocketReadState({ peerPausedRead: false, localPausedForWs: false }, socket), false);
  assert.equal(socket.pauseCalls, 0);
  assert.equal(socket.resumeCalls, 0);
});

function fakeWs() {
  const sent = [];
  return {
    readyState: 1,
    send(data, opts) {
      sent.push(FrameCodec.parseFrame(data));
      if (typeof opts === 'function') opts();
    },
    _sent() {
      return sent;
    },
  };
}

for (const row of [
  { agentPaused: false, wsBackpressured: false, expected: 'RESUME' },
  { agentPaused: true, wsBackpressured: false, expected: 'PAUSE' },
  { agentPaused: false, wsBackpressured: true, expected: 'PAUSE' },
  { agentPaused: true, wsBackpressured: true, expected: 'PAUSE' },
]) {
  test(`syncTcpBackpressure ${row.agentPaused}/${row.wsBackpressured} => ${row.expected}`, () => {
    const ws = fakeWs();
    const state = {
      id: 1,
      agentPaused: row.agentPaused,
      wsBackpressured: row.wsBackpressured,
      clientPausedForAgent: row.expected === 'RESUME',
      ws,
    };
    syncTcpBackpressure(state);
    assert.equal(ws._sent().length, 1);
    assert.equal(ws._sent()[0].type, PROTO.TYPE[row.expected]);
  });
}

test('syncTcpBackpressure no frame while unpaused', () => {
  const ws = fakeWs();
  const state = { id: 1, agentPaused: false, wsBackpressured: false, ws };
  syncTcpBackpressure(state);
  assert.equal(ws._sent().length, 0);
});

test('syncTcpBackpressure only sends on state change', () => {
  const ws = fakeWs();
  const state = { id: 1, agentPaused: true, wsBackpressured: false, ws };
  syncTcpBackpressure(state);
  syncTcpBackpressure(state);
  assert.equal(ws._sent().length, 1);
});
