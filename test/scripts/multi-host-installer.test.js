import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = {
  service: path.join(ROOT, 'scripts/setup-service-host.sh'),
  agent: path.join(ROOT, 'scripts/setup-application-host.sh'),
};
const INSTALL_UUID = 'test-uuid';

const READY_BUNDLE = fs.readFileSync(path.join(ROOT, 'test/fixtures/role-ready.js'));
const EXITS_BUNDLE = fs.readFileSync(path.join(ROOT, 'test/fixtures/role-exits.js'));
const NEVER_READY_BUNDLE = fs.readFileSync(path.join(ROOT, 'test/fixtures/role-never-ready.js'));
const AUTH_FAILED_BUNDLE = fs.readFileSync(path.join(ROOT, 'test/fixtures/role-auth-failed.js'));
const INVALID_BUNDLE = Buffer.from('this is not valid javascript {{{', 'utf8');
const MANIFEST_A = JSON.stringify({ type: 'module', private: true, dependencies: { ws: '^8.21.1' } });
const MANIFEST_B = JSON.stringify({ type: 'module', private: true, dependencies: { ws: '^8.21.3' } });

function isRunning(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidFile(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  } catch {
    // no pid file
  }
}

function readTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function exitOf(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code });
    });
  });
}

function getFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function createArtifactServer(fixtures) {
  const server = http.createServer((req, res) => {
    const entry = fixtures[req.url];
    if (entry === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (entry === 'partial') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.write('setInterval(() => {},');
      setTimeout(() => res.destroy(), 50);
      return;
    }
    const content = typeof entry === 'function' ? entry() : entry;
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(content);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

function createMockBin(sandbox, callsFile) {
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'npm'),
    [
      '#!/bin/sh',
      '{',
      '  echo "NPM_CALL cwd=$PWD"',
      '  if [ -f "$PWD/package.json" ]; then cat "$PWD/package.json"; fi',
      '  echo "---"',
      `} >> "${callsFile}"`,
      'mkdir -p "$PWD/node_modules/ws"',
      'echo \'{"name":"ws"}\' > "$PWD/node_modules/ws/package.json"',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  return bin;
}

function runScript(scriptPath, env, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr });
    });
  });
}

function serviceEnv(sandbox, port, overrides = {}) {
  const mockBin = overrides.mockBin || '';
  const env = {
    HOME: sandbox,
    CLIENT_DIR: path.join(sandbox, '.tunnel-client'),
    SERVER_HOST: `127.0.0.1:${port}`,
    INSTALL_UUID,
    TUNNEL_USERNAME: 'admin',
    TUNNEL_PASSWORD: 'secret',
    CLIENT_BUNDLE_URL: `http://127.0.0.1:${port}/${INSTALL_UUID}-client.js`,
    CLIENT_MANIFEST_URL: `http://127.0.0.1:${port}/${INSTALL_UUID}-client-package.json`,
    ALLOW_INSECURE_BUNDLE_URL: '1',
    TUNNEL_READY_TIMEOUT_SECS: '6',
    TUNNEL_ROLLBACK_TIMEOUT_SECS: '6',
  };
  if (mockBin) env.PATH = `${mockBin}:${process.env.PATH}`;
  delete overrides.mockBin;
  return { ...env, ...overrides };
}

function agentEnv(sandbox, port, overrides = {}) {
  const mockBin = overrides.mockBin || '';
  const env = {
    HOME: sandbox,
    AGENT_DIR: path.join(sandbox, '.tcp-agent'),
    SERVER_HOST: `127.0.0.1:${port}`,
    INSTALL_UUID,
    AGENT_USERNAME: 'admin',
    AGENT_PASSWORD: 'secret',
    AGENT_PORTS: '6379,5432',
    AGENT_BUNDLE_URL: `http://127.0.0.1:${port}/${INSTALL_UUID}-tcp-agent.js`,
    AGENT_MANIFEST_URL: `http://127.0.0.1:${port}/${INSTALL_UUID}-tcp-agent-package.json`,
    ALLOW_INSECURE_BUNDLE_URL: '1',
    TUNNEL_READY_TIMEOUT_SECS: '6',
    TUNNEL_ROLLBACK_TIMEOUT_SECS: '6',
  };
  if (mockBin) env.PATH = `${mockBin}:${process.env.PATH}`;
  delete overrides.mockBin;
  return { ...env, ...overrides };
}

