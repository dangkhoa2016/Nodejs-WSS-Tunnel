import net from 'net';
import { PROTO } from './protocol.js';
import { logVerbose } from './logger.js';

const WS_OPEN = 1;

/**
 * Factory for TCP tunnel frame handlers on the client side.
 *
 * All dependencies are injected via a single `deps` object so this module
 * is fully testable without globals or module-level state.
 *
 * @param {object} deps
 * @returns {{ handleServerFrame: Function, cleanupTcpStreams: Function }}
 */
export function createTcpClientHandler(deps) {
  const {
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
  } = deps;

  const ALLOWED_HOSTS = new Set(TCP_CLIENT_ALLOWED_HOSTS || [TCP_TUNNEL_HOST]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function sendTcpAbort(ws, streamId, message) {
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, streamId, { message });
    } catch {
      // ignore
    }
  }

  function cleanupTcpState(state) {
    if (state.cleaned) return;

    state.cleaned = true;

    if (state.timer) clearTimeout(state.timer);
    streams.delete(state.id);

    if (state.localSocket) {
      try { state.localSocket.destroy(); } catch { /* ignore */ }
      state.localSocket = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Direction 2: WS -> local TCP socket. Write handler for backpressure.
  // ---------------------------------------------------------------------------

  function startWsToLocalPump(state) {
    // Backpressure is handled by the server side (TcpRouter).
    // The client side only needs to write incoming TCP_DATA to the local socket.
    // Pause/Resume of the local socket is handled by PAUSE/RESUME frames.
  }

  // ---------------------------------------------------------------------------
  // Direction 1: local TCP socket -> WS. Driven by socket 'data' events.
  // ---------------------------------------------------------------------------

  function handleTcpOpen(currentWs, streamId, payload) {
    let meta;
    try {
      meta = parseJsonPayload(payload);
    } catch {
      logVerbose('tcp', 'open_invalid_payload', { streamId });
      return;
    }

    const { host, port } = meta;

    if (!ALLOWED_HOSTS.has(host)) {
      logVerbose('tcp', 'open_reject', { streamId, host, reason: 'host_not_allowed' });
      sendTcpAbort(currentWs, streamId, `Host ${host} not allowed`);
      return;
    }

    if (streams.size >= MAX_CONCURRENT_STREAMS) {
      logVerbose('tcp', 'open_reject', { streamId, reason: 'too_many_streams' });
      sendTcpAbort(currentWs, streamId, 'Too many concurrent streams');
      return;
    }

    const state = {
      id: streamId,
      ws: currentWs,
      mode: 'tcp',
      localSocket: null,

      cleaned: false,
      abortSent: false,
      responseEnded: false,
      requestEnded: false,

      peerPausedForWrite: false,
      timer: null,
    };

    streams.set(streamId, state);
    resetIdleTimer(state);

    logVerbose('tcp', 'open', { streamId, host, port });

    const localSocket = net.connect({ host, port, timeout: TCP_CONNECT_TIMEOUT_MS });

    state.localSocket = localSocket;
    state.localPausedForWs = false;
    state.pendingSends = 0;

    let localConnected = false;

    localSocket.on('connect', () => {
      localConnected = true;
      resetIdleTimer(state);

      logVerbose('tcp', 'local_connected', { streamId, host, port });

      // Wire the local socket -> WS direction (local socket data -> TCP_DATA frames).
      localSocket.on('data', (chunk) => {
        if (state.cleaned) return;
        resetIdleTimer(state);

        if (!currentWs || currentWs.readyState !== WS_OPEN) {
          sendTcpAbort(currentWs, streamId, 'WebSocket closed');
          cleanupTcpState(state);
          return;
        }

        const frame = buildFrame(PROTO.TYPE.TCP_DATA, streamId, chunk);
        state.pendingSends++;
        let sendOk = true;
        try {
          currentWs.send(frame, { binary: true }, () => {
            state.pendingSends--;
            if (
              !state.cleaned &&
              state.localPausedForWs &&
              state.pendingSends === 0 &&
              currentWs.bufferedAmount <= WS_LOW_WATER
            ) {
              state.localPausedForWs = false;
              localSocket.resume();
            }
          });
        } catch {
          sendOk = false;
        }
        if (!sendOk) {
          sendTcpAbort(currentWs, streamId, 'Failed to send TCP_DATA');
          cleanupTcpState(state);
          return;
        }

        if (currentWs.bufferedAmount > WS_HIGH_WATER && !state.localPausedForWs) {
          state.localPausedForWs = true;
          localSocket.pause();
        }
      });
    });

    localSocket.on('timeout', () => {
      if (state.cleaned) return;
      if (!localConnected) {
        logVerbose('tcp', 'connect_timeout', { streamId, host, port });
        sendTcpAbort(currentWs, streamId, 'TCP connect timeout');
        cleanupTcpState(state);
      }
    });

    localSocket.on('close', () => {
      if (state.cleaned) return;
      logVerbose('tcp', 'local_close', { streamId });

      if (currentWs.readyState === WS_OPEN) {
        sendFrame(currentWs, buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
      }

      cleanupTcpState(state);
    });

    localSocket.on('error', (err) => {
      if (state.cleaned) return;
      logVerbose('tcp', 'local_error', { streamId, error: err.message });

      sendTcpAbort(currentWs, streamId, err.message);
      cleanupTcpState(state);
    });
  }

  function handleTcpData(state, payload) {
    if (state.mode !== 'tcp' || !state.localSocket || state.localSocket.destroyed) return;

    resetIdleTimer(state);

    try {
      state.localSocket.write(payload);
    } catch (err) {
      logVerbose('tcp', 'write_error', { streamId: state.id, error: err.message });
      sendTcpAbort(state.ws, state.id, 'Failed to write to local socket');
      cleanupTcpState(state);
    }
  }

  function handleTcpClose(state) {
    if (state.mode !== 'tcp') return;
    cleanupTcpState(state);
  }

  function handleTcpAbort(state, payload) {
    if (state.mode !== 'tcp') return;

    let info = {};
    try { info = parseJsonPayload(payload); } catch { /* ignore */ }

    logVerbose('tcp', 'remote_abort', { streamId: state.id, message: info.message });
    cleanupTcpState(state);
  }

  function cleanupTcpStreams() {
    for (const state of streams.values()) {
      if (state.mode !== 'tcp') continue;
      cleanupTcpState(state);
    }
  }

  /**
   * Routes a server-to-client frame. Returns true if the frame was handled
   * as a TCP frame, false if it should fall through to the existing HTTP
   * frame handler.
   */
  function handleServerFrame(type, currentWs, streamId, payload, state) {
    if (type === PROTO.TYPE.TCP_OPEN) {
      handleTcpOpen(currentWs, streamId, payload);
      return true;
    }
    switch (type) {
      case PROTO.TYPE.TCP_DATA:
        if (!state) return true;
        handleTcpData(state, payload);
        return true;
      case PROTO.TYPE.TCP_CLOSE:
        if (!state) return true;
        handleTcpClose(state);
        return true;
      case PROTO.TYPE.TCP_ABORT:
        if (!state) return true;
        handleTcpAbort(state, payload);
        return true;
      case PROTO.TYPE.PAUSE:
        if (state && state.responseWriter) state.responseWriter.setPeerPaused(true);
        if (state && state.mode === 'tcp' && state.localSocket && !state.localSocket.destroyed) {
          state.localSocket.pause();
        }
        return true;
      case PROTO.TYPE.RESUME:
        if (state && state.responseWriter) state.responseWriter.setPeerPaused(false);
        if (state && state.mode === 'tcp' && state.localSocket && !state.localSocket.destroyed) {
          state.localSocket.resume();
        }
        return true;
      default:
        return false;
    }
  }

  return { handleServerFrame, cleanupTcpStreams };
}
