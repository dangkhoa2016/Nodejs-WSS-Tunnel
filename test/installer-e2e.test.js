import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

function spawnProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = options.timeout
      ? setTimeout(() => {
          child.kill();
          resolve({ status: null, stdout, stderr, signal: 'SIGTERM' });
        }, options.timeout)
      : null;
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr, signal });
    });
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stdout, stderr, signal: null });
    });
  });
}

function isRunning(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

function getWorkDir(sandbox) {
  return path.join(sandbox, '.tunnel-client');
}

function readClientDiagnostics(workDir) {
  const parts = [];
  for (const name of ['client.log', 'client.pid', 'client.ready']) {
    const filePath = path.join(workDir, name);
    if (fs.existsSync(filePath)) {
      parts.push(`--- ${name} ---\n${fs.readFileSync(filePath, 'utf8')}`);
    }
  }
  return parts.join('\n');
}

function restoreEnv(name, prevValue) {
  if (prevValue === undefined) delete process.env[name];
  else process.env[name] = prevValue;
}

async function startTunnelServer(port, username, password) {
  const prevPort = process.env.PORT;
  const prevUser = process.env.TUNNEL_USERNAME;
  const prevPass = process.env.TUNNEL_PASSWORD;
  const prevInstallUuid = process.env.INSTALL_UUID;
  process.env.PORT = String(port);
  process.env.TUNNEL_USERNAME = username;
  process.env.TUNNEL_PASSWORD = password;
  process.env.INSTALL_UUID = 'e2e-install';
  try {
    const { TunnelServer } = await import('../src/TunnelServer.js');
    const server = new TunnelServer();
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return server;
  } finally {
    restoreEnv('PORT', prevPort);
    restoreEnv('TUNNEL_USERNAME', prevUser);
    restoreEnv('TUNNEL_PASSWORD', prevPass);
    restoreEnv('INSTALL_UUID', prevInstallUuid);
  }
}

function startEchoServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`echo:${req.method}:${req.url}:${body}`);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        cleanup: () => new Promise((resolve) => srv.close(resolve)),
      });
    });
  });
}

function runInstaller(workDir, tunnelPort, echoPort, homeDir, timeoutMs) {
  return spawnProcess('bash', ['serve/setup.sh'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      TUNNEL_SERVER_URL: `ws://127.0.0.1:${tunnelPort}/tunnel`,
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      TARGET_ORIGIN: `http://127.0.0.1:${echoPort}`,
      INSTALL_UUID: 'e2e-install',
    },
    timeout: timeoutMs,
  });
}