function fixturesFor(role, bundle, manifest = MANIFEST_B) {
  return {
    [`/${INSTALL_UUID}-${role}.js`]: bundle,
    [`/${INSTALL_UUID}-${role}-package.json`]: manifest,
  };
}

// ---------------------------------------------------------------------------
// T01 / T02 — clean installs
// ---------------------------------------------------------------------------

test('T01 service host: clean install activates one release with matching pid/ready', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-service-');
  const callsFile = path.join(sandbox, 'npm-calls.txt');
  const mockBin = createMockBin(sandbox, callsFile);
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);

  assert.ok(fs.existsSync(path.join(workDir, 'current')), 'current symlink must exist');
  const current = fs.readlinkSync(path.join(workDir, 'current'));
  assert.ok(current.includes('releases/release.'), `current must point to a release: ${current}`);

  const pidFile = path.join(workDir, 'client.pid');
  const readyFile = path.join(workDir, 'client.ready');
  assert.ok(fs.existsSync(pidFile), 'client.pid must exist');
  assert.ok(fs.existsSync(readyFile), 'client.ready must exist');
  const pid = readTrim(pidFile);
  assert.equal(readTrim(readyFile), pid, 'ready file must contain the running PID');
  assert.ok(isRunning(pid), `PID ${pid} must be running`);

  const stat = fs.statSync(pidFile);
  assert.equal(stat.mode & 0o077, 0, 'client.pid must be private (0600)');
  assert.ok(fs.existsSync(path.join(workDir, 'logs')), 'logs dir must exist');
});

test('T02 application host: clean install binds loopback and exposes configured ports', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-agent-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin }));
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /Local listeners: 127\.0\.0\.1 ports 6379,5432/);
  assert.match(result.stdout, /Redis: REDISCLI_AUTH='<redis-password>'/);
  assert.match(result.stdout, /PostgreSQL: PGPASSWORD=/);

  assert.ok(fs.existsSync(path.join(workDir, 'current')));
  const pid = readTrim(path.join(workDir, 'agent.pid'));
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid);
  assert.ok(isRunning(pid));
});

// ---------------------------------------------------------------------------
// T03 — malformed bundle syntax
// ---------------------------------------------------------------------------

test('T03 malformed bundle: old process untouched, orphan release cleaned', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-syntax-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor('client', READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  const current1 = fs.readlinkSync(path.join(workDir, 'current'));
  assert.ok(isRunning(pid1), 'old process must be running');

  fixtures['/test-uuid-client.js'] = INVALID_BUNDLE;
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(install2.status, 0, 'installer must reject an invalid bundle');

  assert.ok(isRunning(pid1), 'old process must still be running after a rejected candidate');
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), current1, 'current must be unchanged');
  assert.equal(readTrim(path.join(workDir, 'client.pid')), pid1, 'pid file must be unchanged');

  const releases = fs.readdirSync(path.join(workDir, 'releases'));
  assert.equal(releases.length, 1, `no orphan release should remain: ${releases.join(', ')}`);
  const remnants = fs.readdirSync(workDir).filter((e) => e.startsWith('.link.') || e.startsWith('.part.'));
  assert.deepEqual(remnants, [], 'no temporary dirs/files must remain');
});

// ---------------------------------------------------------------------------
// T04 — runtime failure triggers rollback
// ---------------------------------------------------------------------------

