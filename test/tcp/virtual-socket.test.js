import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { MAX_DEST_BUFFER_BYTES, WS_HIGH_WATER, WS_LOW_WATER } from '../../src/shared/config.js';
import { FrameCodec, PROTO } from '../../src/shared/protocol.js';
import { createVirtualSocket } from '../../src/tcp/VirtualSocket.js';

function nextTick() {
  return new Promise((resolve) => process.nextTick(resolve));
}

function createFakeAgentWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (frame, opts, cb) => {
    ws.bufferedAmount += frame.length;
    ws.sent.push(FrameCodec.parseFrame(frame));
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };
  return ws;
}

function frameTypes(ws) {
  return ws.sent.map((f) => f.type);
}

describe('VirtualSocket', () => {
  it('exposes a net.Socket-like surface', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 7, remoteAddress: '10.0.0.1', remotePort: 6379 });

    assert.equal(socket.isVirtual, true);
    assert.equal(socket.destroyed, false);
    assert.equal(socket.remoteAddress, '10.0.0.1');
    assert.equal(socket.remotePort, 6379);
    for (const ev of ['data', 'close', 'error', 'drain']) {
      assert.equal(typeof socket.on, 'function');
      socket.on(ev, () => {});
    }
  });

  it('pushInbound emits data when not paused', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 1 });
    const seen = [];
    socket.on('data', (c) => seen.push(c.toString()));

    const ok = socket.pushInbound(Buffer.from('abc'));

    assert.equal(ok, true);
    assert.deepEqual(seen, ['abc']);
  });

  it('pause sends a single PAUSE and buffers inbound data', async () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 3 });
    const seen = [];
    socket.on('data', (c) => seen.push(c.toString()));

    socket.pause();
    socket.pause();

    assert.deepEqual(frameTypes(ws), [PROTO.TYPE.PAUSE]);
    assert.equal(socket.pushInbound(Buffer.from('x')), false);
    assert.equal(socket.pushInbound(Buffer.from('y')), false);
    assert.deepEqual(seen, []);
  });

  it('resume flushes buffered inbound data in order then sends RESUME', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 3 });
    const seen = [];
    socket.on('data', (c) => seen.push(c.toString()));

    socket.pause();
    socket.pushInbound(Buffer.from('x'));
    socket.pushInbound(Buffer.from('y'));
    socket.resume();

    assert.deepEqual(seen, ['x', 'y']);
    assert.deepEqual(frameTypes(ws), [PROTO.TYPE.PAUSE, PROTO.TYPE.RESUME]);
  });

  it('write sends TCP_DATA and backpressures past WS_HIGH_WATER', async () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 5 });
    let drained = 0;
    socket.on('drain', () => drained++);

    ws.bufferedAmount = WS_HIGH_WATER + 1;
    const ok = socket.write(Buffer.from('hello'));

    assert.equal(ok, false);
    assert.equal(drained, 0);
    assert.equal(ws.sent[0].type, PROTO.TYPE.TCP_DATA);
    assert.equal(ws.sent[0].streamId, 5);
    assert.equal(ws.sent[0].payload.toString(), 'hello');

    ws.bufferedAmount = WS_LOW_WATER;
    await nextTick();

    assert.equal(drained, 1);
  });

  it('write returns true within the high water mark', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 5 });

    const ok = socket.write(Buffer.from('hello'));

    assert.equal(ok, true);
    assert.deepEqual(frameTypes(ws), [PROTO.TYPE.TCP_DATA]);
  });

  it('destroy sends TCP_CLOSE once and emits close', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 4 });
    let closes = 0;
    socket.on('close', () => closes++);

    socket.destroy();
    socket.destroy();

    assert.equal(socket.destroyed, true);
    assert.equal(closes, 1);
    assert.deepEqual(frameTypes(ws), [PROTO.TYPE.TCP_CLOSE]);
  });

  it('abort sends TCP_ABORT and emits close asynchronously', async () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 4 });
    let closes = 0;
    socket.on('close', () => closes++);

    socket.abort('Server shutting down');

    assert.equal(socket.destroyed, true);
    assert.equal(closes, 0);
    const abort = ws.sent.find((f) => f.type === PROTO.TYPE.TCP_ABORT);
    assert.ok(abort);
    assert.equal(abort.streamId, 4);
    assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Server shutting down' });

    await nextTick();
    assert.equal(closes, 1);
  });

  it('endFromAgent marks destroyed and suppresses a later TCP_CLOSE', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 4 });
    let closes = 0;
    socket.on('close', () => closes++);

    socket.endFromAgent();
    socket.destroy();

    assert.equal(socket.destroyed, true);
    assert.equal(closes, 1);
    assert.deepEqual(frameTypes(ws), []);
  });

  it('abortFromAgent emits error with the message', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 4 });
    const errors = [];
    socket.on('error', (err) => errors.push(err.message));

    socket.abortFromAgent(Buffer.from(JSON.stringify({ message: 'Connection refused' })));

    assert.equal(socket.destroyed, true);
    assert.deepEqual(errors, ['Connection refused']);
  });

  it('write and pushInbound return false after destroy', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 4 });

    socket.destroy();

    assert.equal(socket.write(Buffer.from('x')), false);
    assert.equal(socket.pushInbound(Buffer.from('x')), false);
  });

  it('caps buffered inbound bytes and aborts the stream on overflow', async () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 3 });
    let closes = 0;
    socket.on('close', () => closes++);

    socket.pause();

    const big = Buffer.alloc(MAX_DEST_BUFFER_BYTES);
    assert.equal(socket.pushInbound(big), false);
    assert.equal(socket.destroyed, false);

    assert.equal(socket.pushInbound(Buffer.from('x')), false);
    assert.equal(socket.destroyed, true);
    const abort = ws.sent.find((f) => f.type === PROTO.TYPE.TCP_ABORT);
    assert.ok(abort, 'expected a TCP_ABORT frame');
    assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Inbound buffer exceeded' });

    await nextTick();
    assert.equal(closes, 1);
  });

  it('resume resets the buffer counter', () => {
    const ws = createFakeAgentWs();
    const socket = createVirtualSocket({ agentWs: ws, streamId: 3 });
    const seen = [];
    socket.on('data', (c) => seen.push(c.toString()));

    socket.pause();
    socket.pushInbound(Buffer.from('a'));
    socket.resume();
    assert.deepEqual(seen, ['a']);

    socket.pause();
    const big = Buffer.alloc(MAX_DEST_BUFFER_BYTES);
    assert.equal(socket.pushInbound(big), false);
    assert.equal(socket.destroyed, false);
    socket.resume();
    assert.equal(seen.length, 2);
  });
});
