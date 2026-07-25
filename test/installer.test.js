import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

const MINIMAL_PKG = JSON.stringify({ name: 'test-client', version: '1.0.0', type: 'module', private: true });

function createTestServer(port, bundlePath, pkgContent) {
  const bundle = fs.readFileSync(bundlePath);
  return http.createServer((req, res) => {
    if (req.url === '/client.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundle);
    } else if (req.url === '/client-package.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(pkgContent);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

function runInstaller(workDir, port, timeoutMs, envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['serve/setup.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: workDir,
        TUNNEL_SERVER_URL: `ws://127.0.0.1:${port}/tunnel`,
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        TARGET_ORIGIN: 'http://127.0.0.1:8080',
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: null, stdout, stderr, signal: 'SIGTERM' });
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, signal });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, signal: null });
    });
  });
}

function getWorkDir(sandbox) {
  return path.join(sandbox, '.tunnel-client');
}

test('installer fails on invalid bundle and cleans up', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const invalidBundle = path.join(sandbox, 'invalid.js');
  fs.writeFileSync(invalidBundle, 'not valid javascript {{{');

  const port = 18789;
  const server = createTestServer(port, invalidBundle, MINIMAL_PKG);
  await new Promise((r) => server.listen(port, r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });

  const result = await runInstaller(sandbox, port, 5000);
  assert.notEqual(result.status, 0, `installer should fail with invalid bundle\n${result.stderr}`);

  const workDir = getWorkDir(sandbox);
  const releasesDir = path.join(workDir, 'releases');
  if (fs.existsSync(releasesDir)) {
    const entries = fs.readdirSync(releasesDir);
    assert.equal(entries.length, 0, 'no orphan releases after failed install');
  }
});

test('installer rejects stale readiness', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const workDir = getWorkDir(sandbox);
  fs.mkdirSync(workDir, { recursive: true });

  const stalePid = String(process.pid + 1);
  fs.writeFileSync(path.join(workDir, 'client.ready'), stalePid);

  const port = 18790;
  const server = createTestServer(port, 'test/fixtures/client-never-ready.js', MINIMAL_PKG);
  await new Promise((r) => server.listen(port, r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });

  const result = await runInstaller(sandbox, port, 30000);
  assert.notEqual(result.status, 0, 'installer should fail when client never becomes ready');

  const readyFile = path.join(workDir, 'client.ready');
  assert.ok(
    !fs.existsSync(readyFile) || fs.readFileSync(readyFile, 'utf8').trim() !== stalePid,
    'stale readiness must be replaced or removed',
  );
});

test('installer succeeds with a client that writes readiness', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const port = 18791;
  const server = createTestServer(port, 'test/fixtures/client-writes-ready.js', MINIMAL_PKG);
  await new Promise((r) => server.listen(port, r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });

  const result = await runInstaller(sandbox, port, 30000);
  const workDir = getWorkDir(sandbox);
  const readyFile = path.join(workDir, 'client.ready');

  if (result.status !== 0) {
    console.log('INSTALLER STDOUT:', result.stdout);
    console.log('INSTALLER STDERR:', result.stderr);
    // Check if ready file was created despite installer exit code
    if (fs.existsSync(readyFile)) {
      const pid = fs.readFileSync(readyFile, 'utf8').trim();
      if (pid && !Number.isNaN(Number(pid))) {
        console.log('Ready file exists with PID:', pid);
        // Kill the test client
        try {
          process.kill(Number(pid));
        } catch {}
      }
    }
  }

  assert.equal(result.status, 0, `installer should succeed\n${result.stdout}\n${result.stderr}`);

  assert.ok(fs.existsSync(readyFile), 'client.ready must exist after successful install');
  const readyPid = fs.readFileSync(readyFile, 'utf8').trim();
  assert.ok(readyPid.length > 0 && !Number.isNaN(Number(readyPid)), 'client.ready must contain a PID');

  const pidFile = path.join(workDir, 'client.pid');
  assert.ok(fs.existsSync(pidFile), 'client.pid must exist');
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), readyPid, 'PID files must match');

  const currentLink = path.join(workDir, 'current');
  assert.ok(fs.existsSync(currentLink), 'current symlink must exist');
  const currentTarget = fs.readlinkSync(currentLink);
  assert.ok(currentTarget.includes('releases/'), 'current must point to a release');

  try {
    process.kill(Number(readyPid));
  } catch {}
});

test('creates unique release directories even with identical timestamps', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const binDir = path.join(sandbox, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'date'), "#!/bin/sh\nprintf '%s\\n' 20260729T120000Z\n");
  fs.chmodSync(path.join(binDir, 'date'), 0o755);

  const port1 = 18793;
  const server1 = createTestServer(port1, 'test/fixtures/client-writes-ready.js', MINIMAL_PKG);
  await new Promise((r) => server1.listen(port1, r));
  t.after(() => server1.close());

  const envPath = `${binDir}:${process.env.PATH}`;
  const result1 = await runInstaller(sandbox, port1, 30000, { PATH: envPath });
  assert.equal(result1.status, 0, `first install should succeed\n${result1.stderr}`);

  const port2 = 18794;
  const server2 = createTestServer(port2, 'test/fixtures/client-writes-ready.js', MINIMAL_PKG);
  await new Promise((r) => server2.listen(port2, r));
  t.after(() => server2.close());

  const result2 = await runInstaller(sandbox, port2, 30000, { PATH: envPath });
  assert.equal(result2.status, 0, `second install should succeed\n${result2.stderr}`);

  const workDir = getWorkDir(sandbox);
  const currentLink = path.join(workDir, 'current');
  const previousLink = path.join(workDir, 'previous');
  const firstRelease = fs.readlinkSync(previousLink);
  const secondRelease = fs.readlinkSync(currentLink);

  assert.notEqual(secondRelease, firstRelease);
  assert.equal(fs.readlinkSync(previousLink), firstRelease);
  assert.ok(fs.existsSync(firstRelease));
  assert.ok(fs.existsSync(secondRelease));

  const pidFile = path.join(workDir, 'client.pid');
  if (fs.existsSync(pidFile)) {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()));
    } catch {}
  }
});

