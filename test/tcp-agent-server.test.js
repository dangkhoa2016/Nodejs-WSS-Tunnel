import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { syncTcpBackpressure } from '../src/TcpFlowControl.js';
import { FrameCodec, PROTO } from '../src/protocol.js';
import { createEchoServer } from './helpers/tcp-test-setup.js';

const TCP_HANDLER_DEFAULTS = {
  MAX_CONCURRENT_STREAMS: 200,
  TCP_TUNNEL_HOST: '127.0.0.1',
  TCP_CLIENT_ALLOWED_HOSTS: ['127.0.0.1'],
  TCP_CONNECT_TIMEOUT_MS: 5000,
  WS_HIGH_WATER: 1024 * 1024,
  WS_LOW_WATER: 512 * 1024,
};

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

function buildSendFrame(ws) {
  return (frame) => {
    if (ws.readyState === 1) ws.send(frame, { binary: true });
    return true;
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

async function setupAgentEnv({ allowedPorts, maxConnectionsPerPort = 0, maxStreamsPerAgent = 0 } = {}) {
  const { StreamManager } = await import('../src/StreamManager.js');
  const { ClientManager } = await import('../src/ClientManager.js');
  const { TcpRouter } = await import('../src/TcpRouter.js');
  const { TcpAgentServer } = await import('../src/TcpAgentServer.js');
  const { createTcpClientHandler } = await import('../src/TcpClientHandler.js');

  const sm = new StreamManager();
  const cm = new ClientManager(sm);
  const tcpRouter = new TcpRouter(sm, cm);

  const echo = await createEchoServer();
  const echoPort = echo.port;
  const agentServer = new TcpAgentServer(sm, tcpRouter, {
    allowedPorts: allowedPorts ?? [echoPort],
    maxConnectionsPerPort,
    maxStreamsPerAgent,
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

  const clientStreams = new Map();
  const tcpHandler = createTcpClientHandler({
    ...TCP_HANDLER_DEFAULTS,
    streams: clientStreams,
    sendFrame: (ws, frame) => {
      if (ws.readyState === 1) ws.send(frame, { binary: true });
      return true;
    },
    sendJsonFrame: (ws, type, streamId, obj) => {
      if (ws.readyState === 1) {
        ws.send(FrameCodec.buildFrame(type, streamId, Buffer.from(JSON.stringify(obj))), { binary: true });
      }
      return true;
    },
    buildFrame: FrameCodec.buildFrame,
    parseJsonPayload: (p) => JSON.parse(p.toString('utf8')),
    resetIdleTimer: () => {},
    cleanupStream: () => {},
  });

  tunnelWs.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let frame;
    try {
      frame = FrameCodec.parseFrame(data);
    } catch {
      return;
    }
    tcpHandler.handleServerFrame(
      frame.type,
      tunnelWs,
      frame.streamId,
      frame.payload,
      clientStreams.get(frame.streamId),
    );
  });

  const tunnelCollector = makeCollector(tunnelWs);
  const agentCollector = makeCollector(agentWs);

  return {
    sm,
    cm,
    tcpRouter,
    agentServer,
    echoPort,
    agentWs,
    tunnelWs,
    tunnelCollector,
    agentCollector,
    clientStreams,
    async cleanup() {
      try {
        agentWs.terminate();
      } catch {}
      try {
        tunnelWs.terminate();
      } catch {}
      await new Promise((r) => agentWss.close(r));
      await new Promise((r) => tunnelWss.close(r));
      await echo.close();
    },
  };
}

describe('TCP agent protocol', () => {
  it('defines TCP_CONNECT and TCP_CONNECT_ACK frame types', () => {
    assert.equal(PROTO.TYPE.TCP_CONNECT, 0x50);
    assert.equal(PROTO.TYPE.TCP_CONNECT_ACK, 0x51);
  });
});

describe('TcpAgentServer (in-process)', () => {
  it('rejects a connect to a port that is not allowed', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: 99999 });

      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Port not allowed' });
      assert.equal(env.sm.streams.size, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects a connect with no payload', async () => {
    const env = await setupAgentEnv({ allowedPorts: [] });
    try {
      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT, 0));

      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Port not allowed' });
    } finally {
      await env.cleanup();
    }
  });

  it('rejects a connect when no tunnel client is connected', async () => {
    const env = await setupAgentEnv({ allowedPorts: [9000] });
    try {
      env.tunnelWs.terminate();
      await sleep(100);
      assert.equal(env.sm.streams.size, 0);

      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: 9000 });

      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'No tunnel client connected' });
    } finally {
      await env.cleanup();
    }
  });

  it('relays data end-to-end through the tunnel client', async () => {
    const env = await setupAgentEnv();
    try {
      const allowedPort = env.echoPort;
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: allowedPort });

      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const ackInfo = JSON.parse(ack.payload.toString());
      assert.equal(ackInfo.port, allowedPort);
      const streamId = ack.streamId;
      assert.ok(streamId > 0);

      const tunnelOpen = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);
      assert.deepEqual(JSON.parse(tunnelOpen.payload.toString()), { host: '127.0.0.1', port: allowedPort });

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('hello')));

      const echoed = await env.agentCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId);
      assert.equal(echoed.payload.toString(), 'hello');
    } finally {
      await env.cleanup();
    }
  });

  it('forwards agent TCP_CLOSE to the tunnel client and cleans the stream', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));

      const close = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_CLOSE, streamId);
      assert.equal(close.streamId, streamId);
      await sleep(50);
      assert.equal(env.sm.streams.size, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('propagates tunnel client stream close back to the agent', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);
      await sleep(100);

      const clientState = env.clientStreams.get(streamId);
      assert.ok(clientState?.localSocket, 'client should have a local socket');
      clientState.localSocket.destroy();

      const close = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CLOSE, streamId);
      assert.equal(close.streamId, streamId);
      await sleep(50);
      assert.equal(env.sm.streams.size, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('forwards agent PAUSE and RESUME to the tunnel client', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId));
      const pause = await env.tunnelCollector.waitFor(PROTO.TYPE.PAUSE, streamId);
      assert.equal(pause.streamId, streamId);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId));
      const resume = await env.tunnelCollector.waitFor(PROTO.TYPE.RESUME, streamId);
      assert.equal(resume.streamId, streamId);
    } finally {
      await env.cleanup();
    }
  });

  it('aborts agent streams when the agent WebSocket disconnects', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);

      env.agentWs.terminate();

      const abort = await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_ABORT, streamId);
      assert.equal(abort.streamId, streamId);
      await sleep(50);
      assert.equal(env.sm.streams.size, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('sends TCP_ABORT to the agent when the tunnel client disconnects', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);

      env.tunnelWs.terminate();

      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, streamId);
      assert.equal(abort.streamId, streamId);
      assert.equal(typeof JSON.parse(abort.payload.toString()).message, 'string');
      await sleep(50);
      assert.equal(env.sm.streams.size, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('enforces the per-port connection limit', async () => {
    const env = await setupAgentEnv({ maxConnectionsPerPort: 1 });
    try {
      const allowedPort = env.echoPort;
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: allowedPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, ack.streamId);

      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: allowedPort });
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Per-port connection limit reached' });
    } finally {
      await env.cleanup();
    }
  });

  it('supports multiple concurrent streams with distinct ids', async () => {
    const env = await setupAgentEnv();
    try {
      const allowedPort = env.echoPort;
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: allowedPort });
      const ack1 = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId1 = ack1.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId1);

      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: allowedPort });
      const ack2 = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId2 = ack2.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId2);

      assert.notEqual(streamId1, streamId2);
      assert.equal(env.sm.streams.size, 2);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId1, Buffer.from('one')));
      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId2, Buffer.from('two')));

      const echo1 = await env.agentCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId1);
      const echo2 = await env.agentCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId2);
      assert.equal(echo1.payload.toString(), 'one');
      assert.equal(echo2.payload.toString(), 'two');
    } finally {
      await env.cleanup();
    }
  });

  it('enforces the per-agent stream limit', async () => {
    const env = await setupAgentEnv({ maxStreamsPerAgent: 1 });
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, ack.streamId);

      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Agent stream limit reached' });
    } finally {
      await env.cleanup();
    }
  });

  it('releases the per-agent stream slot after a stream closes', async () => {
    const env = await setupAgentEnv({ maxStreamsPerAgent: 1 });
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, ack.streamId);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, ack.streamId));
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_CLOSE, ack.streamId);
      await sleep(50);

      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack2 = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      assert.ok(ack2.streamId > 0);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects TCP_CONNECT with a non-zero stream id', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 7, { port: env.echoPort });
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 7);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Invalid TCP_CONNECT streamId' });
    } finally {
      await env.cleanup();
    }
  });

  it('aborts on an unparsable frame instead of swallowing it', async () => {
    const env = await setupAgentEnv();
    try {
      env.agentWs.send(Buffer.from([0xff, 0x00, 0x01]), { binary: true });
      const abort = await env.agentCollector.waitFor(PROTO.TYPE.TCP_ABORT, 0);
      assert.deepEqual(JSON.parse(abort.payload.toString()), { message: 'Invalid frame' });
    } finally {
      await env.cleanup();
    }
  });

  it('forwards tunnel client PAUSE/RESUME to the agent', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);

      buildSendFrame(env.tunnelWs)(FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId));
      const pause = await env.agentCollector.waitFor(PROTO.TYPE.PAUSE, streamId);
      assert.equal(pause.streamId, streamId);

      buildSendFrame(env.tunnelWs)(FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId));
      const resume = await env.agentCollector.waitFor(PROTO.TYPE.RESUME, streamId);
      assert.equal(resume.streamId, streamId);
    } finally {
      await env.cleanup();
    }
  });

  it('relays data intact while the tunnel client pauses and resumes', async () => {
    const env = await setupAgentEnv();
    try {
      buildSendJsonFrame(env.agentWs)(PROTO.TYPE.TCP_CONNECT, 0, { port: env.echoPort });
      const ack = await env.agentCollector.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
      const streamId = ack.streamId;
      await env.tunnelCollector.waitFor(PROTO.TYPE.TCP_OPEN, streamId);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('aaa')));
      const echoed = await env.agentCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId);
      assert.equal(echoed.payload.toString(), 'aaa');

      buildSendFrame(env.tunnelWs)(FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId));
      await env.agentCollector.waitFor(PROTO.TYPE.PAUSE, streamId);

      buildSendFrame(env.agentWs)(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('bbb')));
      buildSendFrame(env.tunnelWs)(FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId));
      await env.agentCollector.waitFor(PROTO.TYPE.RESUME, streamId);

      const echoed2 = await env.agentCollector.waitFor(PROTO.TYPE.TCP_DATA, streamId);
      assert.equal(echoed2.payload.toString(), 'bbb');
      await sleep(50);
      assert.equal(env.sm.streams.size, 1);
    } finally {
      await env.cleanup();
    }
  });
});

