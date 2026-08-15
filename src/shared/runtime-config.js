/**
 * Shared runtime config validation for processes that read env at startup.
 * Mirrors readInteger/readBoolean from src/shared/config.js but without
 * dotenv loading — intended for standalone agents started via `env -i`.
 */

function readInteger(name, defaultValue, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const trimmed = String(raw).trim();
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || !/^-?\d+$/.test(trimmed)) {
    throw new Error(`[runtime] ${name}: invalid integer "${raw}"`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`[runtime] ${name}: value ${n} is below minimum ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`[runtime] ${name}: value ${n} exceeds maximum ${max}`);
  }
  return n;
}

function readBoolean(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`[runtime] ${name}: invalid boolean "${raw}" (expected true/false or 1/0)`);
}

export { readInteger, readBoolean };