test('first install failure leaves no dangling state', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const port = 18797;
  const server = createTestServer(port, 'test/fixtures/client-never-ready.js', MINIMAL_PKG);
  await new Promise((r) => server.listen(port, r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });

  const result = await runInstaller(sandbox, port, 30000);
  assert.notEqual(result.status, 0, 'installer should fail when client never becomes ready');

  const workDir = getWorkDir(sandbox);
  assert.equal(fs.existsSync(path.join(workDir, 'current')), false);
  assert.equal(fs.existsSync(path.join(workDir, 'client.pid')), false);
  assert.equal(fs.existsSync(path.join(workDir, 'client.ready')), false);

  const releasesDir = path.join(workDir, 'releases');
  if (fs.existsSync(releasesDir)) {
    assert.deepEqual(fs.readdirSync(releasesDir), []);
  }

  const workEntries = fs.readdirSync(workDir);
  const remnants = workEntries.filter(
    (e) => e.startsWith('.link.') || e.startsWith('.part.') || e.startsWith('.test.'),
  );
  assert.equal(remnants.length, 0, `no temporary directories remain: ${remnants.join(', ')}`);
});

test('removes failed release after rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const port1 = 18795;
  const server1 = createTestServer(port1, 'test/fixtures/client-writes-ready.js', MINIMAL_PKG);
  await new Promise((r) => server1.listen(port1, r));
  t.after(() => server1.close());

  const result1 = await runInstaller(sandbox, port1, 30000);
  assert.equal(result1.status, 0, `first install should succeed\n${result1.stderr}`);

  const workDir = getWorkDir(sandbox);
  const currentLink = path.join(workDir, 'current');
  const firstRelease = fs.readlinkSync(currentLink);
  assert.ok(firstRelease, 'first release must exist');

  const releasesDir = path.join(workDir, 'releases');
  const beforeReleases = fs.readdirSync(releasesDir);

  const port2 = 18796;
  const server2 = createTestServer(port2, 'test/fixtures/client-never-ready.js', MINIMAL_PKG);
  await new Promise((r) => server2.listen(port2, r));
  t.after(() => server2.close());

  const result2 = await runInstaller(sandbox, port2, 30000);
  assert.equal(result2.status, 0, 'rollback restores service per installer contract');

  const afterReleases = fs.readdirSync(releasesDir);
  assert.deepEqual(afterReleases.sort(), beforeReleases.sort());
  assert.equal(fs.readlinkSync(currentLink), firstRelease);
  assert.ok(fs.existsSync(firstRelease));
  const pidFile = path.join(workDir, 'client.pid');
  assert.ok(Number(fs.readFileSync(pidFile, 'utf8')) > 0);

  const workEntries = fs.readdirSync(workDir);
  const remnants = workEntries.filter(
    (e) => e.startsWith('.link.') || e.startsWith('.part.') || e.startsWith('.test.'),
  );
  assert.equal(remnants.length, 0, `no temporary directories remain: ${remnants.join(', ')}`);
});

test('installer passes explicit environment to client', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-test-');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const port = 18792;
  const server = createTestServer(port, 'test/fixtures/client-captures-env.js', MINIMAL_PKG);
  await new Promise((r) => server.listen(port, r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });

  const capturePath = path.join(sandbox, 'captured.json');
  const inputPath = path.join(sandbox, 'input.txt');
  fs.writeFileSync(inputPath, [`http://127.0.0.1:${port}`, 'interactive-user', 'interactive-password', ''].join('\n'));

  const result = await runInstaller(sandbox, port, 30000, {
    TUNNEL_SERVER_URL: '',
    TUNNEL_USERNAME: '',
    TUNNEL_PASSWORD: '',
    TUNNEL_PROMPT_INPUT: inputPath,
    TUNNEL_CAPTURE_FILE: capturePath,
    TARGET_ORIGIN: '127.0.0.1:9090',
  });

  assert.equal(result.status, 0, `installer should succeed\n${result.stdout}\n${result.stderr}`);

  assert.ok(fs.existsSync(capturePath), 'capture file must exist');
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.deepEqual(capture, {
    server: `ws://127.0.0.1:${port}/tunnel`,
    username: 'interactive-user',
    password: 'interactive-password',
    target: '127.0.0.1:9090',
    promptFdOpen: false,
  });

  const workDir = getWorkDir(sandbox);
  const pidFile = path.join(workDir, 'client.pid');
  if (fs.existsSync(pidFile)) {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()));
    } catch {}
  }
});
