import WebSocket from 'ws';
import { MAX_TUNNEL_CLIENTS } from './config.js';
import { logVerbose } from './logger.js';

export class ClientManager {
  constructor(streamManager) {
    this.clients = new Set();
    this.streamManager = streamManager;
    this._heartbeatInterval = null;
  }

  getActiveClient() {
    let best = null;

    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      if (!best || ws.bufferedAmount < best.bufferedAmount) {
        best = ws;
      }
    }

    return best;
  }

  addClient(ws) {
    if (this.clients.size >= MAX_TUNNEL_CLIENTS) {
      try {
        ws.close(1013, 'Too many tunnel clients');
      } catch {
        // ignore
      }
      return false;
    }

    ws.binaryType = 'nodebuffer';
    ws.isAlive = true;

    this.clients.add(ws);

    logVerbose('ws', 'client_add', {
      clientCount: this.clients.size,
      remoteAddr: ws._socket?.remoteAddress,
    });

    ws.on('pong', () => {
      ws.isAlive = true;
      logVerbose('heartbeat', 'pong', {
        remoteAddr: ws._socket?.remoteAddress,
      });
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;

      try {
        this.streamManager.handleClientFrame(ws, data);
      } catch {
        // ignore, prevent process crash
      }
    });

    ws.on('close', () => {
      this.cleanupClient(ws);
    });

    ws.on('error', () => {
      this.cleanupClient(ws);
    });

    return true;
  }

  cleanupClient(ws) {
    this.clients.delete(ws);

    logVerbose('ws', 'client_remove', {
      clientCount: this.clients.size,
      remoteAddr: ws._socket?.remoteAddress,
    });

    const all = Array.from(this.streamManager.streams.values());

    for (const state of all) {
      if (state.ws === ws) {
        this.streamManager.abortAnyStream(state, 'Tunnel client disconnected', false);
      }
    }
  }

  startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }

        ws.isAlive = false;

        try {
          ws.ping();
          logVerbose('heartbeat', 'ping', {
            remoteAddr: ws._socket?.remoteAddress,
          });
        } catch {
          // ignore
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

    const closePromises = [...this.clients].map((ws) => closeClient(ws, timeoutMs));
    const results = await Promise.allSettled(closePromises);
    for (const r of results) {
      if (r.status === 'rejected') {
        logVerbose('ws', 'client_close_error', { reason: r.reason?.message });
      }
    }
  }
}

function closeClient(ws, timeoutMs) {
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