test('T04 runtime failure: candidate killed, previous restored, failed log preserved', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-rollback-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor('client', READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'client.pid'));

  fixtures['/test-uuid-client.js'] = EXITS_BUNDLE;
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(install2.status, 0, 'a failed upgrade must exit nonzero');

  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be restored to release 1');
  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(pid2.length > 0 && pid2 !== pid1, 'rollback must start a new process');
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid2, 'ready must match the restored PID');
  assert.ok(isRunning(pid2), `restored PID ${pid2} must be running`);
  assert.ok(!isRunning(pid1), 'candidate process must be gone');

  const releases = fs.readdirSync(path.join(workDir, 'releases'));
  assert.equal(releases.length, 1, `failed release must be removed: ${releases.join(', ')}`);
  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  assert.ok(
    logs.some((f) => f.startsWith('client.failed.')),
    `failed log must be preserved: ${logs.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// T05 — auth failure triggers rollback
// ---------------------------------------------------------------------------

test('T05 auth failure: candidate stopped and previous restored', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-auth-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor('tcp-agent', READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));

  fixtures['/test-uuid-tcp-agent.js'] = AUTH_FAILED_BUNDLE;
  const install2 = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(install2.status, 0, 'auth failure must exit nonzero');

  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be restored');
  const pid = readTrim(path.join(workDir, 'agent.pid'));
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid);
  assert.ok(isRunning(pid), 'restored agent must be running');
});

// ---------------------------------------------------------------------------
// T06 / T07 — download failures leave the old install untouched
// ---------------------------------------------------------------------------

test('T06 manifest download failure: old process untouched, exit nonzero', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-manifest-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor('client', READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0);
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  const current1 = fs.readlinkSync(path.join(workDir, 'current'));

  delete fixtures['/test-uuid-client-package.json'];
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(install2.status, 0, 'manifest failure must exit nonzero');
  assert.match(install2.stderr, /manifest/);

  assert.ok(isRunning(pid1), 'old process must still run');
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), current1);
});

test('T07 bundle download cut short: old process untouched and no partial files', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-partial-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor('client', READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0);
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  const current1 = fs.readlinkSync(path.join(workDir, 'current'));

  fixtures['/test-uuid-client.js'] = 'partial';
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(install2.status, 0, 'partial download must fail');

  assert.ok(isRunning(pid1), 'old process must still run');
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), current1);
  const workEntries = fs.readdirSync(workDir);
  const parts = workEntries.filter((e) => e.includes('.part.'));
  assert.deepEqual(parts, [], `no partial files may remain: ${parts.join(', ')}`);
});

// ---------------------------------------------------------------------------
// T08 — dependency manifest changed: per-release install runs
// ---------------------------------------------------------------------------

test('T08 dependency manifest changed: release 2 installs its own dependencies', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-deps-');
  const callsFile = path.join(sandbox, 'npm-calls.txt');
  const mockBin = createMockBin(sandbox, callsFile);
  const fixtures = fixturesFor('client', READY_BUNDLE, MANIFEST_A);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));

  fixtures['/test-uuid-client-package.json'] = MANIFEST_B;
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install2.status, 0, `stderr:\n${install2.stderr}`);
  const release2 = fs.readlinkSync(path.join(workDir, 'current'));
  assert.notEqual(release2, release1, 'upgrade must create a new release');

  const calls = fs.readFileSync(callsFile, 'utf8');
  assert.ok(calls.includes('8.21.3'), `npm must install for the release with ws ^8.21.3:\n${calls}`);
  assert.ok(fs.existsSync(path.join(release2, 'node_modules/ws')), 'release 2 must have its own node_modules');
  assert.ok(fs.existsSync(path.join(release1, 'node_modules/ws')), 'release 1 keeps its own node_modules');
  assert.equal(fs.readlinkSync(path.join(workDir, 'previous')), release1, 'previous must point to release 1');
});

// ---------------------------------------------------------------------------
// T09 — stale PID points to an unrelated process
// ---------------------------------------------------------------------------

test('T09 stale PID for an unrelated process is never killed', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-pid-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  fs.mkdirSync(workDir, { recursive: true });

  const unrelated = spawn('sleep', ['300']);
  t.after(async () => {
    try {
      unrelated.kill('SIGKILL');
    } catch {}
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 100));

  fs.writeFileSync(path.join(workDir, 'client.pid'), String(unrelated.pid));

  const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(result.status, 0, 'installer must refuse to kill an unrelated process');
  assert.match(result.stderr, /refusing to operate/);
  assert.ok(isRunning(unrelated.pid), 'the unrelated process must still be alive');
  assert.ok(!fs.existsSync(path.join(workDir, 'current')), 'no release may be activated');
  const releases = fs.readdirSync(path.join(workDir, 'releases'));
  assert.deepEqual(releases, [], 'orphan staging release must be cleaned');
});

// ---------------------------------------------------------------------------
// T10 — concurrent installers / install lock
// ---------------------------------------------------------------------------

test('T10 install lock: a concurrent run fails fast and a stale lock is recovered', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-lock-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  const env = serviceEnv(sandbox, server.port, { mockBin });
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const holder = spawn('sleep', ['300']);
  fs.mkdirSync(path.join(workDir, '.install.lock'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.install.lock/pid'), String(holder.pid));

  const blocked = await runScript(SCRIPT.service, env, 15000);
  assert.notEqual(blocked.status, 0, 'concurrent run must fail');
  assert.match(blocked.stderr, /Another installation is already running/);
  assert.ok(isRunning(holder.pid), 'lock holder must be unaffected');

  try {
    holder.kill('SIGKILL');
  } catch {}
  await new Promise((r) => setTimeout(r, 100));

  const recovered = await runScript(SCRIPT.service, env);
  assert.equal(recovered.status, 0, `stale lock must be recovered:\n${recovered.stderr}`);
});

// ---------------------------------------------------------------------------
// T11 / T12 — agent bind address policy
// ---------------------------------------------------------------------------

test('T11 agent non-loopback bind is rejected without an explicit override', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-bind-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin, AGENT_BIND_HOST: '0.0.0.0' }));
  assert.notEqual(result.status, 0, 'non-loopback bind must be rejected');
  assert.match(result.stderr, /Refusing a non-loopback bind/);
  assert.ok(!fs.existsSync(workDir), 'nothing may be installed');
});

test('T12 agent non-loopback bind is allowed with an explicit override', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-bind-ok-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_BIND_HOST: '0.0.0.0', ALLOW_REMOTE_AGENT_BIND: '1' }),
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /Local listeners: 0\.0\.0\.0 ports 6379,5432/);
});

// ---------------------------------------------------------------------------
// T13 — malformed AGENT_PORTS
// ---------------------------------------------------------------------------

test('T13 malformed AGENT_PORTS values are rejected', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-ports-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  for (const ports of [
    'abc',
    '0',
    '65536',
    '6379,',
    ',6379',
    '6379,,5432',
    '6379,6379',
    '06379,6379',
    '05432,5432',
    '6379, abc',
    '6379,70000',
  ]) {
    const result = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin, AGENT_PORTS: ports }));
    assert.notEqual(result.status, 0, `AGENT_PORTS='${ports}' must be rejected`);
    assert.match(result.stderr, /AGENT_PORTS/, `AGENT_PORTS='${ports}' error must mention AGENT_PORTS`);
  }
});

test('T13b AGENT_PORTS is required (no default)', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-ports-req-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const env = agentEnv(sandbox, server.port, { mockBin });
  delete env.AGENT_PORTS;
  const result = await runScript(SCRIPT.agent, env);
  assert.notEqual(result.status, 0, 'missing AGENT_PORTS must fail');
  assert.match(result.stderr, /AGENT_PORTS is required/);
});

test('T13c leading zeros in AGENT_PORTS are canonicalized', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-ports-canon-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  const freePort = await getFreePort();
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PORTS: `0${freePort}` }),
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  const pid = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(isRunning(pid), 'agent process must be running');
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid);
});

// ---------------------------------------------------------------------------
// T14 — secrets never appear in installer output
// ---------------------------------------------------------------------------

test('T14 credentials never appear in installer output', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-secret-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  const username = 'su3r-us3r-xyz';
  const password = 'sup3r-s3cret-p@ss';
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_USERNAME: username, TUNNEL_PASSWORD: password }),
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password), 'password must not be logged');
  assert.ok(!result.stdout.includes(username) && !result.stderr.includes(username), 'username must not be logged');
});

// ---------------------------------------------------------------------------
// T15 / T16 — log preservation
// ---------------------------------------------------------------------------

test('T15 old logs are preserved across an upgrade', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-logs-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0);
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install2.status, 0, `stderr:\n${install2.stderr}`);

  assert.ok(fs.existsSync(path.join(workDir, 'client.log')), 'live client.log must exist');
  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  assert.ok(
    logs.some((f) => f.startsWith('client.') && f.endsWith('.log') && !f.includes('failed')),
    `rotated logs must exist: ${logs.join(', ')}`,
  );
});

test('T16 rollback keeps the failed candidate log for diagnostics', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-failed-log-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor('client', READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0);

  fixtures['/test-uuid-client.js'] = AUTH_FAILED_BUNDLE;
  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(install2.status, 0);

  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  const failed = logs.filter((f) => f.startsWith('client.failed.'));
  assert.equal(failed.length, 1, `exactly one failed log must be preserved: ${logs.join(', ')}`);
  assert.ok(fs.readFileSync(path.join(workDir, 'logs', failed[0]), 'utf8').includes('auth_failed'));
});

// ---------------------------------------------------------------------------
// T17 — first install failure leaves no dangling state
// ---------------------------------------------------------------------------

test('T17 first install failure leaves no active release or candidate', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-first-fail-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', NEVER_READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.notEqual(result.status, 0, 'first install must fail');
  assert.ok(!fs.existsSync(path.join(workDir, 'current')), 'no current symlink');
  assert.ok(!fs.existsSync(path.join(workDir, 'client.pid')), 'no client.pid');
  assert.ok(!fs.existsSync(path.join(workDir, 'client.ready')), 'no client.ready');
  assert.deepEqual(fs.readdirSync(path.join(workDir, 'releases')), [], 'no orphan releases');
});

// ---------------------------------------------------------------------------
// T18 — reinstall the same configuration
// ---------------------------------------------------------------------------

test('T18 reinstalling the same configuration leaves exactly one active process', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-reinstall-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0);
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));

  const install2 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install2.status, 0, `stderr:\n${install2.stderr}`);

  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.notEqual(pid2, pid1, 'a fresh process must replace the old one');
  assert.ok(!isRunning(pid1), 'the old process must be stopped');
  assert.ok(isRunning(pid2), 'the new process must be running');
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid2);
  assert.equal(fs.readlinkSync(path.join(workDir, 'previous')), release1, 'previous must point to release 1');
});

// ---------------------------------------------------------------------------
// T19 — legacy layout migration
// ---------------------------------------------------------------------------

test('T19 legacy layout is preserved as the rollback target before a new install', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-migrate-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'client.js'), READY_BUNDLE);
  fs.writeFileSync(path.join(workDir, 'package.json'), MANIFEST_B);
  fs.mkdirSync(path.join(workDir, 'node_modules/ws'), { recursive: true });
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);

  const releases = fs.readdirSync(path.join(workDir, 'releases'));
  const legacy = releases.filter((r) => r.startsWith('release.legacy.'));
  assert.equal(legacy.length, 1, `legacy bundle must be archived: ${releases.join(', ')}`);
  assert.equal(fs.readlinkSync(path.join(workDir, 'previous')), path.join(workDir, 'releases', legacy[0]));
  assert.ok(!fs.existsSync(path.join(workDir, 'client.js')), 'legacy bundle must be moved out of the work root');
  assert.ok(fs.readlinkSync(path.join(workDir, 'current')).includes('releases/release.'));
  const pid = readTrim(path.join(workDir, 'client.pid'));
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid);
  assert.ok(isRunning(pid));
});

// ---------------------------------------------------------------------------
// Work dir path with spaces
// ---------------------------------------------------------------------------

test('work dir with spaces survives upgrades and retention pruning', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-ws-path-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, 'tunnel client dir');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const opts = {
    mockBin,
    CLIENT_DIR: workDir,
    SETUP_LOG_KEEP: '1',
    INSTALL_RELEASES_KEEP: '2',
  };

  for (let i = 0; i < 3; i++) {
    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { ...opts }));
    assert.equal(result.status, 0, `install #${i + 1} stderr:\n${result.stderr}`);
  }

  const pid = readTrim(path.join(workDir, 'client.pid'));
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid);
  assert.ok(isRunning(pid));

  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  assert.equal(
    logs.length,
    1,
    `retention must keep exactly SETUP_LOG_KEEP=1 rotated log under a spaces path, found: ${logs.join(', ')}`,
  );
  const releases = fs.readdirSync(path.join(workDir, 'releases'));
  assert.equal(
    releases.length,
    2,
    `retention must keep exactly INSTALL_RELEASES_KEEP=2 releases under a spaces path, found: ${releases.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Config validation edge cases
// ---------------------------------------------------------------------------

test('SERVER_HOST and INSTALL_UUID reject injection-shaped values', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-config-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  for (const bad of [
    'https://evil.example',
    'host/path',
    'host?a=b',
    'host#frag',
    'host\nx',
    'host:99999',
    'host:abc',
  ]) {
    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, SERVER_HOST: bad }));
    assert.notEqual(result.status, 0, `SERVER_HOST='${bad}' must be rejected`);
    assert.match(result.stderr, /SERVER_HOST/);
  }

  for (const bad of ['a/b', 'a?b', 'a#b', 'a b', 'a\nb']) {
    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, INSTALL_UUID: bad }));
    assert.notEqual(result.status, 0, `INSTALL_UUID='${bad}' must be rejected`);
    assert.match(result.stderr, /INSTALL_UUID/);
  }
  assert.ok(!fs.existsSync(workDir) || fs.readdirSync(workDir).length === 0, 'nothing may be installed');
});

test('SERVER_HOST rejects empty host or empty port forms', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-host-empty-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  for (const bad of ['host:', ':443']) {
    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, SERVER_HOST: bad }));
    assert.notEqual(result.status, 0, `SERVER_HOST='${bad}' must be rejected`);
    assert.match(result.stderr, /SERVER_HOST/);
  }
  assert.ok(!fs.existsSync(workDir) || fs.readdirSync(workDir).length === 0, 'nothing may be installed');
});

test('SERVER_HOST rejects unbracketed multi-colon (ambiguous IPv6)', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-host-ipv6-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  for (const bad of ['::1', '2001:db8::1', 'fe80::1%eth0', 'foo:123:456']) {
    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, SERVER_HOST: bad }));
    assert.notEqual(result.status, 0, `SERVER_HOST='${bad}' (unbracketed multi-colon) must be rejected`);
    assert.match(
      result.stderr,
      /unbracketed multi-colon|SERVER_HOST/,
      `stderr for '${bad}' must mention rejection reason`,
    );
  }
  assert.ok(!fs.existsSync(workDir) || fs.readdirSync(workDir).length === 0, 'nothing may be installed');
});

test('SERVER_HOST accepts valid hostname and IPv6 forms', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-host-valid-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  for (const valid of ['example.com', 'example.com:443', '[::1]', '[::1]:8443']) {
    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, SERVER_HOST: valid }));
    assert.equal(result.status, 0, `SERVER_HOST='${valid}' must pass validation (stderr:\n${result.stderr})`);
  }
  const pid = readTrim(path.join(workDir, 'client.pid'));
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid, 'last install must be ready');
  assert.ok(isRunning(pid));
});

test('numeric tuning settings reject malformed and out-of-range values', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-tuning-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const agentServer = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  const agentWorkDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    await server.close();
    await agentServer.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const settings = [
    'INSTALL_RELEASES_KEEP',
    'SETUP_LOG_KEEP',
    'TUNNEL_READY_TIMEOUT_SECS',
    'TUNNEL_ROLLBACK_TIMEOUT_SECS',
  ];
  for (const bad of ['abc', '-1', '0', '1.5']) {
    for (const key of settings) {
      const svc = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, [key]: bad }));
      assert.notEqual(svc.status, 0, `service: ${key}='${bad}' must be rejected`);
      assert.match(svc.stderr, new RegExp(key), `service: error must mention ${key}`);
      const agent = await runScript(SCRIPT.agent, agentEnv(sandbox, agentServer.port, { mockBin, [key]: bad }));
      assert.notEqual(agent.status, 0, `agent: ${key}='${bad}' must be rejected`);
      assert.match(agent.stderr, new RegExp(key), `agent: error must mention ${key}`);
    }
  }
  assert.ok(!fs.existsSync(workDir) || fs.readdirSync(workDir).length === 0, 'service must not stage anything');
  assert.ok(!fs.existsSync(agentWorkDir) || fs.readdirSync(agentWorkDir).length === 0, 'agent must not stage anything');
});

// ---------------------------------------------------------------------------
// T-RETENTION — interrupt recovery that cannot restore the previous release
// must retain the failed candidate release for inspection.
//
// The previous release directory is removed while the installer is paused in
// the test-only candidate-starting synchronization point, so interrupt
// recovery finds no usable rollback target. The documented contract requires
// the failed candidate release to survive cleanup in that case.
// ---------------------------------------------------------------------------

const DELAYED_READY_BUNDLE = `
import { writeFileSync } from 'node:fs';
const readyFile = process.env.TUNNEL_READY_FILE || process.env.AGENT_READY_FILE;
setTimeout(() => writeFileSync(readyFile, String(process.pid)), 15000);
setInterval(() => {}, 1000);
`;

const RETENTION_ROLES = {
  service: {
    fixtureRole: 'client',
    workDirName: '.tunnel-client',
    pidFile: 'client.pid',
    readyFile: 'client.ready',
    bundleUrlKey: 'CLIENT_BUNDLE_URL',
    failedLogPrefix: 'client.failed.',
  },
  agent: {
    fixtureRole: 'tcp-agent',
    workDirName: '.tcp-agent',
    pidFile: 'agent.pid',
    readyFile: 'agent.ready',
    bundleUrlKey: 'AGENT_BUNDLE_URL',
    failedLogPrefix: 'agent.failed.',
  },
};

async function runFailedRecoveryRetentionTest(t, roleName) {
  const v = RETENTION_ROLES[roleName];
  const sandbox = fs.mkdtempSync(`/tmp/retention-${roleName}-`);
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const fixtures = fixturesFor(v.fixtureRole, READY_BUNDLE);
  const server = await createArtifactServer(fixtures);
  const workDir = path.join(sandbox, v.workDirName);
  const pidFile = path.join(workDir, v.pidFile);
  const readyFile = path.join(workDir, v.readyFile);
  const startingMarker = path.join(sandbox, 'candidate-starting.marker');
  const startingContinue = path.join(sandbox, 'candidate-starting.continue');
  t.after(async () => {
    killPidFile(pidFile);
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const env = (overrides = {}) =>
    roleName === 'service'
      ? serviceEnv(sandbox, server.port, { mockBin, ...overrides })
      : agentEnv(sandbox, server.port, { mockBin, ...overrides });

  // Step 1: install the previous release B.
  const install1 = await runScript(SCRIPT[roleName], env());
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const release1Dir = path.resolve(workDir, release1);
  const pid1 = readTrim(pidFile);
  assert.equal(readTrim(readyFile), pid1, 'previous release must be ready');
  assert.ok(isRunning(pid1), 'previous release must be running');

  // Step 2: upgrade to a candidate that stays unready past the signal.
  fixtures[`/${INSTALL_UUID}-${v.fixtureRole}.js`] = DELAYED_READY_BUNDLE;
  const child = spawn('bash', [SCRIPT[roleName]], {
    cwd: ROOT,
    env: env({
      [v.bundleUrlKey]: `http://127.0.0.1:${server.port}/${INSTALL_UUID}-${v.fixtureRole}.js`,
      TUNNEL_READY_TIMEOUT_SECS: '30',
      TEST_CANDIDATE_STARTING_MARKER: startingMarker,
      TEST_CANDIDATE_STARTING_CONTINUE: startingContinue,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 3: deterministic sync — installer is paused inside candidate-starting.
  await waitFor(() => fs.existsSync(startingMarker), 'candidate-starting marker');
  const candidatePid = readTrim(pidFile);
  assert.ok(candidatePid && candidatePid !== pid1, 'candidate PID must be published');
  assert.ok(isRunning(candidatePid), 'candidate must be alive');

  // Step 4: invalidate the rollback target before recovery can use it.
  fs.rmSync(release1Dir, { recursive: true, force: true });

  // Step 5: interrupt and release the synchronization point.
  child.kill('SIGTERM');
  fs.writeFileSync(startingContinue, '1');

  const result = await exitOf(child, 30000);

  // Step 6: recovery failed, so the installer must exit nonzero.
  assert.notEqual(result.status, 0, 'interrupted install with failed recovery must exit nonzero');
  await waitFor(() => !isRunning(candidatePid), 'candidate death');
  assert.ok(!isRunning(pid1), 'previous release process must not be resurrected');

  // Step 7: retention contract — the failed candidate release survives.
  const currentTarget = fs.readlinkSync(path.join(workDir, 'current'));
  assert.notEqual(currentTarget, release1, 'current must not point at the removed previous release');
  const failedReleaseDir = path.resolve(workDir, currentTarget);
  assert.ok(fs.existsSync(failedReleaseDir), `failed candidate release must be retained: ${failedReleaseDir}`);

  // Step 8: dead candidate runtime metadata must not advertise live state.
  assert.equal(readTrim(pidFile), '', 'dead candidate PID metadata must be removed');
  assert.equal(readTrim(readyFile), '', 'dead candidate ready metadata must be removed');

  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  assert.ok(
    logs.some((f) => f.startsWith(v.failedLogPrefix)),
    `failed log must be preserved: ${logs.join(', ')}`,
  );
}

