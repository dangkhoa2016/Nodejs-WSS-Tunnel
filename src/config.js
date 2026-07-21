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

const TCP_TUNNEL_HOST = process.env.TCP_TUNNEL_HOST || '127.0.0.1';

const TCP_TUNNEL_PORTS = (process.env.TCP_TUNNEL_PORTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      console.warn(`[config] Invalid TCP port ignored: "${s}"`);
      return null;
    }
    return n;
  })
  .filter((n) => n !== null);

const TCP_TUNNEL_BIND_HOST = process.env.TCP_TUNNEL_BIND_HOST || '127.0.0.1';

const TCP_TUNNEL_ALLOWED_IPS = (process.env.TCP_TUNNEL_ALLOWED_IPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TCP_CLIENT_ALLOWED_HOSTS = (process.env.TCP_CLIENT_ALLOWED_HOSTS || TCP_TUNNEL_HOST)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TCP_CONNECT_TIMEOUT_MS = parseInt(process.env.TCP_CONNECT_TIMEOUT_MS || '10000', 10);

const TCP_MAX_CONNECTIONS_PER_PORT = parseInt(
  process.env.TCP_MAX_CONNECTIONS_PER_PORT || '20',
  10,
);

const TCP_SHUTDOWN_DRAIN_TIMEOUT_MS = parseInt(
  process.env.TCP_SHUTDOWN_DRAIN_TIMEOUT_MS || '5000',
  10,
);

const WS_LOW_WATER = parseInt(process.env.WS_LOW_WATER || String(Math.floor(WS_HIGH_WATER / 2)), 10);

if (TCP_TUNNEL_BIND_HOST === '0.0.0.0' && TCP_TUNNEL_ALLOWED_IPS.length === 0) {
  console.warn(
    '[config] SECURITY WARNING: TCP_TUNNEL_BIND_HOST=0.0.0.0 with no TCP_TUNNEL_ALLOWED_IPS set. ' +
    'Tunneled TCP services will be reachable from anywhere.',
  );
}

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
  WS_LOW_WATER,
  MAX_FRAME_PAYLOAD,
  WS_MAX_PAYLOAD,
  MAX_DEST_BUFFER_BYTES,
  META_LIMIT_BYTES,
  ADMIN_SECRET,
  serverConfig,
  TCP_TUNNEL_HOST,
  TCP_TUNNEL_PORTS,
  TCP_TUNNEL_BIND_HOST,
  TCP_TUNNEL_ALLOWED_IPS,
  TCP_CLIENT_ALLOWED_HOSTS,
  TCP_CONNECT_TIMEOUT_MS,
  TCP_MAX_CONNECTIONS_PER_PORT,
  TCP_SHUTDOWN_DRAIN_TIMEOUT_MS,
};
