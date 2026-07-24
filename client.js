import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Writable, pipeline } from 'stream';

import WebSocket from 'ws';

import { createTcpClientHandler } from './src/TcpClientHandler.js';

if (process.env.NODE_ENV === 'development') {
  try {
    await import('dotenv/config');
  } catch {
    // ignore
  }
}

/**
 * client.js
 *
 * Tunnel client running on Google Colab/Kaggle.
 * - Connects to the intermediary server via WebSocket.
 * - Receives REQ_META/REQ_DATA/REQ_END frames.
 * - Forwards requests to the local HTTP server (default: http://127.0.0.1:8000).
 * - Streams responses back using binary frames.
 * - Supports backpressure, timeout, and reconnect.
 *
 * NOTE: This file is intentionally standalone. It duplicates PROTO and
 * WsFrameWriter from src/ so the client can be deployed independently
 * (e.g. pip install + node client.js) without shipping the full server.
 * Only TcpClientHandler is imported from src/ — it has no server deps.
 *
 * Required env vars:
 *   TUNNEL_SERVER_URL
 *   TUNNEL_USERNAME
 *   TUNNEL_PASSWORD
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.TUNNEL_SERVER_URL || '';
const USERNAME = process.env.TUNNEL_USERNAME || '';
const PASSWORD = process.env.TUNNEL_PASSWORD || '';

const TARGET_ORIGIN = (() => {
  const raw = process.env.TARGET_ORIGIN || 'http://127.0.0.1:8000';
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
})();

const MAX_CONCURRENT_STREAMS = Number(process.env.MAX_CONCURRENT_STREAMS || 200);
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 120000);
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS || 30000);

const WS_HIGH_WATER = Number(process.env.WS_HIGH_WATER_BYTES || 1 * 1024 * 1024);
const MAX_FRAME_PAYLOAD = Number(process.env.MAX_FRAME_PAYLOAD_BYTES || 256 * 1024);
const LOCAL_REQUEST_TIMEOUT_MS = Number(process.env.LOCAL_REQUEST_TIMEOUT_MS || 0);

if (!SERVER_URL || !USERNAME || !PASSWORD) {
  console.error('[client] TUNNEL_SERVER_URL, TUNNEL_USERNAME, TUNNEL_PASSWORD are required.');
  process.exit(1);
}

const targetBase = new URL(TARGET_ORIGIN);
const targetRequestModule = targetBase.protocol === 'https:' ? https : http;

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const PROTO = Object.freeze({
  VERSION: 1,
  TYPE: Object.freeze({
    REQ_META: 0x10,
    REQ_DATA: 0x11,
    REQ_END: 0x12,
    REQ_ABORT: 0x13,

    RES_META: 0x20,
    RES_DATA: 0x21,
    RES_END: 0x22,
    RES_ABORT: 0x23,

    PAUSE: 0x30,
    RESUME: 0x31,

    // TCP tunnel frame types
    TCP_OPEN: 0x40,
    TCP_DATA: 0x41,
    TCP_CLOSE: 0x42,
    TCP_ABORT: 0x43,
  }),
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

function sanitizeHeaders(headers, { removeHost = true } = {}) {
  const out = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;

    const lower = key.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (removeHost && lower === 'host') continue;

    out[key] = value;
  }

  return out;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

function buildFrame(type, streamId, payload = Buffer.alloc(0)) {
  const bufPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(6 + bufPayload.length);

  frame[0] = PROTO.VERSION;
  frame[1] = type;
  frame.writeUInt32BE(streamId >>> 0, 2);

  if (bufPayload.length > 0) {
    bufPayload.copy(frame, 6);
  }

  return frame;
}

function parseFrame(data) {
  const buf = toBuffer(data);

  if (buf.length < 6) {
    throw new Error('Frame too short');
  }

  const version = buf[0];
  if (version !== PROTO.VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const type = buf[1];
  const streamId = buf.readUInt32BE(2);
  const payload = buf.subarray(6);

  return { type, streamId, payload };
}

function parseJsonPayload(payload, limit = MAX_FRAME_PAYLOAD) {
  if (!payload || payload.length === 0) {
    throw new Error('Empty JSON payload');
  }

  if (payload.length > limit) {
    throw new Error('JSON payload too large');
  }

  return JSON.parse(payload.toString('utf8'));
}

function sendFrame(ws, frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(frame);
    return true;
  } catch {
    return false;
  }
}

function sendJsonFrame(ws, type, streamId, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  return sendFrame(ws, buildFrame(type, streamId, payload));
}

function waitDrain(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }

    if (ws.bufferedAmount <= WS_HIGH_WATER) {
      resolve();
      return;
    }

    const check = () => {
      if (ws.bufferedAmount <= WS_HIGH_WATER) {
        ws.removeListener('drain', check);
        resolve();
      }
    };

    ws.on('drain', check);

    setTimeout(() => {
      ws.removeListener('drain', check);
      resolve();
    }, DRAIN_TIMEOUT_MS);
  });
}

class WsFrameWriter extends Writable {
  constructor({ ws, streamId, frameType }) {
    super({ objectMode: false });
    this.ws = ws;
    this.streamId = streamId;
    this.frameType = frameType;
    this._peerPaused = false;
    this._pendingDrain = null;
  }

  _write(chunk, encoding, callback) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      callback(new Error('WebSocket not open'));
      return;
    }

    const frame = buildFrame(this.frameType, this.streamId, chunk);

    try {
      this.ws.send(frame);
    } catch (err) {
      callback(err);
      return;
    }

    if (this.ws.bufferedAmount > WS_HIGH_WATER) {
      this._pendingDrain = callback;
      this.ws.once('drain', () => {
        const cb = this._pendingDrain;
        this._pendingDrain = null;
        if (cb) cb();
      });
    } else {
      callback();
    }
  }

  setPeerPaused(paused) {
    this._peerPaused = paused;
  }

  _final(callback) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(buildFrame(PROTO.TYPE.REQ_END, this.streamId));
      } catch {
        // ignore
      }
    }
    callback();
  }
}

// ---------------------------------------------------------------------------
// TCP Tunnel Config
// ---------------------------------------------------------------------------

const TCP_TUNNEL_HOST = process.env.TCP_TUNNEL_HOST || '127.0.0.1';
const TCP_CLIENT_ALLOWED_HOSTS = (process.env.TCP_CLIENT_ALLOWED_HOSTS || TCP_TUNNEL_HOST)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TCP_CONNECT_TIMEOUT_MS = Number(process.env.TCP_CONNECT_TIMEOUT_MS || 10000);
const WS_LOW_WATER = Math.floor(WS_HIGH_WATER / 2);

// ---------------------------------------------------------------------------
// TCP Client Handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

const streams = new Map();

const tcpHandler = createTcpClientHandler({
  streams,
  MAX_CONCURRENT_STREAMS,
  TCP_TUNNEL_HOST,
  TCP_CLIENT_ALLOWED_HOSTS,
  TCP_CONNECT_TIMEOUT_MS,
  WS_HIGH_WATER,
  WS_LOW_WATER,
  sendFrame,
  sendJsonFrame,
  buildFrame,
  parseJsonPayload,
  resetIdleTimer,
  cleanupStream,
});

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let heartbeatInterval = null;
let authFailed = false;

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

function resetIdleTimer(state) {
  if (state.timer) clearTimeout(state.timer);

  state.timer = setTimeout(() => {
    sendResAbort(state, 'Stream idle timeout');
  }, STREAM_IDLE_TIMEOUT_MS);

  if (state.timer.unref) state.timer.unref();
}

function cleanupStream(state) {
  if (state.cleaned) return;

  state.cleaned = true;

  if (state.timer) clearTimeout(state.timer);

  streams.delete(state.id);

  if (state.responseWriter) {
    try {
      state.responseWriter.destroy();
    } catch {
      // ignore
    }
  }

  if (state.localReq) {
    try {
      state.localReq.destroy();
    } catch {
      // ignore
    }
  }

  if (state.localRes) {
    try {
      state.localRes.destroy();
    } catch {
      // ignore
    }
  }
}

function cleanupAllStreams() {
  tcpHandler.cleanupTcpStreams();

  for (const state of streams.values()) {
    cleanupStream(state);
  }
}

function sendResAbort(state, message) {
  if (state.cleaned) return;

  sendJsonFrame(state.ws, PROTO.TYPE.RES_ABORT, state.id, {
    message: message || 'Stream aborted',
  });

  cleanupStream(state);
}

// ---------------------------------------------------------------------------
// Frame handlers
// ---------------------------------------------------------------------------

function handleServerFrame(currentWs, data) {
  let frame;

  try {
    frame = parseFrame(data);
  } catch {
    return;
  }

  const { type, streamId, payload } = frame;

  if (type === PROTO.TYPE.REQ_META) {
    handleReqMeta(currentWs, streamId, payload);
    return;
  }

  const state = streams.get(streamId);

  if (!state || state.ws !== currentWs) return;

  resetIdleTimer(state);

  try {
    // Route TCP frames to the TCP handler; fall through to HTTP if not handled.
    if (tcpHandler.handleServerFrame(type, currentWs, streamId, payload, state)) {
      return;
    }

    switch (type) {
      case PROTO.TYPE.REQ_DATA: {
        handleReqData(state, payload);
        break;
      }

      case PROTO.TYPE.REQ_END: {
        handleReqEnd(state);
        break;
      }

      case PROTO.TYPE.REQ_ABORT: {
        // Server/end-user cancelled the request.
        if (state.localReq && !state.localReq.destroyed) {
          try {
            state.localReq.destroy(new Error('Request aborted by server'));
          } catch {
            // ignore
          }
        }
        cleanupStream(state);
        break;
      }

      // Server requests the client to stop sending RES_DATA.
      case PROTO.TYPE.PAUSE: {
        if (state.responseWriter) {
          state.responseWriter.setPeerPaused(true);
        }
        break;
      }

      case PROTO.TYPE.RESUME: {
        if (state.responseWriter) {
          state.responseWriter.setPeerPaused(false);
        }
        break;
      }

      default: {
        // Unknown frame: ignore.
        break;
      }
    }
  } catch {
    sendResAbort(state, 'Bad frame from server');
  }
}

function handleReqMeta(currentWs, streamId, payload) {
  if (streams.size >= MAX_CONCURRENT_STREAMS) {
    sendJsonFrame(currentWs, PROTO.TYPE.RES_ABORT, streamId, {
      message: 'Too many concurrent streams on tunnel client',
    });
    return;
  }

  if (streams.has(streamId)) {
    sendJsonFrame(currentWs, PROTO.TYPE.RES_ABORT, streamId, {
      message: 'Duplicate stream id',
    });
    return;
  }

  let meta;

  try {
    meta = parseJsonPayload(payload);
  } catch {
    sendJsonFrame(currentWs, PROTO.TYPE.RES_ABORT, streamId, {
      message: 'Invalid REQ_META payload',
    });
    return;
  }

  const state = {
    id: streamId,
    ws: currentWs,

    meta,

    localReq: null,
    localRes: null,
    responseWriter: null,

    cleaned: false,

    requestEnded: false,
    responseStarted: false,
    responseEnded: false,

    reqPaused: false,

    timer: null,
  };

  streams.set(streamId, state);
  resetIdleTimer(state);

  try {
    // Only allow path/query; do not allow overriding host/protocol.
    const rawUrl = meta.url || '/';

    let pathname = '/';
    let search = '';

    try {
      const u = new URL(rawUrl, TARGET_ORIGIN);
      pathname = u.pathname || '/';
      search = u.search || '';
    } catch {
      // Fallback for unusual URLs, e.g. OPTIONS *
      const qIndex = rawUrl.indexOf('?');

      if (qIndex === -1) {
        pathname = rawUrl;
        search = '';
      } else {
        pathname = rawUrl.slice(0, qIndex);
        search = rawUrl.slice(qIndex);
      }

      if (!pathname.startsWith('/')) {
        pathname = `/${pathname}`;
      }
    }

    const targetUrl = new URL(TARGET_ORIGIN);

    const basePath = targetBase.pathname === '/'
      ? ''
      : targetBase.pathname.replace(/\/$/, '');

    targetUrl.pathname = basePath + pathname;
    targetUrl.search = search;

    const headers = sanitizeHeaders(meta.headers || {}, { removeHost: true });

    // Local app needs the correct Host header for the local server.
    headers.host = targetUrl.host;

    const options = {
      method: String(meta.method || 'GET').toUpperCase(),
      headers,
      timeout: LOCAL_REQUEST_TIMEOUT_MS,
    };

    // If target uses self-signed HTTPS, set TARGET_TLS_REJECT_UNAUTHORIZED=0.
    // Not recommended for production.
    if (targetBase.protocol === 'https:' && process.env.TARGET_TLS_REJECT_UNAUTHORIZED === '0') {
      options.rejectUnauthorized = false;
    }

    const localReq = targetRequestModule.request(targetUrl.href, options, (localRes) => {
      if (state.cleaned) return;

      state.localRes = localRes;
      state.responseStarted = true;

      const resHeaders = sanitizeHeaders(localRes.headers, { removeHost: true });

      sendJsonFrame(currentWs, PROTO.TYPE.RES_META, streamId, {
        statusCode: localRes.statusCode,
        statusMessage: localRes.statusMessage,
        headers: resHeaders,
      });

      state.responseWriter = new WsFrameWriter({
        ws: currentWs,
        streamId,
        frameType: PROTO.TYPE.RES_DATA,
      });

      state.responseWriter.on('finish', () => {
        if (state.cleaned || state.responseEnded) return;

        state.responseEnded = true;
        sendFrame(currentWs, buildFrame(PROTO.TYPE.RES_END, streamId));
        cleanupStream(state);
      });

      state.responseWriter.on('error', () => {
        sendResAbort(state, 'Response writer error');
      });

      pipeline(localRes, state.responseWriter, (err) => {
        if (err && !state.cleaned) {
          sendResAbort(state, `Response pipeline error: ${err.message}`);
        }
      });
    });

    state.localReq = localReq;

    localReq.on('error', (err) => {
      if (state.cleaned) return;

      sendResAbort(state, `Local request error: ${err.message}`);
    });

    localReq.on('timeout', () => {
      if (state.cleaned) return;

      localReq.destroy(new Error('Local request timeout'));
    });

    // Pipe request body if present.
    if (['POST', 'PUT', 'PATCH'].includes(options.method) && meta.bodyLength > 0) {
      // Request body is streamed via REQ_DATA frames.
    } else {
      localReq.end();
    }
  } catch (err) {
    sendResAbort(state, `Failed to connect to local target: ${err.message}`);
  }
}

function handleReqData(state, payload) {
  if (state.cleaned || !state.localReq) return;

  try {
    state.localReq.write(payload);
  } catch {
    sendResAbort(state, 'Failed to write to local request');
  }
}

function handleReqEnd(state) {
  if (state.cleaned || !state.localReq) return;

  state.requestEnded = true;

  try {
    state.localReq.end();
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
      Authorization: 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64'),
    },
    handshakeTimeout: 10000,
  });

  ws.on('open', () => {
    console.log('[client] Connected to tunnel server');
    reconnectDelay = 1000;
    authFailed = false;

    // Start heartbeat
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, 30000);

    if (heartbeatInterval.unref) heartbeatInterval.unref();
  });

  ws.on('message', (data) => {
    handleServerFrame(ws, data);
  });

  ws.on('close', (code, reason) => {
    console.log(`[client] Connection closed: ${code} ${reason || ''}`);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    cleanupAllStreams();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    if (err.message === 'Unexpected server response: 401') {
      console.error('[client] Authentication failed. Check username/password.');
      authFailed = true;
      return;
    }

    console.error(`[client] WebSocket error: ${err.message}`);
  });

  ws.on('pong', () => {
    // Heartbeat response received
  });
}

function scheduleReconnect() {
  if (authFailed) return;

  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(() => {
    console.log(`[client] Reconnecting in ${reconnectDelay / 1000}s...`);
    connect();
  }, reconnectDelay);

  if (reconnectTimer.unref) reconnectTimer.unref();

  // Exponential backoff, max 30s
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

console.log(`[client] Target origin: ${TARGET_ORIGIN}`);
console.log(`[client] Server URL: ${SERVER_URL}`);

connect();
