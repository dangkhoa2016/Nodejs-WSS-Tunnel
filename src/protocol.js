export const PROTO = Object.freeze({
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
  }),
});

export class FrameCodec {
  static buildFrame(type, streamId, payload = Buffer.alloc(0)) {
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

  static parseFrame(data) {
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

  static parseJsonPayload(payload, limit = 64 * 1024) {
    if (!payload || payload.length === 0) {
      throw new Error('Empty JSON payload');
    }

    if (payload.length > limit) {
      throw new Error('JSON payload too large');
    }

    return JSON.parse(payload.toString('utf8'));
  }
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