function tunneledRequest(tunnelPort, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: tunnelPort, method, path: urlPath, timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

test('E2E: first install, upgrade, and rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/installer-e2e-');
  const workDir = getWorkDir(sandbox);
  const buildDir = path.join(sandbox, 'build');
  fs.mkdirSync(workDir, { recursive: true });

  const cleanupOps = [];

  const buildResult = await spawnProcess('node', ['serve/build.js'], {
    cwd: process.cwd(),
    env: { ...process.env, OUT_DIR: buildDir },
  });
  assert.equal(buildResult.status, 0, 'client build failed');
  assert.ok(fs.existsSync(path.join(buildDir, 'client.js')), 'client.js missing after build');

  const bundleBefore = fs.readFileSync(path.join(buildDir, 'client.js'));
  t.after(async () => {
    const pidFile = path.join(workDir, 'client.pid');
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()));
      } catch {}
    }
    for (const fn of cleanupOps.reverse()) await fn();
    assert.deepEqual(
      fs.readFileSync(path.join(buildDir, 'client.js')),
      bundleBefore,
      'E2E must not mutate the generated artifact',
    );
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const goodBundle = fs.readFileSync(path.join(buildDir, 'client.js'));
  const badBundle = fs.readFileSync('test/fixtures/client-never-ready.js');
  let activeBundle = goodBundle;

  const echo = await startEchoServer();
  cleanupOps.push(echo.cleanup);

  const tunnel = await startTunnelServer(18792, 'admin', 'secret');
  const origServe = tunnel.httpRouter._serveFile.bind(tunnel.httpRouter);
  tunnel.httpRouter._serveFile = (res, filePath, contentType) => {
    if (filePath.endsWith('client.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(activeBundle);
      return;
    }
    return origServe(res, filePath, contentType);
  };
  cleanupOps.push(() => tunnel.close());

  await new Promise((r) => setTimeout(r, 300));

  // ---- First install ----
  const install1 = await runInstaller(workDir, 18792, echo.port, sandbox, 25000);
  assert.equal(
    install1.status,
    0,
    `First install failed\nstdout: ${install1.stdout}\nstderr: ${install1.stderr}\n${readClientDiagnostics(workDir)}`,
  );

  const readyFile = path.join(workDir, 'client.ready');
  assert.ok(fs.existsSync(readyFile), 'client.ready must exist');
  const pid1 = Number(fs.readFileSync(readyFile, 'utf8').trim());
  assert.ok(pid1 > 0, 'PID must be positive');
  assert.ok(isRunning(pid1), `PID ${pid1} must be running`);

  const pidFilePath = path.join(workDir, 'client.pid');
  assert.ok(fs.existsSync(pidFilePath), 'client.pid must exist');
  assert.equal(Number(fs.readFileSync(pidFilePath, 'utf8').trim()), pid1, 'PID files must match');

  const currentLink = path.join(workDir, 'current');
  assert.ok(fs.existsSync(currentLink), 'current symlink must exist');
  const current1 = fs.readlinkSync(currentLink);
  assert.ok(current1.includes('releases/'), 'current must point to a release');
  assert.ok(!fs.existsSync(path.join(workDir, 'previous')), 'previous should not exist after first install');

  // ---- Tunneled request ----
  await new Promise((r) => setTimeout(r, 500));
  const res = await tunneledRequest(18792, 'GET', '/test-path');
  assert.equal(res.status, 200, `Tunneled request failed: ${res.status} ${res.body}`);
  assert.ok(res.body.includes('echo:'), `Response should contain echo: ${res.body}`);
  assert.ok(res.body.includes('/test-path'), `Response should contain path: ${res.body}`);

  // ---- Upgrade: second install ----
  const install2 = await runInstaller(workDir, 18792, echo.port, sandbox, 25000);
  assert.equal(
    install2.status,
    0,
    `Upgrade failed\nstdout: ${install2.stdout}\nstderr: ${install2.stderr}\n${readClientDiagnostics(workDir)}`,
  );

  const pid2 = Number(fs.readFileSync(readyFile, 'utf8').trim());
  assert.notEqual(pid2, pid1, 'PID must change after upgrade');
  assert.ok(isRunning(pid2), `Second PID ${pid2} must be running`);
  assert.equal(Number(fs.readFileSync(pidFilePath, 'utf8').trim()), pid2, 'client.pid must match new PID');

  const current2 = fs.readlinkSync(currentLink);
  assert.notEqual(current2, current1, 'current must point to a new release');

  const previousLink = path.join(workDir, 'previous');
  assert.ok(fs.existsSync(previousLink), 'previous symlink must exist after upgrade');
  assert.equal(fs.readlinkSync(previousLink), current1, 'previous must point to first release');

  // ---- Rollback: bad upgrade ----
  activeBundle = badBundle;

  const install3 = await runInstaller(workDir, 18792, echo.port, sandbox, 30000);
  assert.equal(
    install3.status,
    0,
    `rollback upgrade should restore a working client\nstdout: ${install3.stdout}\nstderr: ${install3.stderr}\n${readClientDiagnostics(workDir)}`,
  );

  const pid3 = Number(fs.readFileSync(readyFile, 'utf8').trim());
  assert.ok(pid3 > 0, 'rollback client PID must be positive');
  assert.ok(isRunning(pid3), `rollback client PID ${pid3} must be running`);

  assert.equal(fs.readlinkSync(currentLink), current2, 'current must point to the last good release after rollback');
  assert.equal(fs.readlinkSync(previousLink), current1, 'previous must point to the first release after rollback');
  assert.notEqual(pid3, pid2, 'rollback client PID must differ from the failed upgrade PID');

  activeBundle = goodBundle;

  await new Promise((r) => setTimeout(r, 1000));
  const res2 = await tunneledRequest(18792, 'GET', '/verify-rollback');
  assert.equal(res2.status, 200, `Post-rollback request failed: ${res2.status} ${res2.body}`);
  assert.ok(res2.body.includes('echo:'), `Post-rollback response should contain echo: ${res2.body}`);
  assert.ok(res2.body.includes('/verify-rollback'), `Post-rollback response should contain path: ${res2.body}`);

  assert.deepEqual(
    fs.readFileSync(path.join(buildDir, 'client.js')),
    bundleBefore,
    'E2E must not mutate the generated artifact',
  );
});
