import { FrameCodec, PROTO, sendFrame } from './protocol.js';

export function syncSocketReadState(state, socket) {
  if (!socket || socket.destroyed) return false;
  const paused = Boolean(state.peerPausedRead || state.localPausedForWs);
  if (paused) socket.pause();
  else socket.resume();
  return paused;
}

export function syncTcpBackpressure(state) {
  if (!state || !state.ws) return;
  const shouldPause = Boolean(state.agentPaused || state.wsBackpressured);
  if (shouldPause && !state.clientPausedForAgent) {
    state.clientPausedForAgent = true;
    sendFrame(state.ws, FrameCodec.buildFrame(PROTO.TYPE.PAUSE, state.id));
  } else if (!shouldPause && state.clientPausedForAgent) {
    state.clientPausedForAgent = false;
    sendFrame(state.ws, FrameCodec.buildFrame(PROTO.TYPE.RESUME, state.id));
  }
}
