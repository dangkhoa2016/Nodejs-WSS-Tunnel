import net from 'node:net';
import WebSocket from 'ws';

import { logError, logStandard, logVerbose } from '../src/logging.js';
import { FrameCodec, PROTO, sendFrame, sendJsonFrame } from '../src/protocol.js';

if (process.env.NODE_ENV === 'development') {
  try {
    await import('dotenv/config');
  } catch {
    // ignore
  }
}

/**
 * tcp-agent.js
 *
 * TCP agent over WebSocket. Runs alongside an external app (e.g. Rails) and
 * lets the app reach tunneled TCP services (e.g. Redis) through the public
 * tunnel server, without opening any inbound port on the server.
 *
 * - Listens on AGENT_BIND_HOST:AGENT_PORTS (loopback only, default 127.0.0.1).
 * - For each local connection, sends TCP_CONNECT to the server.
 * - On TCP_CONNECT_ACK, bridges bytes in both directions via TCP_DATA frames.
 * - Honours TCP_CLOSE/TCP_ABORT and PAUSE/RESUME for correct teardown and
 *   backpressure.
 *
 * NOTE: This file imports shared protocol/modules from src/. When bundled
 * with esbuild, the agent can be deployed independently without shipping the
 * full server tree.
 *
 * Required env vars:
 *   TUNNEL_SERVER_URL
 *   TUNNEL_USERNAME
 *   TUNNEL_PASSWORD
 *   AGENT_PORTS
 *
 * Credentials: AGENT_USERNAME/AGENT_PASSWORD, falling back to
 * TUNNEL_USERNAME/TUNNEL_PASSWORD.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.TUNNEL_SERVER_URL || '';
const USERNAME = process.env.AGENT_USERNAME || process.env.TUNNEL_USERNAME || '';
const PASSWORD = process.env.AGENT_PASSWORD || process.env.TUNNEL_PASSWORD || '';

const BIND_HOST = process.env.AGENT_BIND_HOST || '127.0.0.1';
const AGENT_PORTS = (process.env.AGENT_PORTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

const WS_HIGH_WATER = Number(process.env.WS_HIGH_WATER_BYTES || 1 * 1024 * 1024);
const WS_LOW_WATER = Math.floor(WS_HIGH_WATER / 2);

if (!SERVER_URL || !USERNAME || !PASSWORD || AGENT_PORTS.length === 0) {
  console.error(
    '[tcp-agent] TUNNEL_SERVER_URL, credentials (AGENT_USERNAME/AGENT_PASSWORD or TUNNEL_USERNAME/TUNNEL_PASSWORD), and AGENT_PORTS are required.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

let ws = null;
let shuttingDown = false;

// streamId -> { socket, streamId, pendingSends, pausedForWs, peerPausedRead, localWriteBackpressured, cleaned }
const streamedSockets = new Map();
// FIFO of local connections waiting for a TCP_CONNECT_ACK: { localSocket, port }
const pendingConnects = [];

const listeners = [];

function wsReady() {
  return ws && ws.readyState === WebSocket.OPEN;
}

// ---------------------------------------------------------------------------
// Local listener
// ---------------------------------------------------------------------------

function createLocalListener(port) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    // Do not emit data until the server acknowledges the stream.
    socket.pause();

    const removePending = () => {
      const idx = pendingConnects.findIndex((e) => e.localSocket === socket);
      if (idx !== -1) pendingConnects.splice(idx, 1);
    };

    socket.on('error', () => {
      removePending();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
    socket.on('close', removePending);

    if (!wsReady()) {
      socket.destroy();
      return;
    }

    const entry = { localSocket: socket, port };
    pendingConnects.push(entry);

    logVerbose('agent', 'local_connect_received', { port, pending: pendingConnects.length });

    try {
      ws.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT, 0, Buffer.from(JSON.stringify({ port }))), {
        binary: true,
      });
      logVerbose('agent', 'tcp_connect_sent', { port });
    } catch {
      removePending();
      socket.destroy();
    }
  });

  server.on('error', (err) => {
    logError('agent', 'listener_error', { port, message: err.message });
  });

  server.listen(port, BIND_HOST, () => {
    logStandard('agent', 'listening', { bind_host: BIND_HOST, port });
  });

  listeners.push(server);
}

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

function registerStream(streamId, socket, port) {
  if (!socket || socket.destroyed) return;
  const entry = {
    socket,
    streamId,
    pendingSends: 0,
    pausedForWs: false,
    peerPausedRead: false,
    localWriteBackpressured: false,
    cleaned: false,
  };

  streamedSockets.set(streamId, entry);

  logVerbose('agent', 'stream_registered', { streamId, port });

  // Local app -> server. Self-throttle on the WebSocket outbound buffer.
  socket.on('data', (chunk) => {
    if (entry.cleaned || !wsReady()) return;

    entry.pendingSends++;
    let sendOk = true;
    try {
      ws.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, chunk), { binary: true }, () => {
        entry.pendingSends--;
        if (!entry.cleaned && entry.pausedForWs && entry.pendingSends === 0 && ws.bufferedAmount <= WS_LOW_WATER) {
          entry.pausedForWs = false;
          syncReadState(entry);
        }
      });
    } catch {
      sendOk = false;
    }

    if (!sendOk) {
      abortStream(entry, 'Failed to send TCP_DATA');
      return;
    }

    if (ws.bufferedAmount > WS_HIGH_WATER && !entry.pausedForWs) {
      entry.pausedForWs = true;
      syncReadState(entry);
    }
  });

  // Server -> local app. Backpressure on the local socket write side.
  socket.on('drain', () => {
    if (entry.cleaned) return;
    if (entry.localWriteBackpressured && wsReady()) {
      entry.localWriteBackpressured = false;
      sendFrame(ws, FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId));
    }
  });

  socket.on('error', (err) => {
    if (entry.cleaned) return;
    entry.cleaned = true;
    streamedSockets.delete(streamId);
    if (wsReady()) {
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, streamId, { message: err.message || 'Local socket error' });
    }
    logVerbose('agent', 'stream_aborted', { streamId, message: err.message || 'Local socket error' });
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });

  socket.on('close', () => {
    if (entry.cleaned) return;
    entry.cleaned = true;
    streamedSockets.delete(streamId);
    if (wsReady()) {
      sendFrame(ws, FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
    }
    logVerbose('agent', 'stream_closed', { streamId, port });
  });

  socket.resume();
}

function abortStream(entry, message) {
  if (entry.cleaned) return;
  entry.cleaned = true;
  streamedSockets.delete(entry.streamId);
  if (wsReady()) {
    sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, entry.streamId, { message });
  }
  logVerbose('agent', 'stream_aborted', { streamId: entry.streamId, message });
  try {
    entry.socket.destroy();
  } catch {
    // ignore
  }
}

function cleanupAll() {
  for (const entry of pendingConnects.splice(0)) {
    try {
      entry.localSocket.destroy();
    } catch {
      // ignore
    }
  }
  for (const entry of [...streamedSockets.values()]) {
    entry.cleaned = true;
    streamedSockets.delete(entry.streamId);
    try {
      entry.socket.destroy();
    } catch {
      // ignore
    }
  }
}

function syncReadState(entry) {
  if (entry.cleaned || entry.socket.destroyed) return;
  if (entry.peerPausedRead || entry.pausedForWs || !wsReady()) {
    entry.socket.pause();
  } else {
    entry.socket.resume();
  }
}

// ---------------------------------------------------------------------------
// Server frames
// ---------------------------------------------------------------------------

function handleServerFrame(data) {
  let frame;
  try {
    frame = FrameCodec.parseFrame(data);
  } catch {
    return;
  }

  const { type, streamId, payload } = frame;

  switch (type) {
    case PROTO.TYPE.TCP_CONNECT_ACK: {
      handleConnectAck(streamId, payload);
      break;
    }

    case PROTO.TYPE.TCP_DATA: {
      const entry = streamedSockets.get(streamId);
      if (!entry || entry.cleaned) break;
      let ok = true;
      try {
        ok = entry.socket.write(payload);
      } catch {
        abortStream(entry, 'Failed to write to local socket');
        break;
      }
      if (!ok && !entry.localWriteBackpressured) {
        entry.localWriteBackpressured = true;
        sendFrame(ws, FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId));
      }
      break;
    }

    case PROTO.TYPE.TCP_CLOSE: {
      const entry = streamedSockets.get(streamId);
      if (!entry || entry.cleaned) break;
      entry.cleaned = true;
      streamedSockets.delete(streamId);
      try {
        entry.socket.end();
      } catch {
        // ignore
      }
      break;
    }

    case PROTO.TYPE.TCP_ABORT: {
      if (streamId === 0) {
        // The TCP_CONNECT request was rejected (e.g. port not allowed).
        handleConnectReject(payload);
        break;
      }
      const entry = streamedSockets.get(streamId);
      if (!entry || entry.cleaned) break;
      entry.cleaned = true;
      streamedSockets.delete(streamId);
      try {
        entry.socket.destroy();
      } catch {
        // ignore
      }
      break;
    }

    case PROTO.TYPE.PAUSE: {
      const entry = streamedSockets.get(streamId);
      if (!entry || entry.cleaned) break;
      entry.peerPausedRead = true;
      syncReadState(entry);
      break;
    }

    case PROTO.TYPE.RESUME: {
      const entry = streamedSockets.get(streamId);
      if (!entry || entry.cleaned) break;
      entry.peerPausedRead = false;
      syncReadState(entry);
      break;
    }

    default: {
      break;
    }
  }
}

function handleConnectAck(streamId, payload) {
  let info = {};
  try {
    info = FrameCodec.parseJsonPayload(payload);
  } catch {
    return;
  }

  const idx = pendingConnects.findIndex((entry) => entry.port === Number(info.port));
  if (idx === -1) return;

  const [entry] = pendingConnects.splice(idx, 1);
  registerStream(streamId, entry.localSocket, entry.port);
  logVerbose('agent', 'connect_ack_received', { port: entry.port, streamId });
}

function handleConnectReject(payload) {
  let info = {};
  try {
    info = FrameCodec.parseJsonPayload(payload);
  } catch {
    /* ignore */
  }

  const idx = pendingConnects.findIndex((entry) => entry.port === Number(info.port));
  if (idx === -1) return;

  const [entry] = pendingConnects.splice(idx, 1);
  logVerbose('agent', 'connect_rejected', { port: info.port, message: info.message || '' });
  try {
    entry.localSocket.destroy();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

function connect() {
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  const wsUrl = new URL(SERVER_URL);
  wsUrl.username = USERNAME;
  wsUrl.password = PASSWORD;

  ws = new WebSocket(wsUrl.href, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`,
    },
    handshakeTimeout: 10000,
  });
  ws.binaryType = 'nodebuffer';

  ws.on('open', () => {
    logStandard('agent', 'connected');
  });

  ws.on('message', (data) => {
    handleServerFrame(data);
  });

  ws.on('close', (code, reason) => {
    logStandard('agent', 'disconnected', { code, reason: reason?.toString() || '' });
    cleanupAll();
  });

  ws.on('error', (err) => {
    logStandard('agent', 'error', { message: err.message });
  });

  ws.on('drain', () => {
    for (const entry of streamedSockets.values()) {
      if (entry.pausedForWs && entry.pendingSends === 0 && ws.bufferedAmount <= WS_LOW_WATER) {
        entry.pausedForWs = false;
        syncReadState(entry);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  logStandard('agent', 'shutdown');

  cleanupAll();

  for (const server of listeners) {
    try {
      server.close();
    } catch {
      // ignore
    }
  }

  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

logStandard('agent', 'start', {
  server_url: SERVER_URL,
  ports: AGENT_PORTS.join(','),
  bind_host: BIND_HOST,
});

for (const port of AGENT_PORTS) {
  createLocalListener(port);
}

connect();
