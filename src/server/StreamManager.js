import WebSocket from 'ws';
import { MAX_DEST_BUFFER_BYTES, STREAM_IDLE_TIMEOUT_MS } from '../shared/config.js';
import { logVerbose } from '../shared/logger.js';
import { FrameCodec, PROTO, sendFrame, sendJsonFrame } from '../shared/protocol.js';
import { sanitizeHeaders } from '../shared/utils.js';
import { syncSocketReadState, syncTcpBackpressure } from '../tcp/TcpFlowControl.js';
import { WsFrameWriter } from './WsFrameWriter.js';

const WS_OPEN = 1;

export class StreamManager {
  constructor() {
    this.streams = new Map();
    this._nextStreamId = 1;
  }

  get size() {
    return this.streams.size;
  }

  allocateStreamId() {
    for (let i = 0; i < 0xffffffff; i++) {
      const id = this._nextStreamId;

      this._nextStreamId = this._nextStreamId >= 0xffffffff ? 1 : this._nextStreamId + 1;

      if (!this.streams.has(id)) {
        return id;
      }
    }

    throw new Error('No available stream id');
  }

  _resetIdleTimer(state) {
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      logVerbose('stream', 'idle_timeout', { streamId: state.id });
      this.abortAnyStream(state, 'Stream idle timeout', true);
    }, STREAM_IDLE_TIMEOUT_MS);

    if (state.timer.unref) state.timer.unref();
  }

  cleanupStream(state) {
    if (state.cleaned) return;

    state.cleaned = true;

    if (state.timer) clearTimeout(state.timer);

    this.streams.delete(state.id);

    if (state.requestWriter) {
      try {
        state.requestWriter.destroy();
      } catch {
        // ignore
      }
    }

    try {
      state.req.destroy();
    } catch {
      // ignore
    }

    try {
      if (!state.res.writableEnded) {
        state.res.destroy();
      }
    } catch {
      // ignore
    }
  }

  abortStream(state, reason, notifyClient) {
    if (state.cleaned) return;

    logVerbose('stream', 'abort', {
      streamId: state.id,
      reason,
      notifyClient,
    });

    if (notifyClient && state.ws && state.ws.readyState === WebSocket.OPEN && !state.abortSent) {
      state.abortSent = true;
      sendJsonFrame(state.ws, PROTO.TYPE.REQ_ABORT, state.id, {
        message: reason || 'Stream aborted',
      });
    }

    if (!state.responseStarted) {
      try {
        state.res.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        state.res.end(
          JSON.stringify({
            error: 'tunnel_error',
            message: reason || 'Tunnel error',
          }),
        );
      } catch {
        // ignore
      }
    } else if (!state.responseEnded) {
      try {
        state.res.end();
      } catch {
        // ignore
      }

      try {
        state.res.destroy();
      } catch {
        // ignore
      }
    }

    this.cleanupStream(state);
  }

  cleanupAnyStream(state) {
    if (state.mode === 'tcp') {
      this.cleanupTcpStream(state);
    } else {
      this.cleanupStream(state);
    }
  }

  abortAnyStream(state, reason, notifyClient) {
    if (state.mode === 'tcp') {
      this.abortTcpStream(state, reason, notifyClient);
    } else {
      this.abortStream(state, reason, notifyClient);
    }
  }

  // ---------------------------------------------------------------------------
  // TCP stream lifecycle
  // ---------------------------------------------------------------------------

  createTcpStream({ ws, socket, serverPort, streamId }) {
    const state = {
      id: streamId,
      ws,
      socket,
      serverPort,
      mode: 'tcp',

      cleaned: false,
      abortSent: false,
      requestEnded: false,

      agentPaused: false,
      wsBackpressured: false,
      clientPausedForAgent: false,
      peerPausedRead: false,
      timer: null,
      onCleanup: null,
    };

    this.streams.set(streamId, state);
    this._resetIdleTimer(state);

    socket.on('drain', () => {
      if (state.cleaned) return;
      if (state.wsBackpressured) {
        state.wsBackpressured = false;
        syncTcpBackpressure(state);
      }
    });

    logVerbose('stream', 'tcp_allocate', { streamId, serverPort, clientCount: this.streams.size });
    return state;
  }

  cleanupTcpStream(state) {
    if (state.cleaned) return;
    state.cleaned = true;

    if (state.timer) clearTimeout(state.timer);
    this.streams.delete(state.id);

    if (state.socket) {
      try {
        state.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    if (typeof state.onCleanup === 'function') {
      try {
        state.onCleanup();
      } catch {
        /* ignore */
      }
    }
  }

  abortTcpStream(state, reason, notifyClient) {
    if (state.cleaned) return;

    logVerbose('stream', 'tcp_abort', { streamId: state.id, reason, notifyClient });

    if (typeof state.socket?.abort === 'function') {
      try {
        state.socket.abort(reason || 'TCP stream aborted');
      } catch {
        /* ignore */
      }
    }

    if (notifyClient && state.ws && state.ws.readyState === WS_OPEN && !state.abortSent) {
      state.abortSent = true;
      sendJsonFrame(state.ws, PROTO.TYPE.TCP_ABORT, state.id, {
        message: reason || 'TCP stream aborted',
      });
    }
    this.cleanupTcpStream(state);
  }

  getTcpStreams() {
    return [...this.streams.values()].filter((s) => s.mode === 'tcp');
  }

  cleanupStreamsForWs(ws) {
    for (const state of this.streams.values()) {
      if (state.ws !== ws) continue;
      this.abortAnyStream(state, 'Tunnel WebSocket disconnected', false);
    }
  }

  createStream({ ws, req, res, meta, streamId }) {
    const state = {
      id: streamId,
      mode: 'http',
      ws,
      req,
      res,
      meta,

      cleaned: false,
      abortSent: false,

      responseStarted: false,
      responseEnded: false,
      requestEnded: false,

      responsePaused: false,

      requestWriter: null,
      timer: null,
    };

    this.streams.set(streamId, state);
    this._resetIdleTimer(state);

    logVerbose('stream', 'allocate', {
      streamId,
      method: meta.method,
      url: meta.url,
      clientCount: this.streams.size,
    });

    const sentMeta = sendJsonFrame(ws, PROTO.TYPE.REQ_META, streamId, meta);

    if (!sentMeta) {
      this.streams.delete(streamId);

      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: 'tunnel_unavailable',
          message: 'Cannot send request metadata to tunnel client',
        }),
      );
      return null;
    }

    state.requestWriter = new WsFrameWriter({
      ws,
      streamId,
      frameType: PROTO.TYPE.REQ_DATA,
    });

    state.requestWriter.on('finish', () => {
      if (state.cleaned || state.requestEnded) return;

      state.requestEnded = true;
      sendFrame(ws, FrameCodec.buildFrame(PROTO.TYPE.REQ_END, streamId));
      this._resetIdleTimer(state);
    });

    state.requestWriter.on('error', () => {
      this.abortStream(state, 'Request writer error', false);
    });

    return state;
  }

  handleClientFrame(ws, data) {
    let frame;

    try {
      frame = FrameCodec.parseFrame(data);
    } catch {
      return;
    }

    const { type, streamId, payload } = frame;

    const state = this.streams.get(streamId);

    if (!state || state.ws !== ws) return;

    this._resetIdleTimer(state);

    try {
      switch (type) {
        case PROTO.TYPE.RES_META: {
          if (state.responseStarted) {
            this.abortStream(state, 'Duplicate RES_META', false);
            return;
          }

          const meta = FrameCodec.parseJsonPayload(payload);
          const headers = sanitizeHeaders(meta.headers || {}, { removeHost: true });

          if (state.req.method === 'HEAD') {
            headers['content-length'] = undefined;
            headers['transfer-encoding'] = undefined;
          }

          try {
            state.res.writeHead(
              Number(meta.statusCode) || 200,
              typeof meta.statusMessage === 'string' ? meta.statusMessage : '',
              headers,
            );
            state.responseStarted = true;
          } catch {
            this.abortStream(state, 'Invalid response headers from tunnel client', false);
          }

          break;
        }

        case PROTO.TYPE.RES_DATA: {
          if (!state.responseStarted) {
            this.abortStream(state, 'RES_DATA before RES_META', false);
            return;
          }

          if (state.responseEnded) return;

          if (state.res.writableLength > MAX_DEST_BUFFER_BYTES) {
            this.abortStream(state, 'HTTP response buffer overflow', true);
            return;
          }

          let ok = true;

          try {
            ok = state.res.write(payload);
          } catch {
            this.abortStream(state, 'Failed to write HTTP response chunk', false);
            return;
          }

          if (!ok && !state.responsePaused) {
            state.responsePaused = true;

            logVerbose('stream', 'backpressure', { streamId: state.id, event: 'pause' });
            sendFrame(state.ws, FrameCodec.buildFrame(PROTO.TYPE.PAUSE, state.id));

            state.res.once('drain', () => {
              if (state.cleaned) return;

              state.responsePaused = false;
              logVerbose('stream', 'backpressure', { streamId: state.id, event: 'resume' });
              sendFrame(state.ws, FrameCodec.buildFrame(PROTO.TYPE.RESUME, state.id));
            });
          }

          break;
        }

        case PROTO.TYPE.RES_END: {
          if (!state.responseStarted) {
            this.abortStream(state, 'RES_END without RES_META', false);
            return;
          }

          if (state.responseEnded) return;

          state.responseEnded = true;

          try {
            state.res.end();
          } catch {
            // ignore
          }

          break;
        }

        case PROTO.TYPE.RES_ABORT: {
          let info = {};

          try {
            info = FrameCodec.parseJsonPayload(payload);
          } catch {
            // ignore invalid JSON
          }

          if (!state.responseStarted) {
            try {
              state.res.writeHead(502, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
              });

              state.res.end(
                JSON.stringify({
                  error: 'tunnel_client_error',
                  message: info.message || 'Tunnel client aborted',
                }),
              );

              state.responseEnded = true;
            } catch {
              // ignore
            }
          } else if (!state.responseEnded) {
            try {
              state.res.end();
            } catch {
              // ignore
            }
          }

          this.cleanupStream(state);
          break;
        }

        case PROTO.TYPE.PAUSE: {
          if (state.mode === 'tcp') {
            state.peerPausedRead = true;
            syncSocketReadState(state, state.socket);
          } else if (state.requestWriter) {
            state.requestWriter.setPeerPaused(true);
          }
          break;
        }

        case PROTO.TYPE.RESUME: {
          if (state.mode === 'tcp') {
            state.peerPausedRead = false;
            syncSocketReadState(state, state.socket);
          } else if (state.requestWriter) {
            state.requestWriter.setPeerPaused(false);
          }
          break;
        }

        case PROTO.TYPE.TCP_DATA: {
          if (state.mode !== 'tcp') return;
          if (!state.socket || state.socket.destroyed) return;
          try {
            const ok = state.socket.write(payload);
            if (!ok && !state.wsBackpressured) {
              state.wsBackpressured = true;
              syncTcpBackpressure(state);
            }
          } catch {
            this.abortTcpStream(state, 'Failed to write TCP socket', true);
          }
          break;
        }

        case PROTO.TYPE.TCP_CLOSE: {
          if (state.mode !== 'tcp') return;
          this.cleanupTcpStream(state);
          break;
        }

        case PROTO.TYPE.TCP_OPEN_ACK: {
          if (state.mode !== 'tcp' || !state.awaitingClientAck) return;
          state.awaitingClientAck = false;
          logVerbose('stream', 'tcp_open_ack', { streamId });
          if (typeof state.onClientOpenConfirmed === 'function') {
            try {
              state.onClientOpenConfirmed();
            } catch {
              // ignore
            }
          }
          break;
        }

        case PROTO.TYPE.TCP_ABORT: {
          if (state.mode !== 'tcp') return;
          let info = {};
          try {
            info = FrameCodec.parseJsonPayload(payload);
          } catch {
            /* ignore */
          }
          if (state.awaitingClientAck && state.agentWs && state.agentWs.readyState === WS_OPEN) {
            // The agent has not been ACKed yet (deferred TCP_CONNECT_ACK), so
            // it matches pending connects by port. Reject the connect the same
            // way as a connect-level rejection instead of an unknown stream.
            sendJsonFrame(state.agentWs, PROTO.TYPE.TCP_ABORT, 0, {
              port: state.serverPort,
              message: info.message || 'Client aborted',
            });
            state.awaitingClientAck = false;
          }
          this.abortTcpStream(state, info.message || 'Client aborted', false);
          break;
        }

        default: {
          break;
        }
      }
    } catch {
      this.abortAnyStream(state, 'Bad frame from tunnel client', false);
    }
  }
}
