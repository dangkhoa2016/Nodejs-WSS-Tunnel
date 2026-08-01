import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function buildInto(outDir) {
  const result = spawnSync(process.execPath, ['serve/build.js'], {
    cwd: process.cwd(),
    env: { ...process.env, OUT_DIR: outDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('client build resolves serve/client.js', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-build-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  buildInto(outDir);
  assert.equal(fs.existsSync(path.join(outDir, 'client.js')), true);
  assert.equal(fs.readFileSync(path.join(outDir, 'client.js'), 'utf8').includes('../src/'), false);
});

test('client build resolves serve/tcp-agent.js and does not bundle server config', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-build-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  buildInto(outDir);
  assert.equal(fs.existsSync(path.join(outDir, 'tcp-agent.js')), true);
  assert.equal(fs.readFileSync(path.join(outDir, 'tcp-agent.js'), 'utf8').includes('../src/'), false);

  const bundle = fs.readFileSync(path.join(outDir, 'tcp-agent.js'), 'utf8');
  assert.equal(bundle.includes('[config]'), false, 'agent bundle must not contain the server config loader');
  assert.equal(bundle.includes('TCP_AGENT_PATH must start with'), false, 'agent bundle must not validate server paths');
});
