import assert from 'node:assert/strict';
import test from 'node:test';
import { syncSocketReadState } from '../src/TcpFlowControl.js';

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
