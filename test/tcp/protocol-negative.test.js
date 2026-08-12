import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../../src/shared/protocol.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listen(wss) {
  return new Promise((r) => wss.on('listening', r));
}

function open(ws) {
  return new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
}

function makeCollector(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let frame;
    try {
      frame = FrameCodec.parseFrame(data);
    } catch {
      return;
    }
    let consumed = false;
    for (const w of waiters) {
      if (!w.done && w.pred(frame)) {
        w.done = true;
        clearTimeout(w.timer);
        w.resolve(frame);
        consumed = true;
        break;
      }
    }
    if (!consumed) queue.push(frame);
  });
  return {
    frames: queue,
    waitFor(type, streamId = null, timeout = 3000) {
      const pred = (f) => f.type === type && (streamId === null || f.streamId === streamId);
      const idx = queue.findIndex(pred);
      if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          done: false,
          resolve,
          timer: setTimeout(() => {
            w.done = true;
            reject(new Error(`timeout waiting for frame type=${type} streamId=${streamId}`));
          }, timeout),
        };
        waiters.push(w);
      });
    },
    assertQuiet(streamId = null, timeout = 150) {
      return new Promise((resolve, reject) => {
        const onMessage = (data, isBinary) => {
          if (!isBinary) return;
          let frame;
          try {
            frame = FrameCodec.parseFrame(data);
          } catch {
            return;
          }
          if (streamId === null || frame.streamId === streamId) {
            cleanup();
            reject(new Error(`unexpected frame type=${frame.type} streamId=${frame.streamId}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, timeout);
        const cleanup = () => {
          clearTimeout(timer);
          ws.removeListener('message', onMessage);
        };
        ws.on('message', onMessage);
      });
    },
  };
}

function buildFrame(ws, frame) {
  if (ws.readyState === 1) ws.send(frame, { binary: true });
  return true;
}

function buildJsonFrame(ws, type, streamId, obj) {
  return buildFrame(ws, FrameCodec.buildFrame(type, streamId, Buffer.from(JSON.stringify(obj))));
}

async function setupAgentEnv() {
  const { StreamManager } = await import('../../src/server/StreamManager.js');
  const { ClientManager } = await import('../../src/server/ClientManager.js');
  const { TcpRouter } = await import('../../src/tcp/TcpRouter.js');
  const { TcpAgentServer } = await import('../../src/tcp/TcpAgentServer.js');

  const sm = new StreamManager();
  const cm = new ClientManager(sm);
  const tcpRouter = new TcpRouter(sm, cm);
  const allowedPort = 6379;
  const agentServer = new TcpAgentServer(sm, tcpRouter, {
    allowedPorts: [allowedPort],
    maxConnectionsPerPort: 0,
    maxStreamsPerAgent: 0,
  });

  const tunnelWss = new WebSocketServer({ port: 0 });
  tunnelWss.on('connection', (ws) => {
    ws.binaryType = 'nodebuffer';
    cm.addClient(ws);
  });
  await listen(tunnelWss);

  const agentWss = new WebSocketServer({ port: 0 });
  agentWss.on('connection', (ws) => agentServer.handleConnection(ws));
  await listen(agentWss);

  const tunnelWs = new WebSocket(`ws://127.0.0.1:${tunnelWss.address().port}`);
  tunnelWs.binaryType = 'nodebuffer';
  await open(tunnelWs);
  await sleep(50);

  const agentWs = new WebSocket(`ws://127.0.0.1:${agentWss.address().port}`);
  agentWs.binaryType = 'nodebuffer';
  await open(agentWs);
  await sleep(50);

  const tunnelCollector = makeCollector(tunnelWs);
  const agentCollector = makeCollector(agentWs);

  return {
    sm,
    cm,
    agentServer,
    allowedPort,
    agentWs,
    tunnelWs,
    tunnelCollector,
    agentCollector,
    async openStream() {
      buildJsonFrame(this.agentWs, PROTO.TYPE.TCP_CONNECT, 0, { port: this.allowedPort });
      const tunnelOpen = await this.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN);
      const streamId = tunnelOpen.streamId;
      this.tunnelWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN_ACK, streamId), { binary: true });
      await this.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK, streamId);
      return streamId;
    },
    async cleanup() {
      try {
        agentWs.terminate();
      } catch {}
      try {
        tunnelWs.terminate();
      } catch {}
      await new Promise((r) => agentWss.close(r));
      await new Promise((r) => tunnelWss.close(r));
    },
  };
}

describe('FrameCodec negative cases', () => {
  it('throws on buffers shorter than the six-byte header', () => {
    assert.throws(() => FrameCodec.parseFrame(Buffer.from([0x01, 0x02, 0x03])), /Frame too short/);
  });

  it('throws on unsupported protocol versions', () => {
    const frame = FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, 1, Buffer.from('x'));
    frame[0] = 0x02;
    assert.throws(() => FrameCodec.parseFrame(frame), /Unsupported protocol version/);
  });

  it('parses unknown frame types without throwing', () => {
    const frame = FrameCodec.buildFrame(0x99, 7, Buffer.from('x'));
    const parsed = FrameCodec.parseFrame(frame);
    assert.equal(parsed.type, 0x99);
    assert.equal(parsed.streamId, 7);
  });

  it('throws on empty JSON payloads', () => {
    assert.throws(() => FrameCodec.parseJsonPayload(Buffer.alloc(0)), /Empty JSON payload/);
  });

  it('throws on invalid JSON payloads', () => {
    assert.throws(() => FrameCodec.parseJsonPayload(Buffer.from('not json')), SyntaxError);
  });

  it('throws on oversized JSON payloads', () => {
    const large = Buffer.from(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
    assert.throws(() => FrameCodec.parseJsonPayload(large, 64 * 1024), /JSON payload too large/);
  });
});

describe('TcpAgentServer frame rejection', () => {
  it('rejects TCP_CONNECT with a prohibited non-zero stream id', async () => {
    const env = await setupAgentEnv();
    try {
      buildJsonFrame(env.agentWs, PROTO.TYPE.TCP_CONNECT, 7, { port: env.allowedPort });
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 7);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Invalid TCP_CONNECT streamId' });
      assert.equal(env.sm.streams.size, 0);
      assert.equal(env.agentServer._connCountByPort.get(env.allowedPort) || 0, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects TCP_CONNECT with invalid JSON without creating state', async () => {
    const env = await setupAgentEnv();
    try {
      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT, 0, Buffer.from('not json')));
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Port not allowed' });
      assert.equal(env.sm.streams.size, 0);
      assert.equal(env.agentServer._connCountByPort.get(env.allowedPort) || 0, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects TCP_CONNECT with an oversized payload', async () => {
    const env = await setupAgentEnv();
    try {
      const oversized = Buffer.from(JSON.stringify({ port: env.allowedPort, padding: 'x'.repeat(70 * 1024) }));
      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT, 0, oversized));
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Port not allowed' });
      assert.equal(env.sm.streams.size, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('ignores TCP_DATA before the client confirms open, then flows after ACK', async () => {
    const env = await setupAgentEnv();
    try {
      buildJsonFrame(env.agentWs, PROTO.TYPE.TCP_CONNECT, 0, { port: env.allowedPort });
      const tunnelOpen = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN);
      const streamId = tunnelOpen.streamId;

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('early')));
      await env.tunnelCollector.assertQuiet();
      await env.agentCollector.assertQuiet();
      assert.equal(env.sm.streams.size, 1, 'stream must still exist while awaiting client ACK');

      env.tunnelWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN_ACK, streamId), { binary: true });
      await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK, streamId);

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('after')));
      const forwarded = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId);
      assert.equal(forwarded.payload.toString(), 'after');
      assert.equal(env.sm.streams.size, 1);
    } finally {
      await env.cleanup();
    }
  });

  it('ignores a duplicate TCP_OPEN_ACK without changing state', async () => {
    const env = await setupAgentEnv();
    try {
      const streamId = await env.openStream();

      env.tunnelWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN_ACK, streamId), { binary: true });
      await env.agentCollector.assertQuiet();
      await env.tunnelCollector.assertQuiet();
      assert.equal(env.sm.streams.size, 1, 'stream must survive a duplicate ACK');

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('ping')));
      const forwarded = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId);
      assert.equal(forwarded.payload.toString(), 'ping');
    } finally {
      await env.cleanup();
    }
  });

  it('aborts on TCP_DATA for a closed stream without leaking state', async () => {
    const env = await setupAgentEnv();
    try {
      const streamId = await env.openStream();

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_CLOSE, streamId);
      await sleep(50);
      assert.equal(env.sm.streams.size, 0);
      assert.equal(env.agentServer._connCountByPort.get(env.allowedPort) || 0, 0);

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('zombie')));
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, streamId);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Stream not found' });
      assert.equal(env.sm.streams.size, 0);
      assert.equal(env.agentServer._connCountByPort.get(env.allowedPort) || 0, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('handles a duplicate TCP_CLOSE without leaking state', async () => {
    const env = await setupAgentEnv();
    try {
      const streamId = await env.openStream();

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));

      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_CLOSE, streamId);
      await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, streamId);
      await sleep(50);
      assert.equal(env.sm.streams.size, 0);
      assert.equal(env.agentServer._connCountByPort.get(env.allowedPort) || 0, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('ignores control frames for unknown streams without creating state', async () => {
    const env = await setupAgentEnv();
    try {
      const unknownId = 777;
      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.PAUSE, unknownId));
      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.RESUME, unknownId));
      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_ABORT, unknownId, Buffer.from('{}')));
      buildFrame(env.agentWs, FrameCodec.buildFrame(0x99, unknownId));

      await env.agentCollector.assertQuiet();
      await env.tunnelCollector.assertQuiet();
      assert.equal(env.sm.streams.size, 0);
      assert.equal(env.agentServer._connCountByPort.get(env.allowedPort) || 0, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('ignores unknown frame types on an existing stream without changing state', async () => {
    const env = await setupAgentEnv();
    try {
      const streamId = await env.openStream();

      buildFrame(env.agentWs, FrameCodec.buildFrame(0x99, streamId, Buffer.from('x')));
      await env.agentCollector.assertQuiet();
      await env.tunnelCollector.assertQuiet();
      assert.equal(env.sm.streams.size, 1);

      buildFrame(env.agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('still alive')));
      const forwarded = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId);
      assert.equal(forwarded.payload.toString(), 'still alive');
    } finally {
      await env.cleanup();
    }
  });
});
