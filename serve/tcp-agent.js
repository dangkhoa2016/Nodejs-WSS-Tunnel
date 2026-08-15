import { renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';

import { logError, logStandard, logVerbose } from '../src/shared/logging.js';
import { parseAgentPorts } from '../src/shared/port-parser.js';
import { FrameCodec, PROTO, sendFrame, sendJsonFrame } from '../src/shared/protocol.js';
import { readInteger } from '../src/shared/runtime-config.js';

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
 * - Reconnects to the server with exponential backoff.
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

{
  const loopback = BIND_HOST === '127.0.0.1' || BIND_HOST === '::1';
  if (!loopback && process.env.ALLOW_REMOTE_AGENT_BIND !== '1') {
    console.error('[tcp-agent] Refusing non-loopback AGENT_BIND_HOST without ALLOW_REMOTE_AGENT_BIND=1');
    process.exit(1);
  }
}

if (!SERVER_URL || !USERNAME || !PASSWORD) {
  console.error(
    '[tcp-agent] TUNNEL_SERVER_URL and credentials (AGENT_USERNAME/AGENT_PASSWORD or TUNNEL_USERNAME/TUNNEL_PASSWORD) are required.',
  );
  process.exit(1);
}

let AGENT_PORTS;
try {
  AGENT_PORTS = parseAgentPorts(process.env.AGENT_PORTS || '');
} catch (err) {
  console.error(`[tcp-agent] ${err.message}`);
  process.exit(1);
}

const WS_HIGH_WATER = readInteger('WS_HIGH_WATER_BYTES', 1 * 1024 * 1024, { min: 1024 });
const WS_LOW_WATER = Math.floor(WS_HIGH_WATER / 2);

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

let ws = null;
let reconnectTimer = null;
let reconnectDelay = readInteger('AGENT_RECONNECT_DELAY_MS', 1000, { min: 100 });
let reconnectAttempt = 0;
let authFailed = false;
let shuttingDown = false;

// streamId -> { socket, streamId, pendingSends, pausedForWs, peerPausedRead, localWriteBackpressured, cleaned }
const streamedSockets = new Map();
// FIFO of local connections waiting for a TCP_CONNECT_ACK: { localSocket, port }
const pendingConnects = [];

const listeners = [];

// Ports requested via AGENT_PORTS that must all be listening before the agent
// may report ready.
const requestedPorts = new Set(AGENT_PORTS);
// Ports whose listener has actually emitted "listening".
const listeningPorts = new Set();
// True once every listener is up AND the WebSocket is open.
let ready = false;

function wsReady() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function allListenersListening() {
  for (const port of requestedPorts) {
    if (!listeningPorts.has(port)) return false;
  }
  return true;
}

function writeReadyFile() {
  const readyFile = process.env.AGENT_READY_FILE;
  if (!readyFile) return;
  const tmp = `${readyFile}.tmp`;
  try {
    writeFileSync(tmp, String(process.pid));
    renameSync(tmp, readyFile);
  } catch {
    // non-fatal; installer will time out if readiness cannot be written
  }
}

function removeReadyFile() {
  const readyFile = process.env.AGENT_READY_FILE;
  if (!readyFile) return;
  try {
    rmSync(readyFile, { force: true });
    rmSync(`${readyFile}.tmp`, { force: true });
  } catch {
    // ignore
  }
}

// The agent is ready only when the WSS is authenticated/open AND every
// requested local listener is actually listening. Ready is the single gate for
// the AGENT_READY_FILE handshake the installer polls.
function markReadyIfEligible() {
  if (ready || shuttingDown) return;
  if (!wsReady() || !allListenersListening()) return;
  ready = true;
  writeReadyFile();
}

// Invalidate readiness. The ready file must never outlive the state that made
// it true: a WSS that is no longer open, a listener that stopped listening, or
// a process that is shutting down all make the agent not ready.
function clearReady() {
  ready = false;
  removeReadyFile();
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
    if (!ready) {
      // A listener that fails to bind before readiness is a fatal candidate
      // startup failure: the installer must never see SUCCESS when a requested
      // port is not actually listening.
      clearReady();
      shutdown(1);
    } else {
      // A listener failing after readiness must not leave a stale ready file.
      clearReady();
    }
  });

  server.on('close', () => {
    // A listener that closed unexpectedly (outside an intentional shutdown)
    // invalidates readiness: a requested port is no longer served.
    listeningPorts.delete(port);
    clearReady();
  });

  server.listen(port, BIND_HOST, () => {
    logStandard('agent', 'listening', { bind_host: BIND_HOST, port });
    listeningPorts.add(port);
    markReadyIfEligible();
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
    reconnectAttempt = 0;
    reconnectDelay = readInteger('AGENT_RECONNECT_DELAY_MS', 1000, { min: 100 });
    authFailed = false;

    // Signal readiness for installer polling (process-local, not wire protocol).
    // The agent is only ready once the WSS is open AND every requested local
    // listener is actually listening.
    markReadyIfEligible();
  });

  ws.on('message', (data) => {
    handleServerFrame(data);
  });

  ws.on('close', (code, reason) => {
    logStandard('agent', 'disconnected', { code, reason: reason?.toString() || '' });
    clearReady();
    cleanupAll();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    if (err.message === 'Unexpected server response: 401') {
      logStandard('agent', 'auth_failed');
      authFailed = true;
      return;
    }
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

function scheduleReconnect() {
  if (authFailed || shuttingDown) return;

  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(() => {
    reconnectAttempt += 1;
    logStandard('agent', 'reconnect', { attempt: reconnectAttempt, delay_ms: reconnectDelay });
    connect();
  }, reconnectDelay);

  // Exponential backoff, max 30s
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Signal handlers receive the signal name (e.g. 'SIGTERM') as their first
  // argument; only numeric exit codes are valid for process.exit().
  if (typeof exitCode !== 'number') exitCode = 0;

  logStandard('agent', 'shutdown');

  clearReady();

  if (reconnectTimer) clearTimeout(reconnectTimer);

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

  // Keep the timer referenced so the exit code is honored even if all other
  // handles have already been closed.
  setTimeout(() => process.exit(exitCode), 50);
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
