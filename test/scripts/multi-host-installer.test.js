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
  assert.match(result.stderr, /refusing to kill/);
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
    assert.match(result.stderr, /unbracketed multi-colon|SERVER_HOST/, `stderr for '${bad}' must mention rejection reason`);
  }
  assert.ok(!fs.existsSync(workDir) || fs.readdirSync(workDir).length === 0, 'nothing may be installed');
});