test('T-RETENTION service: failed interrupt recovery retains the failed candidate release', async (t) => {
  await runFailedRecoveryRetentionTest(t, 'service');
});

test('T-RETENTION agent: failed interrupt recovery retains the failed candidate release', async (t) => {
  await runFailedRecoveryRetentionTest(t, 'agent');
});

test('T-HOOK-PAIR service: partial hook env is rejected before destructive upgrade', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/hook-pair-service-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  const currentPath = path.join(workDir, 'current');
  const previousPath = path.join(workDir, 'previous');
  const pidFile = path.join(workDir, 'client.pid');
  const readyFile = path.join(workDir, 'client.ready');
  t.after(async () => {
    killPidFile(pidFile);
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Step 1: baseline install so there is live state to protect.
  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const oldPid = readTrim(pidFile);
  assert.ok(isRunning(oldPid), 'baseline process must be running');

  // Step 2: each malformed shape must be rejected in preflight, leaving the
  // live deployment completely untouched.
  for (const partialHook of [
    { TEST_CANDIDATE_STARTING_MARKER: path.join(sandbox, 'marker-only.marker') },
    { TEST_CANDIDATE_STARTING_CONTINUE: path.join(sandbox, 'continue-only.continue') },
  ]) {
    const currentBefore = fs.readlinkSync(currentPath);
    const previousBefore = fs.existsSync(previousPath) ? fs.readlinkSync(previousPath) : null;

    const result = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin, ...partialHook }));
    assert.notEqual(result.status, 0, 'partial hook env must fail');
    assert.match(
      result.stderr,
      /TEST_CANDIDATE_STARTING_MARKER and TEST_CANDIDATE_STARTING_CONTINUE must be set together/,
    );

    assert.ok(isRunning(oldPid), 'existing process must remain running');
    assert.equal(readTrim(pidFile), oldPid, 'PID metadata must remain unchanged');
    assert.equal(readTrim(readyFile), oldPid, 'ready metadata must remain unchanged');
    assert.equal(fs.readlinkSync(currentPath), currentBefore, 'current must remain unchanged');
    const previousAfter = fs.existsSync(previousPath) ? fs.readlinkSync(previousPath) : null;
    assert.equal(previousAfter, previousBefore, 'previous must remain unchanged');
    if (partialHook.TEST_CANDIDATE_STARTING_MARKER) {
      assert.ok(
        !fs.existsSync(partialHook.TEST_CANDIDATE_STARTING_MARKER),
        'preflight rejection must not create the test marker',
      );
    }
  }
});

