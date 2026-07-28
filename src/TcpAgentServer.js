import { syncTcpBackpressure } from './TcpFlowControl.js';
import { logVerbose } from './logger.js';
import { FrameCodec, PROTO, sendJsonFrame } from './protocol.js';

export class TcpAgentServer {
  constructor(streamManager, tcpRouter, options = {}) {
    this.streamManager = streamManager;
    this.tcpRouter = tcpRouter;
    this.allowedPorts = options.allowedPorts ?? [];
    this.maxConnectionsPerPort = options.maxConnectionsPerPort ?? 0;
    this.maxStreamsPerAgent = options.maxStreamsPerAgent ?? 0;
    this._agentStreams = new Map(); // WebSocket -> Set<streamId>
    this._connCountByPort = new Map();
    this._heartbeatInterval = null;
  }

  handleConnection(ws) {
    ws.binaryType = 'nodebuffer';
    ws.isAlive = true;
    this._agentStreams.set(ws, new Set());

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      this._handleFrame(ws, data);
    });
    ws.on('close', () => this.cleanupAgent(ws, 'Agent WebSocket closed'));
    ws.on('error', () => this.cleanupAgent(ws, 'Agent WebSocket error'));

    logVerbose('tcp', 'agent_connect', { agentCount: this._agentStreams.size });
  }

  cleanupAgent(ws, reason) {
    const owned = this._agentStreams.get(ws);
    if (!owned) return;
    this._agentStreams.delete(ws);
    for (const streamId of owned) {
      const state = this.streamManager.streams.get(streamId);
      if (state && state.mode === 'tcp') {
        this.streamManager.abortTcpStream(state, reason, true);
      }
    }
    logVerbose('tcp', 'agent_disconnect', { reason, streamCount: owned.size });
  }

  _handleFrame(ws, data) {
    let frame;
    try {
      frame = FrameCodec.parseFrame(data);
    } catch (err) {
      logVerbose('tcp', 'agent_bad_frame', { error: err.message });
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, 0, { message: 'Invalid frame' });
      return;
    }

    const { type, streamId, payload } = frame;

    try {
      if (type === PROTO.TYPE.TCP_CONNECT) {
        if (streamId !== 0) {
          sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, streamId, { message: 'Invalid TCP_CONNECT streamId' });
          return;
        }
        this._handleTcpConnect(ws, payload);
        return;
      }

      const state = this.streamManager.streams.get(streamId);
      if (!state || state.mode !== 'tcp' || !state.socket?.isVirtual) return;
      if (state.agentWs !== ws) return;

      switch (type) {
        case PROTO.TYPE.TCP_DATA:
          state.socket.pushInbound(payload);
          break;
        case PROTO.TYPE.TCP_CLOSE:
          state.socket.endFromAgent();
          break;
        case PROTO.TYPE.TCP_ABORT:
          state.socket.abortFromAgent(payload);
          break;
        case PROTO.TYPE.PAUSE:
          this._handleAgentPause(state);
          break;
        case PROTO.TYPE.RESUME:
          this._handleAgentResume(state);
          break;
        default:
          break;
      }
    } catch (err) {
      logVerbose('tcp', 'agent_frame_error', { streamId, error: err.message });
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, streamId, { message: 'Frame handling error' });
    }
  }

  _handleTcpConnect(ws, payload) {
    let info = {};
    try {
      info = FrameCodec.parseJsonPayload(payload);
    } catch {
      /* ignore */
    }
    const port = Number(info.port);

    if (!Number.isInteger(port) || !this.allowedPorts.includes(port)) {
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, 0, { message: 'Port not allowed' });
      return;
    }

    const currentCount = this._connCountByPort.get(port) || 0;
    if (this.maxConnectionsPerPort > 0 && currentCount >= this.maxConnectionsPerPort) {
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, 0, { message: 'Per-port connection limit reached' });
      return;
    }

    const owned = this._agentStreams.get(ws);
    if (this.maxStreamsPerAgent > 0 && owned.size >= this.maxStreamsPerAgent) {
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, 0, { message: 'Agent stream limit reached' });
      return;
    }

    const result = this.tcpRouter.createAgentStream({ agentWs: ws, port });
    if (result.error) {
      sendJsonFrame(ws, PROTO.TYPE.TCP_ABORT, 0, { message: result.error });
      return;
    }

    this._connCountByPort.set(port, currentCount + 1);
    result.state.onCleanup = () => {
      const c = this._connCountByPort.get(port) || 1;
      this._connCountByPort.set(port, Math.max(0, c - 1));
      const owned = this._agentStreams.get(ws);
      if (owned) owned.delete(result.streamId);
    };
    this._agentStreams.get(ws).add(result.streamId);

    sendJsonFrame(ws, PROTO.TYPE.TCP_CONNECT_ACK, result.streamId, { port });
  }

  _handleAgentPause(state) {
    if (state.mode !== 'tcp') return;
    state.agentPaused = true;
    syncTcpBackpressure(state);
  }

  _handleAgentResume(state) {
    if (state.mode !== 'tcp') return;
    state.agentPaused = false;
    syncTcpBackpressure(state);
  }

  startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      for (const ws of this._agentStreams.keys()) {
        if (ws.isAlive === false) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
    if (this._heartbeatInterval.unref) this._heartbeatInterval.unref();
  }

  stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  async close(timeoutMs = 5000) {
    this.stopHeartbeat();
    const closePromises = [];
    for (const ws of [...this._agentStreams.keys()]) {
      this.cleanupAgent(ws, 'Server shutting down');
      closePromises.push(closeAgentWs(ws, timeoutMs));
    }
    await Promise.allSettled(closePromises);
  }
}

function closeAgentWs(ws, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } finally {
        finish();
      }
    }, timeoutMs);
    timer.unref?.();
    ws.once('close', finish);
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      finish();
    }
  });
}
