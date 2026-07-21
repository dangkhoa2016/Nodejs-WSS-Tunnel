const CATEGORIES = new Set([
  'ws',
  'http',
  'proxy',
  'stream',
  'heartbeat',
  'auth',
  'tcp',
  'client',
  'agent',
  'shutdown',
]);

const state = {
  verbose: null,
  logFormat: null,
};

function resolveVerbose() {
  return state.verbose ?? process.env.VERBOSE === 'true';
}

function resolveLogFormat() {
  return state.logFormat ?? (process.env.LOG_FORMAT === 'json' ? 'json' : 'text');
}

function timestamp() {
  return new Date().toISOString();
}

function formatText(level, cat, evt, data) {
  const dataStr =
    data && Object.keys(data).length > 0
      ? ` ${Object.entries(data)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')}`
      : '';
  return `[${timestamp()}] [${level}] [${cat}] ${evt}${dataStr}`;
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

  const line = resolveLogFormat() === 'json' ? formatJson(level, cat, evt, data) : formatText(level, cat, evt, data);

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
  if (!resolveVerbose()) return;
  emit('verbose', cat, evt, data);
}

export function logError(cat, evt, data) {
  emit('error', cat, evt, data);
}

export function getConfig() {
  return {
    verbose: resolveVerbose(),
    logFormat: resolveLogFormat(),
  };
}

export function setConfig(patch) {
  if (patch.verbose === null || typeof patch.verbose === 'boolean') {
    state.verbose = patch.verbose;
  }
  if (patch.logFormat === null || (typeof patch.logFormat === 'string' && ['json', 'text'].includes(patch.logFormat))) {
    state.logFormat = patch.logFormat;
  }
}
