import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { logStandard, logVerbose, logError, getConfig, setConfig } = await import('../../src/shared/logging.js');

const CATS = ['ws', 'http', 'proxy', 'stream', 'heartbeat', 'auth', 'tcp', 'client', 'agent', 'shutdown'];

describe('getConfig', () => {
  beforeEach(() => {
    setConfig({ verbose: false, logFormat: 'text' });
  });

  it('returns default config', () => {
    const config = getConfig();
    assert.equal(typeof config.verbose, 'boolean');
    assert.equal(typeof config.logFormat, 'string');
    assert.ok(['json', 'text'].includes(config.logFormat));
  });

  it('returns a copy, not the internal state', () => {
    const config = getConfig();
    config.verbose = true;
    assert.equal(getConfig().verbose, false);
  });
});

describe('setConfig', () => {
  beforeEach(() => {
    setConfig({ verbose: false, logFormat: 'text' });
  });

  it('sets verbose to true', () => {
    setConfig({ verbose: true });
    assert.equal(getConfig().verbose, true);
  });

  it('sets verbose to false', () => {
    setConfig({ verbose: true });
    setConfig({ verbose: false });
    assert.equal(getConfig().verbose, false);
  });

  it('sets logFormat to json', () => {
    setConfig({ logFormat: 'json' });
    assert.equal(getConfig().logFormat, 'json');
  });

  it('sets logFormat to text', () => {
    setConfig({ logFormat: 'json' });
    setConfig({ logFormat: 'text' });
    assert.equal(getConfig().logFormat, 'text');
  });

  it('rejects invalid logFormat', () => {
    setConfig({ logFormat: 'xml' });
    assert.equal(getConfig().logFormat, 'text');
  });

  it('ignores non-boolean verbose', () => {
    setConfig({ verbose: 'yes' });
    assert.equal(getConfig().verbose, false);
  });

  it('ignores non-string logFormat', () => {
    setConfig({ logFormat: 123 });
    assert.equal(getConfig().logFormat, 'text');
  });

  it('applies partial patches', () => {
    setConfig({ verbose: true });
    setConfig({ logFormat: 'json' });
    assert.equal(getConfig().verbose, true);
    assert.equal(getConfig().logFormat, 'json');
  });
});

describe('logStandard', () => {
  it('does not throw', () => {
    assert.doesNotThrow(() => {
      logStandard('ws', 'test', { key: 'value' });
    });
  });

  it('accepts all valid categories', () => {
    for (const cat of CATS) {
      assert.doesNotThrow(() => logStandard(cat, 'event', {}));
    }
  });

  it('ignores invalid categories silently', () => {
    assert.doesNotThrow(() => {
      logStandard('invalid_category', 'event', {});
    });
  });
});

describe('logVerbose', () => {
  beforeEach(() => {
    setConfig({ verbose: false, logFormat: 'text' });
  });

  it('does not throw when verbose is off', () => {
    assert.doesNotThrow(() => {
      logVerbose('ws', 'test', { key: 'value' });
    });
  });

  it('does not throw when verbose is on', () => {
    setConfig({ verbose: true });
    assert.doesNotThrow(() => {
      logVerbose('ws', 'test', { key: 'value' });
    });
  });

  it('respects verbose flag', () => {
    let logged = false;
    const originalLog = console.log;
    console.log = () => {
      logged = true;
    };

    setConfig({ verbose: false });
    logVerbose('ws', 'test', {});
    assert.equal(logged, false);

    setConfig({ verbose: true });
    logVerbose('ws', 'test', {});
    assert.equal(logged, true);

    console.log = originalLog;
  });
});

describe('logError', () => {
  it('does not throw', () => {
    assert.doesNotThrow(() => {
      logError('tcp', 'test_error', { message: 'boom' });
    });
  });

  it('accepts all valid categories', () => {
    for (const cat of CATS) {
      assert.doesNotThrow(() => logError(cat, 'event', {}));
    }
  });
});

describe('env fallback (dotenv may load after this module)', () => {
  afterEach(() => {
    delete process.env.VERBOSE;
    delete process.env.LOG_FORMAT;
    setConfig({ verbose: null, logFormat: null });
  });

  it('reads VERBOSE=true from process.env at emit time', () => {
    setConfig({ verbose: null });
    process.env.VERBOSE = 'true';
    let logged = false;
    const originalLog = console.log;
    console.log = () => {
      logged = true;
    };
    try {
      logVerbose('ws', 'test', {});
    } finally {
      console.log = originalLog;
    }
    assert.equal(logged, true);
  });

  it('reads LOG_FORMAT=json from process.env at emit time', () => {
    setConfig({ logFormat: null });
    process.env.LOG_FORMAT = 'json';
    let captured = null;
    const originalLog = console.log;
    console.log = (line) => {
      captured = line;
    };
    try {
      logStandard('ws', 'hello', { a: 1 });
    } finally {
      console.log = originalLog;
    }
    assert.ok(captured, 'expected a log line');
    const parsed = JSON.parse(captured);
    assert.equal(parsed.evt, 'hello');
    assert.equal(parsed.a, 1);
  });

  it('getConfig reflects process.env when no override is set', () => {
    setConfig({ verbose: null, logFormat: null });
    process.env.VERBOSE = 'true';
    process.env.LOG_FORMAT = 'json';
    assert.equal(getConfig().verbose, true);
    assert.equal(getConfig().logFormat, 'json');
  });
});
