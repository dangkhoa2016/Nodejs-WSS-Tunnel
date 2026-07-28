import { EventEmitter } from 'node:events';
import { MAX_DEST_BUFFER_BYTES, WS_HIGH_WATER, WS_LOW_WATER } from './config.js';
import { FrameCodec, PROTO, sendFrame, sendJsonFrame } from './protocol.js';

const WS_OPEN = 1;

export function createVirtualSocket({
  remoteAddress = '127.0.0.1',
  remotePort = 0,
  agentWs = null,
  streamId = 0,
} = {}) {
  const socket = new EventEmitter();
  socket.isVirtual = true;
  socket.destroyed = false;
  socket.remoteAddress = remoteAddress;
  socket.remotePort = remotePort;

  let paused = false;
  const buffered = [];
  let bufferedBytes = 0;
  let pendingDrain = false;
  let agentNotified = false;

  // Outbound: tunnel client -> agent (called by StreamManager TCP_DATA handler).
  socket.write = (chunk) => {
    if (socket.destroyed) return false;
    if (!agentWs || agentWs.readyState !== WS_OPEN) return false;
    try {
      agentWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, chunk), { binary: true }, () => {
        if (!socket.destroyed && pendingDrain && agentWs.bufferedAmount <= WS_LOW_WATER) {
          pendingDrain = false;
          socket.emit('drain');
        }
      });
      if (agentWs.bufferedAmount > WS_HIGH_WATER) {
        pendingDrain = true;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // Inbound flow control: pause/resume drive PAUSE/RESUME to the agent.
  socket.pause = () => {
    if (paused) return socket;
    paused = true;
    if (agentWs && agentWs.readyState === WS_OPEN) {
      sendFrame(agentWs, FrameCodec.buildFrame(PROTO.TYPE.PAUSE, streamId));
    }
    return socket;
  };

  socket.resume = () => {
    if (!paused) return socket;
    paused = false;
    const chunks = buffered.splice(0);
    bufferedBytes = 0;
    for (const c of chunks) socket.emit('data', c);
    if (agentWs && agentWs.readyState === WS_OPEN) {
      sendFrame(agentWs, FrameCodec.buildFrame(PROTO.TYPE.RESUME, streamId));
    }
    return socket;
  };

  // Inbound: agent -> server (called by TcpAgentServer on agent TCP_DATA).
  socket.pushInbound = (chunk) => {
    if (socket.destroyed) return false;
    if (paused) {
      if (bufferedBytes + chunk.length > MAX_DEST_BUFFER_BYTES) {
        socket.abort('Inbound buffer exceeded');
        return false;
      }
      buffered.push(chunk);
      bufferedBytes += chunk.length;
      return false;
    }
    socket.emit('data', chunk);
    return true;
  };

  socket.endFromAgent = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    agentNotified = true;
    socket.emit('close');
  };

  socket.abortFromAgent = (payload) => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    agentNotified = true;
    let message = 'Agent aborted stream';
    try {
      const info = FrameCodec.parseJsonPayload(payload);
      if (typeof info.message === 'string') message = info.message;
    } catch {
      /* keep default */
    }
    socket.emit('error', new Error(message));
  };

  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    if (!agentNotified && agentWs && agentWs.readyState === WS_OPEN) {
      agentNotified = true;
      sendFrame(agentWs, FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, streamId));
    }
    socket.emit('close');
  };

  socket.abort = (message) => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    agentNotified = true;
    if (agentWs && agentWs.readyState === WS_OPEN) {
      sendJsonFrame(agentWs, PROTO.TYPE.TCP_ABORT, streamId, { message: message || 'Stream aborted' });
    }
    // Async so TcpRouter's close handler sees state.cleaned already set.
    queueMicrotask(() => socket.emit('close'));
  };

  socket.destroySoon = socket.destroy;
  socket.end = socket.destroy;
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;

  return socket;
}
