import { serverConfig } from './config.js';

const CATEGORIES = new Set(['ws', 'http', 'proxy', 'stream', 'heartbeat', 'auth', 'tcp']);

function timestamp() {
  return new Date().toISOString();
}

function formatText(level, cat, evt, data) {
  const ts = timestamp();
  const dataStr =
    data && Object.keys(data).length > 0
      ? ` ${Object.entries(data)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')}`
      : '';
  return `[${ts}] [${level}] [${cat}] ${evt}${dataStr}`;
}

function formatJson(level, cat, evt, data) {
  return JSON.stringify({
    ts: timestamp(),
    level,
    cat,
    evt,
    ...(data || {}),
  });
}

function emit(level, cat, evt, data) {
  if (!CATEGORIES.has(cat)) return;

  const line =
    serverConfig.logFormat === 'json' ? formatJson(level, cat, evt, data) : formatText(level, cat, evt, data);

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logStandard(cat, evt, data) {
  emit('standard', cat, evt, data);
}

export function logVerbose(cat, evt, data) {
  if (!serverConfig.verbose) return;
  emit('verbose', cat, evt, data);
}

export function getConfig() {
  return {
    verbose: serverConfig.verbose,
    logFormat: serverConfig.logFormat,
  };
}

export function setConfig(patch) {
  if (typeof patch.verbose === 'boolean') {
    serverConfig.verbose = patch.verbose;
  }
  if (typeof patch.logFormat === 'string' && ['json', 'text'].includes(patch.logFormat)) {
    serverConfig.logFormat = patch.logFormat;
  }
}
