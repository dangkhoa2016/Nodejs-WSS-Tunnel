import { Writable } from 'node:stream';
import WebSocket from 'ws';
import { DRAIN_TIMEOUT_MS, MAX_FRAME_PAYLOAD, WS_HIGH_WATER } from './config.js';
import { FrameCodec, PROTO } from './protocol.js';

export function sendFrame(ws, frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(frame, { binary: true });
    return true;
  } catch {
    return false;
  }
}

export function sendJsonFrame(ws, type, streamId, obj) {
  try {
    const payload = Buffer.from(JSON.stringify(obj || {}), 'utf8');
    return sendFrame(ws, FrameCodec.buildFrame(type, streamId, payload));
  } catch {
    return false;
  }
}

export function waitDrain(ws) {
  return new Promise((resolve, reject) => {
    const socket = ws._socket;

    if (!socket || ws.bufferedAmount <= WS_HIGH_WATER) {
      resolve();
      return;
    }

    const onDrain = () => done(null);
    const onClose = () => done(new Error('WebSocket closed while waiting for drain'));
    const timer = setTimeout(() => done(new Error('WebSocket drain timeout')), DRAIN_TIMEOUT_MS);

    function done(err) {
      clearTimeout(timer);

      if (socket) socket.removeListener('drain', onDrain);
      ws.removeListener('close', onClose);

      if (err) reject(err);
      else resolve();
    }

    socket.once('drain', onDrain);
    ws.once('close', onClose);
  });
}

export class WsFrameWriter extends Writable {
  constructor({ ws, streamId, frameType }) {
    super({ highWaterMark: 64 * 1024 });

    this.ws = ws;
    this.streamId = streamId;
    this.frameType = frameType;

    this.peerPaused = false;
    this.pending = null;

    this._writerClosed = false;
  }

  _write(chunk, encoding, callback) {
    if (this._writerClosed || this.destroyed) {
      callback(new Error('WsFrameWriter is closed'));
      return;
    }

    if (this.peerPaused) {
      this.pending = { chunk, callback };
      return;
    }

    this._sendChunk(chunk, callback);
  }

  async _sendChunk(chunk, callback) {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      if (buf.length === 0) {
        callback();
        return;
      }

      let offset = 0;

      while (offset < buf.length) {
        if (this._writerClosed || this.destroyed) {
          throw new Error('WsFrameWriter destroyed while sending');
        }

        if (this.ws.readyState !== WebSocket.OPEN) {
          throw new Error('WebSocket is not open');
        }

        if (this.ws.bufferedAmount > WS_HIGH_WATER) {
          await waitDrain(this.ws);
        }

        if (this._writerClosed || this.destroyed) {
          throw new Error('WsFrameWriter destroyed after drain');
        }

        if (this.peerPaused) {
          this.pending = { chunk: buf.subarray(offset), callback };
          return;
        }

        const end = Math.min(offset + MAX_FRAME_PAYLOAD, buf.length);
        const slice = buf.subarray(offset, end);

        const sent = sendFrame(this.ws, FrameCodec.buildFrame(this.frameType, this.streamId, slice));

        if (!sent) {
          throw new Error('Failed to send WebSocket frame');
        }

        offset = end;
      }

      callback();
    } catch (err) {
      callback(err);
    }
  }

  setPeerPaused(paused) {
    this.peerPaused = paused;

    if (!paused && this.pending && !this._writerClosed && !this.destroyed) {
      const { chunk, callback } = this.pending;
      this.pending = null;
      this._sendChunk(chunk, callback);
    }
  }

  _destroy(err, callback) {
    this._writerClosed = true;

    if (this.pending) {
      const { callback: pendingCallback } = this.pending;
      this.pending = null;
      pendingCallback(err || new Error('WsFrameWriter destroyed'));
    }

    callback(err);
  }
}
