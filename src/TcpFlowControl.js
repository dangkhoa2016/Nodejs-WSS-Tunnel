export function syncSocketReadState(state, socket) {
  if (!socket || socket.destroyed) return false;
  const paused = Boolean(state.peerPausedRead || state.localPausedForWs);
  if (paused) socket.pause();
  else socket.resume();
  return paused;
}
