import crypto from 'node:crypto';
import { isValidIpOrCidr } from './ipAllowlist.js';

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  try {
    await import('dotenv/config');
  } catch {
    // ignore
  }
}

const PROTOCOL_OVERHEAD = 64;

function readInteger(name, defaultValue, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!Number.isInteger(n) || !/^-?\d+$/.test(trimmed)) {
    throw new Error(`[config] ${name}: invalid number "${raw}"`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`[config] ${name}: value ${n} is below minimum ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`[config] ${name}: value ${n} exceeds maximum ${max}`);
  }
  return n;
}

function readBoolean(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`[config] ${name}: invalid boolean "${raw}" (expected true/false or 1/0)`);
}

function readUrl(name, defaultValue) {
  const raw = process.env[name] || defaultValue;
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`[config] ${name}: protocol must be http or https, got "${url.protocol}"`);
    }
    return raw;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`[config] ${name}: invalid URL "${raw}"`);
    }
    throw err;
  }
}

function readPortList(name) {
  const raw = process.env[name] || '';
  if (!raw) return [];
  const seen = new Set();
  const ports = [];
  for (const s of raw.split(',')) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`[config] ${name}: invalid port "${trimmed}"`);
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`[config] ${name}: invalid port "${trimmed}"`);
    }
    if (seen.has(n)) continue;
    seen.add(n);
    ports.push(n);
  }
  return ports;
}

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const PORT = readInteger('PORT', 7860, { min: 1, max: 65535 });
const TUNNEL_PATH = (() => {
  const raw = process.env.TUNNEL_PATH ?? '/tunnel';
  if (!raw.startsWith('/')) {
    throw new Error(`[config] TUNNEL_PATH must start with "/", got "${raw}"`);
  }
  return raw;
})();
const SERVER_HOST = readUrl('SERVER_HOST', `http://localhost:${PORT}`);
const INSTALL_UUID = process.env.INSTALL_UUID || crypto.randomUUID();

const USERNAME = process.env.TUNNEL_USERNAME || '';
const PASSWORD = process.env.TUNNEL_PASSWORD || '';

const MAX_CONCURRENT_STREAMS = readInteger('MAX_CONCURRENT_STREAMS', 200, { min: 1 });
const MAX_TUNNEL_CLIENTS = readInteger('MAX_TUNNEL_CLIENTS', 1, { min: 1 });

const STREAM_IDLE_TIMEOUT_MS = readInteger('STREAM_IDLE_TIMEOUT_MS', 120000, { min: 0 });
const DRAIN_TIMEOUT_MS = readInteger('DRAIN_TIMEOUT_MS', 30000, { min: 0 });

const WS_HIGH_WATER = readInteger('WS_HIGH_WATER_BYTES', 1 * 1024 * 1024, { min: 1024 });
const MAX_FRAME_PAYLOAD = readInteger('MAX_FRAME_PAYLOAD_BYTES', 256 * 1024, { min: 1 });
const WS_MAX_PAYLOAD = readInteger('WS_MAX_PAYLOAD_BYTES', 2 * 1024 * 1024, { min: 1024 });
const MAX_DEST_BUFFER_BYTES = readInteger('MAX_DEST_BUFFER_BYTES', 8 * 1024 * 1024, { min: 1024 });

const WS_LOW_WATER = (() => {
  const raw = process.env.WS_LOW_WATER;
  if (raw !== undefined && raw !== '') {
    return readInteger('WS_LOW_WATER', 0, { min: 1 });
  }
  return Math.floor(WS_HIGH_WATER / 2);
})();

const META_LIMIT_BYTES = 64 * 1024;

const TCP_TUNNEL_HOST = process.env.TCP_TUNNEL_HOST || '127.0.0.1';

const TCP_TUNNEL_PORTS = readPortList('TCP_TUNNEL_PORTS');

const TCP_TUNNEL_BIND_HOST = process.env.TCP_TUNNEL_BIND_HOST || '127.0.0.1';

const TCP_TUNNEL_ALLOWED_IPS = (process.env.TCP_TUNNEL_ALLOWED_IPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TCP_CLIENT_ALLOWED_HOSTS = (process.env.TCP_CLIENT_ALLOWED_HOSTS || TCP_TUNNEL_HOST)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TCP_CONNECT_TIMEOUT_MS = readInteger('TCP_CONNECT_TIMEOUT_MS', 10000, { min: 0 });

const TCP_MAX_CONNECTIONS_PER_PORT = readInteger('TCP_MAX_CONNECTIONS_PER_PORT', 20, { min: 0 });

const TCP_SHUTDOWN_DRAIN_TIMEOUT_MS = readInteger('TCP_SHUTDOWN_DRAIN_TIMEOUT_MS', 5000, { min: 0 });

const TCP_AGENT_PATH = (() => {
  const raw = process.env.TCP_AGENT_PATH ?? '/tcp';
  if (!raw.startsWith('/')) {
    throw new Error(`[config] TCP_AGENT_PATH must start with "/", got "${raw}"`);
  }
  return raw;
})();

const TCP_AGENT_ALLOWED_PORTS = readPortList('TCP_AGENT_ALLOWED_PORTS');

const TCP_AGENT_USERNAME = process.env.TCP_AGENT_USERNAME || USERNAME;
const TCP_AGENT_PASSWORD = process.env.TCP_AGENT_PASSWORD || PASSWORD;

const TCP_AGENT_ALLOWED_ORIGINS = (process.env.TCP_AGENT_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TCP_AGENT_REQUIRE_TLS = readBoolean('TCP_AGENT_REQUIRE_TLS', false);

function readIpList(name) {
  const raw = process.env[name] || '';
  if (!raw) return [];
  const seen = new Set();
  const entries = [];
  for (const s of raw.split(',')) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (!isValidIpOrCidr(trimmed)) {
      throw new Error(`[config] ${name}: invalid IP/CIDR "${trimmed}"`);
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    entries.push(trimmed);
  }
  return entries;
}

const TCP_AGENT_TRUSTED_PROXIES = readIpList('TCP_AGENT_TRUSTED_PROXIES');

const TCP_AGENT_MAX_STREAMS_PER_AGENT = readInteger('TCP_AGENT_MAX_STREAMS_PER_AGENT', 100, { min: 0 });

if (TCP_TUNNEL_PORTS.length > 0 && TCP_TUNNEL_BIND_HOST === '0.0.0.0' && TCP_TUNNEL_ALLOWED_IPS.length === 0) {
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

  if (WS_LOW_WATER >= WS_HIGH_WATER) {
    console.error(`[FATAL] WS_LOW_WATER (${WS_LOW_WATER}) must be less than WS_HIGH_WATER (${WS_HIGH_WATER})`);
    process.exit(1);
  }

  if (TUNNEL_PATH === TCP_AGENT_PATH) {
    console.error(`[FATAL] TUNNEL_PATH (${TUNNEL_PATH}) must differ from TCP_AGENT_PATH (${TCP_AGENT_PATH})`);
    process.exit(1);
  }

  if (MAX_FRAME_PAYLOAD > WS_MAX_PAYLOAD - PROTOCOL_OVERHEAD) {
    console.error(
      `[FATAL] MAX_FRAME_PAYLOAD (${MAX_FRAME_PAYLOAD}) exceeds WS_MAX_PAYLOAD - overhead (${WS_MAX_PAYLOAD - PROTOCOL_OVERHEAD})`,
    );
    process.exit(1);
  }

  if (TCP_TUNNEL_BIND_HOST === '0.0.0.0' && TCP_TUNNEL_ALLOWED_IPS.length === 0 && TCP_TUNNEL_PORTS.length > 0) {
    console.warn(
      '[config] SECURITY WARNING: TCP_TUNNEL_BIND_HOST=0.0.0.0 with no TCP_TUNNEL_ALLOWED_IPS set. ' +
        'Tunneled TCP services will be reachable from anywhere.',
    );
  }
}

export {
  readInteger,
  readBoolean,
  readUrl,
  readIpList,
  readPortList,
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
  TCP_AGENT_PATH,
  TCP_AGENT_ALLOWED_PORTS,
  TCP_AGENT_TRUSTED_PROXIES,
  TCP_AGENT_USERNAME,
  TCP_AGENT_PASSWORD,
  TCP_AGENT_ALLOWED_ORIGINS,
  TCP_AGENT_REQUIRE_TLS,
  TCP_AGENT_MAX_STREAMS_PER_AGENT,
};
