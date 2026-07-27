import net from 'node:net';
import { syncSocketReadState } from './TcpFlowControl.js';
import {
  MAX_CONCURRENT_STREAMS,
  TCP_MAX_CONNECTIONS_PER_PORT,
  TCP_SHUTDOWN_DRAIN_TIMEOUT_MS,
  TCP_TUNNEL_ALLOWED_IPS,
  TCP_TUNNEL_BIND_HOST,
  TCP_TUNNEL_HOST,
  TCP_TUNNEL_PORTS,
  WS_HIGH_WATER,
  WS_LOW_WATER,
} from './config.js';
import { isIpAllowed } from './ipAllowlist.js';
import { logStandard, logVerbose } from './logger.js';
import { FrameCodec, PROTO, sendJsonFrame } from './protocol.js';

const WS_OPEN = 1;

export class TcpRouter {
  constructor(streamManager, clientManager) {
    this.streamManager = streamManager;
    this.clientManager = clientManager;
    this._servers = new Map();
    this._connCountByPort = new Map();
  }

  start() {
    if (TCP_TUNNEL_PORTS.length === 0) {
      logStandard('tcp', 'skip', { reason: 'TCP_TUNNEL_PORTS not configured' });
      return;
    }
    for (const port of TCP_TUNNEL_PORTS) {
      this._listenOnPort(port);
    }
  }

  _listenOnPort(port) {
    const server = net.createServer((socket) => this._handleConnection(socket, port));

    server.on('error', (err) => {
      logStandard('tcp', 'server_error', { port, error: err.message, code: err.code });
    });

    server.listen(port, TCP_TUNNEL_BIND_HOST, () => {
      logStandard('tcp', 'listen', {
        port,
        bindHost: TCP_TUNNEL_BIND_HOST,
        target: TCP_TUNNEL_HOST,
      });
    });

    this._servers.set(port, server);
    this._connCountByPort.set(port, 0);
  }

  _handleConnection(socket, serverPort) {
    const remoteAddr = socket.remoteAddress;

    if (!isIpAllowed(remoteAddr, TCP_TUNNEL_ALLOWED_IPS)) {
      logStandard('tcp', 'reject', { reason: 'ip_not_allowed', serverPort, remoteAddr });
      socket.destroy();
      return;
    }

    const currentCount = this._connCountByPort.get(serverPort) || 0;
    if (TCP_MAX_CONNECTIONS_PER_PORT > 0 && currentCount >= TCP_MAX_CONNECTIONS_PER_PORT) {
      logStandard('tcp', 'reject', { reason: 'per_port_limit', serverPort, currentCount });
      socket.destroy();
      return;
    }

    if (this.streamManager.size >= MAX_CONCURRENT_STREAMS) {
      socket.destroy();
      logVerbose('tcp', 'reject', { reason: 'too_many_streams', serverPort });
      return;
    }

    const ws = this.clientManager.getActiveClient();
    if (!ws) {
      socket.destroy();
      logVerbose('tcp', 'reject', { reason: 'no_client', serverPort });
      return;
    }

    let streamId;
    try {
      streamId = this.streamManager.allocateStreamId();
    } catch {
      socket.destroy();
      logVerbose('tcp', 'reject', { reason: 'no_stream_id', serverPort });
      return;
    }

    this._connCountByPort.set(serverPort, currentCount + 1);
    let countDecremented = false;
    const decrementCount = () => {
      if (countDecremented) return;
      countDecremented = true;
      const c = this._connCountByPort.get(serverPort) || 1;
      this._connCountByPort.set(serverPort, Math.max(0, c - 1));
    };

    const state = this.streamManager.createTcpStream({ ws, socket, serverPort, streamId });
    if (!state) {
      decrementCount();
      socket.destroy();
      return;
    }
    state.onCleanup = decrementCount;

    logVerbose('tcp', 'connection', {
      streamId,
      serverPort,
      remoteAddr,
      remotePort: socket.remotePort,
    });

    const sent = sendJsonFrame(ws, PROTO.TYPE.TCP_OPEN, streamId, {
      host: TCP_TUNNEL_HOST,
      port: serverPort,
    });
    if (!sent) {
      this.streamManager.abortTcpStream(state, 'Failed to send TCP_OPEN', false);
      return;
    }

    // Direction 1: external client -> WS. Self-throttle on WS outbound buffer.
    state.pendingSends = 0;
    state.localPausedForWs = false;

    socket.on('data', (chunk) => {
      if (state.cleaned) return;
      this.streamManager._resetIdleTimer(state);

      if (!ws || ws.readyState !== WS_OPEN) {
        this.streamManager.abortTcpStream(state, 'Failed to send TCP_DATA', true);
        return;
      }

      const frame = FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, chunk);
      state.pendingSends++;
      let sendOk = true;
      try {
        ws.send(frame, { binary: true }, () => {
          state.pendingSends--;
          if (
            !state.cleaned &&
            state.localPausedForWs &&
            state.pendingSends === 0 &&
            ws.bufferedAmount <= WS_LOW_WATER
          ) {
            state.localPausedForWs = false;
            syncSocketReadState(state, socket);
          }
        });
      } catch {
        sendOk = false;
      }
      if (!sendOk) {
        this.streamManager.abortTcpStream(state, 'Failed to send TCP_DATA', true);
        return;
      }

      if (ws.bufferedAmount > WS_HIGH_WATER && !state.localPausedForWs) {
        state.localPausedForWs = true;
        syncSocketReadState(state, socket);
      }
    });

    socket.on('close', () => {
      if (state.cleaned) return;
      logVerbose('tcp', 'close', { streamId, serverPort });
      if (ws.readyState === WS_OPEN) {
        this._sendFrame(ws, FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
      }
      this.streamManager.cleanupTcpStream(state);
    });

    socket.on('error', (err) => {
      if (state.cleaned) return;
      logVerbose('tcp', 'error', { streamId, error: err.message });
      if (ws.readyState === WS_OPEN) {
        sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, streamId, { message: err.message });
      }
      this.streamManager.abortTcpStream(state, err.message, false);
    });
  }

  _sendFrame(ws, frame) {
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(frame, { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    const closePromises = [];
    for (const [port, server] of this._servers) {
      closePromises.push(
        new Promise((resolve, reject) => {
          try {
            server.close((error) => {
              if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
              else resolve();
            });
            logStandard('tcp', 'stop_accepting', { port });
          } catch (error) {
            if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
            else reject(error);
          }
        }),
      );
    }
    this._servers.clear();

    const activeStates = this.streamManager.getTcpStreams();
    for (const state of activeStates) {
      this.streamManager.abortTcpStream(state, 'Server shutting down', true);
    }
    if (activeStates.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, TCP_SHUTDOWN_DRAIN_TIMEOUT_MS));
    }
    const results = await Promise.allSettled(closePromises);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to close TCP listeners');
    }
  }
}
