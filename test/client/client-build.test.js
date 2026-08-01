import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

test('client build resolves serve/client.js', () => {
  const result = spawnSync(process.execPath, ['serve/build.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync('dist/client.js'), true);
  assert.equal(fs.readFileSync('dist/client.js', 'utf8').includes('../src/'), false);
});

test('client build resolves serve/tcp-agent.js and does not bundle server config', () => {
  const result = spawnSync(process.execPath, ['serve/build.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync('dist/tcp-agent.js'), true);
  assert.equal(fs.readFileSync('dist/tcp-agent.js', 'utf8').includes('../src/'), false);

  const bundle = fs.readFileSync('dist/tcp-agent.js', 'utf8');
  assert.equal(bundle.includes('[config]'), false, 'agent bundle must not contain the server config loader');
  assert.equal(bundle.includes('TCP_AGENT_PATH must start with'), false, 'agent bundle must not validate server paths');
});
