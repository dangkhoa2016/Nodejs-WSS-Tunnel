import crypto from 'crypto';

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  try {
    await import('dotenv/config');
  } catch {
    // ignore
  }
}

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const PORT = Number(process.env.PORT || 7860);
const TUNNEL_PATH = process.env.TUNNEL_PATH || '/tunnel';
const SERVER_HOST = process.env.SERVER_HOST || `http://localhost:${PORT}`;
const INSTALL_UUID = process.env.INSTALL_UUID || crypto.randomUUID();

const USERNAME = process.env.TUNNEL_USERNAME || '';
const PASSWORD = process.env.TUNNEL_PASSWORD || '';

const MAX_CONCURRENT_STREAMS = Number(process.env.MAX_CONCURRENT_STREAMS || 200);
const MAX_TUNNEL_CLIENTS = 1;

const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 120000);
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS || 30000);

const WS_HIGH_WATER = Number(process.env.WS_HIGH_WATER_BYTES || 1 * 1024 * 1024);
const MAX_FRAME_PAYLOAD = Number(process.env.MAX_FRAME_PAYLOAD_BYTES || 256 * 1024);
const WS_MAX_PAYLOAD = Number(process.env.WS_MAX_PAYLOAD_BYTES || 2 * 1024 * 1024);
const MAX_DEST_BUFFER_BYTES = Number(process.env.MAX_DEST_BUFFER_BYTES || 8 * 1024 * 1024);

const META_LIMIT_BYTES = 64 * 1024;

const serverConfig = {
  verbose: process.env.VERBOSE === 'true',
  logFormat: process.env.LOG_FORMAT || 'text',
};

export function validateConfig() {
  if (!USERNAME || !PASSWORD) {
    console.error('[FATAL] TUNNEL_USERNAME and TUNNEL_PASSWORD must be set.');
    console.error('Example:');
    console.error('  TUNNEL_USERNAME=admin');
    console.error('  TUNNEL_PASSWORD=secret');
    process.exit(1);
  }
}

export {
  PORT,
  TUNNEL_PATH,
  SERVER_HOST,
  INSTALL_UUID,
  USERNAME,
  PASSWORD,
  MAX_CONCURRENT_STREAMS,
  MAX_TUNNEL_CLIENTS,
  STREAM_IDLE_TIMEOUT_MS,
  DRAIN_TIMEOUT_MS,
  WS_HIGH_WATER,
  MAX_FRAME_PAYLOAD,
  WS_MAX_PAYLOAD,
  MAX_DEST_BUFFER_BYTES,
  META_LIMIT_BYTES,
  ADMIN_SECRET,
  serverConfig,
};
