import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

test('client build resolves serve/client.js', () => {
  const result = spawnSync(process.execPath, ['serve/build.js'], {
    cwd: process.cwd(), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync('dist/client.js'), true);
  assert.equal(fs.readFileSync('dist/client.js', 'utf8').includes('../src/'), false);
});
