import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../src/shared/protocol.js';

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
  };
}

function buildSendJsonFrame(ws) {
  return (type, streamId, obj) => {
    if (ws.readyState === 1) {
      ws.send(FrameCodec.buildFrame(type, streamId, Buffer.from(JSON.stringify(obj))), { binary: true });
    }
    return true;
  };
}

async function setupAgentEnv() {
  const { StreamManager } = await import('../src/StreamManager.js');
  const { ClientManager } = await import('../src/ClientManager.js');
  const { TcpRouter } = await import('../src/TcpRouter.js');
  const { TcpAgentServer } = await import('../src/TcpAgentServer.js');

  const sm = new StreamManager();
  const cm = new ClientManager(sm);
  const tcpRouter = new TcpRouter(sm, cm);
  const agentServer = new TcpAgentServer(sm, tcpRouter, {
    allowedPorts: [6379],
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
    tcpRouter,
    agentServer,
    agentWs,
    tunnelWs,
    tunnelCollector,
    agentCollector,
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

describe('TCP_OPEN_ACK protocol', () => {
  it('defines the TCP_OPEN_ACK frame type', () => {
    assert.equal(PROTO.TYPE.TCP_OPEN_ACK, 0x44);
  });
});

describe('deferred TCP_CONNECT_ACK (race condition fix)', () => {
  it('defers TCP_CONNECT_ACK until the tunnel client confirms TCP_OPEN', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: 6379 });

      const tunnelOpen = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN);
      const streamId = tunnelOpen.streamId;
      assert.deepEqual(JSON.parse(tunnelOpen.payload.toString()), { host: '127.0.0.1', port: 6379 });

      // Server must NOT ACK the agent until the client confirms.
      await assert.rejects(
        () => env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK, null, 150),
        /timeout waiting for frame/,
      );

      // Client confirms -> ACK arrives with the correct stream id and port.
      env.tunnelWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN_ACK, streamId), { binary: true });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK, streamId);
      assert.deepEqual(JSON.parse(ack.payload.toString()), { port: 6379 });
    } finally {
      await env.cleanup();
    }
  });

  it('sends TCP_ABORT to the agent instead of ACK when the client rejects TCP_OPEN', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: 6379 });

      const tunnelOpen = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN);
      const streamId = tunnelOpen.streamId;

      env.tunnelWs.send(
        FrameCodec.buildFrame(
          PROTO.TYPE.TCP_ABORT,
          streamId,
          Buffer.from(JSON.stringify({ message: 'Host not allowed' })),
        ),
        { binary: true },
      );

      // The agent has not been ACKed yet, so the server rejects the pending
      // connect by port (streamId 0 + { port }) so the agent can match it.
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { port: 6379, message: 'Host not allowed' });

      // The agent must never receive a TCP_CONNECT_ACK for the rejected stream.
      await assert.rejects(
        () => env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK, streamId, 150),
        /timeout waiting for frame/,
      );

      await sleep(50);
      assert.equal(env.sm.streams.size, 0, 'stream should be cleaned up after client reject');
    } finally {
      await env.cleanup();
    }
  });

  it('replies TCP_ABORT for agent data on an unknown stream instead of silently dropping', async () => {
    const env = await setupAgentEnv();
    try {
      env.agentWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, 999, Buffer.from('x')), { binary: true });
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 999);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Stream not found' });
    } finally {
      await env.cleanup();
    }
  });
});