test('T-HOOK-PAIR agent: partial hook env is rejected before destructive upgrade', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/hook-pair-agent-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  const currentPath = path.join(workDir, 'current');
  const previousPath = path.join(workDir, 'previous');
  const pidFile = path.join(workDir, 'agent.pid');
  const readyFile = path.join(workDir, 'agent.ready');
  t.after(async () => {
    killPidFile(pidFile);
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Step 1: baseline install so there is live state to protect.
  const install1 = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const oldPid = readTrim(pidFile);
  assert.ok(isRunning(oldPid), 'baseline process must be running');

  // Step 2: each malformed shape must be rejected in preflight, leaving the
  // live deployment completely untouched.
  for (const partialHook of [
    { TEST_CANDIDATE_STARTING_MARKER: path.join(sandbox, 'marker-only.marker') },
    { TEST_CANDIDATE_STARTING_CONTINUE: path.join(sandbox, 'continue-only.continue') },
  ]) {
    const currentBefore = fs.readlinkSync(currentPath);
    const previousBefore = fs.existsSync(previousPath) ? fs.readlinkSync(previousPath) : null;

    const result = await runScript(SCRIPT.agent, agentEnv(sandbox, server.port, { mockBin, ...partialHook }));
    assert.notEqual(result.status, 0, 'partial hook env must fail');
    assert.match(
      result.stderr,
      /TEST_CANDIDATE_STARTING_MARKER and TEST_CANDIDATE_STARTING_CONTINUE must be set together/,
    );

    assert.ok(isRunning(oldPid), 'existing process must remain running');
    assert.equal(readTrim(pidFile), oldPid, 'PID metadata must remain unchanged');
    assert.equal(readTrim(readyFile), oldPid, 'ready metadata must remain unchanged');
    assert.equal(fs.readlinkSync(currentPath), currentBefore, 'current must remain unchanged');
    const previousAfter = fs.existsSync(previousPath) ? fs.readlinkSync(previousPath) : null;
    assert.equal(previousAfter, previousBefore, 'previous must remain unchanged');
    if (partialHook.TEST_CANDIDATE_STARTING_MARKER) {
      assert.ok(
        !fs.existsSync(partialHook.TEST_CANDIDATE_STARTING_MARKER),
        'preflight rejection must not create the test marker',
      );
    }
  }
});
