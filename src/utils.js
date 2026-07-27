import crypto from 'node:crypto';
import { PASSWORD, USERNAME } from './config.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

export function safeEqual(a, b) {
  const ha = crypto
    .createHash('sha256')
    .update(String(a ?? ''))
    .digest();
  const hb = crypto
    .createHash('sha256')
    .update(String(b ?? ''))
    .digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyBasicAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const parts = authHeader.split(' ');
  if (parts.length !== 2) return false;
  if (parts[0].toLowerCase() !== 'basic') return false;

  let decoded;
  try {
    decoded = Buffer.from(parts[1], 'base64').toString('utf8');
  } catch {
    return false;
  }

  const idx = decoded.indexOf(':');
  if (idx < 0) return false;

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  return safeEqual(user, USERNAME) && safeEqual(pass, PASSWORD);
}

export function sanitizeHeaders(headers, { removeHost = true } = {}) {
  const out = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;

    const lower = key.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (removeHost && lower === 'host') continue;

    out[key] = value;
  }

  return out;
}

export function generateSignedUrl(basePath, secret, expiresInSec = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const payload = `${basePath}|${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { expires, sig };
}

export function validateHmacSignature(basePath, secret, expires, sig) {
  if (!secret || !expires || !sig) return false;

  const numExpires = Number(expires);
  if (!Number.isFinite(numExpires)) return false;
  if (numExpires <= Math.floor(Date.now() / 1000)) return false;

  const payload = `${basePath}|${numExpires}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
