import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { serverConfig } from '../src/config.js';

const { logStandard, logVerbose, getConfig, setConfig } = await import('../src/logger.js');

describe('getConfig', () => {
  beforeEach(() => {
    serverConfig.verbose = false;
    serverConfig.logFormat = 'text';
  });

  it('returns default config', () => {
    const config = getConfig();
    assert.equal(typeof config.verbose, 'boolean');
    assert.equal(typeof config.logFormat, 'string');
    assert.ok(['json', 'text'].includes(config.logFormat));
  });

  it('returns a copy, not the original object', () => {
    const config = getConfig();
    config.verbose = true;
    assert.equal(serverConfig.verbose, false);
  });
});

describe('setConfig', () => {
  beforeEach(() => {
    serverConfig.verbose = false;
    serverConfig.logFormat = 'text';
  });

  it('sets verbose to true', () => {
    setConfig({ verbose: true });
    assert.equal(serverConfig.verbose, true);
  });

  it('sets verbose to false', () => {
    serverConfig.verbose = true;
    setConfig({ verbose: false });
    assert.equal(serverConfig.verbose, false);
  });

  it('sets logFormat to json', () => {
    setConfig({ logFormat: 'json' });
    assert.equal(serverConfig.logFormat, 'json');
  });

  it('sets logFormat to text', () => {
    serverConfig.logFormat = 'json';
    setConfig({ logFormat: 'text' });
    assert.equal(serverConfig.logFormat, 'text');
  });

  it('rejects invalid logFormat', () => {
    setConfig({ logFormat: 'xml' });
    assert.equal(serverConfig.logFormat, 'text');
  });

  it('ignores non-boolean verbose', () => {
    setConfig({ verbose: 'yes' });
    assert.equal(serverConfig.verbose, false);
  });

  it('ignores non-string logFormat', () => {
    setConfig({ logFormat: 123 });
    assert.equal(serverConfig.logFormat, 'text');
  });

  it('applies partial patches', () => {
    setConfig({ verbose: true });
    setConfig({ logFormat: 'json' });
    assert.equal(serverConfig.verbose, true);
    assert.equal(serverConfig.logFormat, 'json');
  });
});

describe('logStandard', () => {
  it('does not throw', () => {
    assert.doesNotThrow(() => {
      logStandard('ws', 'test', { key: 'value' });
    });
  });

  it('accepts all valid categories', () => {
    const cats = ['ws', 'http', 'proxy', 'stream', 'heartbeat', 'auth'];
    for (const cat of cats) {
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
    serverConfig.verbose = false;
  });

  it('does not throw when verbose is off', () => {
    assert.doesNotThrow(() => {
      logVerbose('ws', 'test', { key: 'value' });
    });
  });

  it('does not throw when verbose is on', () => {
    serverConfig.verbose = true;
    assert.doesNotThrow(() => {
      logVerbose('ws', 'test', { key: 'value' });
    });
    serverConfig.verbose = false;
  });

  it('respects verbose flag', () => {
    let logged = false;
    const originalLog = console.log;
    console.log = () => {
      logged = true;
    };

    serverConfig.verbose = false;
    logVerbose('ws', 'test', {});
    assert.equal(logged, false);

    serverConfig.verbose = true;
    logVerbose('ws', 'test', {});
    assert.equal(logged, true);

    console.log = originalLog;
    serverConfig.verbose = false;
  });
});
