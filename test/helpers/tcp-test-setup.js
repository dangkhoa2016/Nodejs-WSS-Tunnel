import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameCodec, PROTO } from '../../src/shared/protocol.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const TCP_HANDLER_DEFAULTS = {
  MAX_CONCURRENT_STREAMS: 200,
  TCP_TUNNEL_HOST: '127.0.0.1',
  TCP_CLIENT_ALLOWED_HOSTS: ['127.0.0.1'],
  TCP_CONNECT_TIMEOUT_MS: 5000,
  WS_HIGH_WATER: 1024 * 1024,
  WS_LOW_WATER: 512 * 1024,
};

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

/**
 * Sets up a WebSocket server + client pair with a TcpClientHandler wired in.
 *
 * @param {object} opts
 * @param {number} opts.port - WebSocket port
 * @param {Function} [opts.onClientMessage] - Custom handler for client WS messages
 * @returns {Promise<{ serverWs, clientWs, cleanup, streams, tcpHandler }>}
 */
export async function setupTcpPair({ port, onClientMessage }) {
  const cleanup = [];
  const { StreamManager } = await import('../../src/StreamManager.js');
  const { createTcpClientHandler } = await import('../../src/tcp/TcpClientHandler.js');

  const sm = new StreamManager();
  const streams = sm.streams;

  const wss = new WebSocketServer({ port });
  cleanup.push(() => new Promise((resolve) => wss.close(resolve)));
  await new Promise((r) => wss.on('listening', r));

  let serverWs;
  wss.on('connection', (ws) => {
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
  await sleep(50);

  const tcpHandler = createTcpClientHandler({
    ...TCP_HANDLER_DEFAULTS,
    streams,
    sendFrame: buildSendFrame(clientWs),
    sendJsonFrame: buildSendJsonFrame(clientWs),
    buildFrame: FrameCodec.buildFrame,
    parseJsonPayload: (p) => JSON.parse(p.toString('utf8')),
    resetIdleTimer: () => {},
    cleanupStream: () => {},
  });

  if (onClientMessage) {
    clientWs.on('message', onClientMessage);
  } else {
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
  }

  return { serverWs, clientWs, cleanup, streams, tcpHandler };
}

export async function createEchoServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function canConnect(host, port, { timeout = 1000, attempts = 6, retryDelay = 500 } = {}) {
  return new Promise((resolve) => {
    let remaining = attempts;
    const tryOnce = () => {
      const socket = new net.Socket();
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ok) return resolve(true);
        remaining -= 1;
        if (remaining > 0) return setTimeout(tryOnce, retryDelay);
        resolve(false);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.once('timeout', () => settle(false));
      socket.connect(port, host);
    };
    tryOnce();
  });
}

export { PROTO, sleep, FrameCodec };