describe('TcpAgentServer backpressure', () => {
  it('does not send RESUME while the agent is still paused', () => {
    const sent = [];
    const state = {
      id: 3,
      agentPaused: true,
      wsBackpressured: true,
      clientPausedForAgent: false,
      ws: {
        readyState: 1,
        send: (frame) => {
          sent.push(FrameCodec.parseFrame(frame));
          return true;
        },
      },
    };

    syncTcpBackpressure(state);
    assert.equal(state.clientPausedForAgent, true);
    assert.deepEqual(
      sent.map((f) => f.type),
      [PROTO.TYPE.PAUSE],
    );

    // Drain clears WS pressure, but the agent is still paused -> no RESUME.
    state.wsBackpressured = false;
    syncTcpBackpressure(state);
    assert.equal(state.clientPausedForAgent, true);
    assert.equal(sent.length, 1);

    // Agent resumes -> RESUME sent.
    state.agentPaused = false;
    syncTcpBackpressure(state);
    assert.equal(state.clientPausedForAgent, false);
    assert.deepEqual(
      sent.map((f) => f.type),
      [PROTO.TYPE.PAUSE, PROTO.TYPE.RESUME],
    );
  });

  it('does not send a second PAUSE while already paused', () => {
    const sent = [];
    const state = {
      id: 3,
      agentPaused: false,
      wsBackpressured: true,
      clientPausedForAgent: false,
      ws: {
        readyState: 1,
        send: (frame) => {
          sent.push(FrameCodec.parseFrame(frame));
          return true;
        },
      },
    };

    syncTcpBackpressure(state); // ws pressure on
    syncTcpBackpressure(state); // still pressured
    state.agentPaused = true; // agent pause overlaps
    syncTcpBackpressure(state);
    state.wsBackpressured = false;
    syncTcpBackpressure(state); // agent still paused
    assert.deepEqual(
      sent.map((f) => f.type),
      [PROTO.TYPE.PAUSE],
    );

    state.agentPaused = false;
    syncTcpBackpressure(state);
    assert.deepEqual(
      sent.map((f) => f.type),
      [PROTO.TYPE.PAUSE, PROTO.TYPE.RESUME],
    );
  });
});
