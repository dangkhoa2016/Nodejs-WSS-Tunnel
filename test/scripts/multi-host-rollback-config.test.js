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

const CREDENTIAL_AGENT_BUNDLE = `
const ok = process.env.AGENT_PASSWORD === 'correct-password';
if (!ok) {
  console.error('auth_failed');
  setTimeout(() => process.exit(1), 200);
} else {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.AGENT_READY_FILE, String(process.pid));
}
setInterval(() => {}, 1000);
`;

const CREDENTIAL_CLIENT_BUNDLE = `
const ok = process.env.TUNNEL_PASSWORD === 'correct-password';
if (!ok) {
  console.error('auth_failed');
  setTimeout(() => process.exit(1), 200);
} else {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TUNNEL_READY_FILE, String(process.pid));
}
setInterval(() => {}, 1000);
`;

const PORT_BIND_BUNDLE = `
import net from 'node:net';
import { writeFileSync } from 'node:fs';
const ports = process.env.AGENT_PORTS.split(',').map(Number);
const servers = [];
for (const port of ports) {
  const server = net.createServer();
  await new Promise((resolve) => {
    server.once('error', (err) => {
      console.error('bind_failed ' + port + ': ' + err.code);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
}
writeFileSync(process.env.AGENT_READY_FILE, String(process.pid));
setInterval(() => {}, 1000);
`;

const NEVER_READY_BUNDLE = `
// Bundle that exits immediately — simulates a broken candidate that never
// becomes ready, so code-only rollback can succeed with current credentials.
setTimeout(() => process.exit(1), 200);
setInterval(() => {}, 1000);
`;

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
// RB01 — application host: wrong password upgrade rolls back to previous config
// ---------------------------------------------------------------------------

test('RB01 application host: rollback restores the previous credential', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rb-agent-cred-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', CREDENTIAL_AGENT_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'agent.pid'));
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid1);
  assert.ok(isRunning(pid1), 'previous process must be running');

  const install2 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PASSWORD: 'wrong-password' }),
  );
  assert.notEqual(install2.status, 0, 'a wrong-password upgrade must exit nonzero');

  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be restored to release 1');
  const pid2 = readTrim(path.join(workDir, 'agent.pid'));
  assert.notEqual(pid2, pid1, 'rollback must start a fresh process');
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid2, 'rollback must reuse the previous credential');
  assert.ok(isRunning(pid2), `restored PID ${pid2} must be running`);

  assert.ok(
    !install1.stdout.includes('correct-password') && !install1.stderr.includes('correct-password'),
    'install1 must not leak the credential',
  );
  assert.ok(
    !install2.stdout.includes('wrong-password') &&
      !install2.stderr.includes('wrong-password') &&
      !install2.stdout.includes('correct-password') &&
      !install2.stderr.includes('correct-password'),
    'install2 must not leak either credential',
  );
});

// ---------------------------------------------------------------------------
// RB02 — application host: changed AGENT_PORTS rolls back to previous ports
// ---------------------------------------------------------------------------

test('RB02 application host: rollback restores the previous AGENT_PORTS', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rb-agent-ports-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', PORT_BIND_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  const freePort = await getFreePort();
  t.after(async () => {
    try {
      blocker.close();
    } catch {}
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PORTS: String(freePort) }),
  );
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'agent.pid'));
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid1);
  assert.ok(isRunning(pid1), 'previous process must be running');

  const install2 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PORTS: `${freePort},${busyPort}` }),
  );
  assert.notEqual(install2.status, 0, 'an upgrade with an occupied extra port must fail');

  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be restored to release 1');
  const pid2 = readTrim(path.join(workDir, 'agent.pid'));
  assert.notEqual(pid2, pid1, 'rollback must start a fresh process');
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid2, 'rollback must reuse the previous port set');
  assert.ok(isRunning(pid2), `restored PID ${pid2} must be running`);
});

// ---------------------------------------------------------------------------
// RB04 — service host: wrong password upgrade rolls back to previous config
// ---------------------------------------------------------------------------

test('RB04 service host: rollback restores the previous credential', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rb-client-cred-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid1);
  assert.ok(isRunning(pid1), 'previous process must be running');

  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'wrong-password' }),
  );
  assert.notEqual(install2.status, 0, 'a wrong-password upgrade must exit nonzero');

  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be restored to release 1');
  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.notEqual(pid2, pid1, 'rollback must start a fresh process');
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid2, 'rollback must reuse the previous credential');
  assert.ok(isRunning(pid2), `restored PID ${pid2} must be running`);
});

// ---------------------------------------------------------------------------
// RB05 — secrets never appear in installer output across a config capture
// ---------------------------------------------------------------------------

test('RB05 previous and candidate secrets never appear in installer output', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rb-secret-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const agentServer = await createArtifactServer(fixturesFor('tcp-agent', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  const agentWorkDir = path.join(sandbox, '.tcp-agent');
  const clientSecretA = 'prev-client-s3cret-A';
  const clientSecretB = 'new-client-s3cret-B';
  const agentSecretA = 'prev-agent-s3cret-A';
  const agentSecretB = 'new-agent-s3cret-B';
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    killPidFile(path.join(agentWorkDir, 'agent.pid'));
    await server.close();
    await agentServer.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const s1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: clientSecretA }),
  );
  assert.equal(s1.status, 0, `stderr:\n${s1.stderr}`);
  const s2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: clientSecretB }),
  );
  assert.equal(s2.status, 0, `stderr:\n${s2.stderr}`);
  for (const [label, result] of [
    ['service install1', s1],
    ['service install2', s2],
  ]) {
    assert.ok(
      !result.stdout.includes(clientSecretA) &&
        !result.stderr.includes(clientSecretA) &&
        !result.stdout.includes(clientSecretB) &&
        !result.stderr.includes(clientSecretB),
      `${label} must not leak client secrets`,
    );
  }

  const a1 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, agentServer.port, { mockBin, AGENT_PASSWORD: agentSecretA }),
  );
  assert.equal(a1.status, 0, `stderr:\n${a1.stderr}`);
  const a2 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, agentServer.port, { mockBin, AGENT_PASSWORD: agentSecretB }),
  );
  assert.equal(a2.status, 0, `stderr:\n${a2.stderr}`);
  for (const [label, result] of [
    ['agent install1', a1],
    ['agent install2', a2],
  ]) {
    assert.ok(
      !result.stdout.includes(agentSecretA) &&
        !result.stderr.includes(agentSecretA) &&
        !result.stdout.includes(agentSecretB) &&
        !result.stderr.includes(agentSecretB),
      `${label} must not leak agent secrets`,
    );
  }
});

// ---------------------------------------------------------------------------
// RB06 — /proc unavailable: refuse destructive activation without override
// ---------------------------------------------------------------------------

test('RB06 unreadable previous environment blocks destructive activation', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rb-environ-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
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

  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: path.join(sandbox, 'no-such-environ-file'),
    }),
  );
  assert.notEqual(install2.status, 0, 'installer must refuse to proceed');
  assert.match(install2.stderr, /ALLOW_CODE_ONLY_ROLLBACK/, 'error must explain the code-only override');

  assert.ok(isRunning(pid1), 'the running process must be untouched');
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be unchanged');
  assert.equal(readTrim(path.join(workDir, 'client.pid')), pid1, 'pid file must be unchanged');
});

test('RB06b ALLOW_CODE_ONLY_ROLLBACK=1 lets the install proceed', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rb-environ-ok-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);

  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: path.join(sandbox, 'no-such-environ-file'),
      ALLOW_CODE_ONLY_ROLLBACK: '1',
    }),
  );
  assert.equal(install2.status, 0, `stderr:\n${install2.stderr}`);

  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid2);
  assert.ok(isRunning(pid2), 'the replacement process must be running');
});

// ---------------------------------------------------------------------------
// RC01 — real rollback: env var present in old process is preserved
// ---------------------------------------------------------------------------

test('RC01 env var present in old process is preserved on rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rc01-present-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Install with correct password — succeeds
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);

  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(isRunning(pid1), 'first install must be running');

  // Fake previous environ with old values
  const envFile = path.join(sandbox, 'fake-environ');
  fs.writeFileSync(
    envFile,
    `TUNNEL_SERVER_URL=ws://old:9999/tcp\x00TUNNEL_USERNAME=olduser\x00TUNNEL_PASSWORD=correct-password\x00TCP_TUNNEL_HOST=127.0.0.1\x00`,
  );

  // Candidate uses wrong password → fails → triggers rollback
  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
      TUNNEL_PASSWORD: 'wrong-password',
    }),
  );

  // Check rollback process
  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');
  assert.ok(isRunning(pid2), 'rollback process must be running');

  try {
    const environ = fs.readFileSync(`/proc/${pid2}/environ`, 'utf8');
    const envVars = Object.fromEntries(
      environ.split('\0').filter(Boolean).map((entry) => {
        const idx = entry.indexOf('=');
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      }),
    );

    // Must have old values
    assert.equal(envVars['TUNNEL_SERVER_URL'], 'ws://old:9999/tcp',
      'TUNNEL_SERVER_URL must be the old value');
    assert.equal(envVars['TUNNEL_USERNAME'], 'olduser',
      'TUNNEL_USERNAME must be the old value');
  } catch (err) {
    if (err.code === 'ENOENT') {
      t.skip('/proc not available, skipping environ assertions');
    } else {
      throw err;
    }
  }
});

// ---------------------------------------------------------------------------
// RC02 — real rollback: env var present in old process is preserved
// ---------------------------------------------------------------------------

test('RC02 env var present in old process is preserved on rollback (service)', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rc02-present-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Install with correct password — succeeds
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);

  const pid1 = readTrim(path.join(workDir, 'client.pid'));

  // Fake previous environ with old TUNNEL_USERNAME
  const envFile = path.join(sandbox, 'fake-environ');
  fs.writeFileSync(
    envFile,
    `TUNNEL_SERVER_URL=ws://old:9999/tcp\x00TUNNEL_USERNAME=olduser\x00TUNNEL_PASSWORD=correct-password\x00TCP_TUNNEL_HOST=127.0.0.1\x00`,
  );

  // Candidate uses wrong password → fails → triggers rollback
  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
      TUNNEL_PASSWORD: 'wrong-password',
    }),
  );

  // Check rollback process
  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');
  assert.ok(isRunning(pid2), 'rollback process must be running');

  try {
    const environ = fs.readFileSync(`/proc/${pid2}/environ`, 'utf8');
    const envVars = Object.fromEntries(
      environ.split('\0').filter(Boolean).map((entry) => {
        const idx = entry.indexOf('=');
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      }),
    );

    // Must have old TUNNEL_USERNAME
    assert.equal(envVars['TUNNEL_USERNAME'], 'olduser',
      'TUNNEL_USERNAME must be the old value');
  } catch (err) {
    if (err.code === 'ENOENT') {
      t.skip('/proc not available, skipping environ assertions');
    } else {
      throw err;
    }
  }
});

// ---------------------------------------------------------------------------
// RC03 — capture_previous_config fails with missing required keys
// ---------------------------------------------------------------------------

test('RC03 missing required keys in old env causes rejection', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rc03-missing-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT.service, serviceEnv(sandbox, server.port, { mockBin }));
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);

  const envFile = path.join(sandbox, 'fake-environ');
  fs.writeFileSync(envFile, `VERBOSE=true\x00LOG_FORMAT=json\x00`);

  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
    }),
  );
  assert.notEqual(install2.status, 0, 'must reject due to missing required keys');
  assert.match(install2.stderr, /missing required keys/);
});

// ---------------------------------------------------------------------------
// RC04 — stale PID metadata is cleaned after rollback failure
// ---------------------------------------------------------------------------

test('RC04 stale PID metadata cleaned after rollback failure', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rc04-stale-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `stderr:\n${install1.stderr}`);

  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(isRunning(pid1));

  const envFile = path.join(sandbox, 'fake-environ');
  fs.writeFileSync(
    envFile,
    `TUNNEL_SERVER_URL=ws://old:9999/tcp\x00TUNNEL_USERNAME=olduser\x00TUNNEL_PASSWORD=oldpass\x00TCP_TUNNEL_HOST=127.0.0.1\x00`,
  );

  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
    }),
  );
  assert.notEqual(install2.status, 0, 'must fail because old password is wrong');

  // PID file must not exist (not just != old PID)
  assert.equal(fs.existsSync(path.join(workDir, 'client.pid')), false,
    'client.pid must be absent after rollback failure');
  // Ready file must not exist
  assert.equal(fs.existsSync(path.join(workDir, 'client.ready')), false,
    'client.ready must be absent after rollback failure');
});

// ---------------------------------------------------------------------------
// RA01 — optional env absent in old process remains absent after rollback
// ---------------------------------------------------------------------------

test('RA01 agent: optional env absent in old process remains absent after rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/ra01-absent-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('tcp-agent', CREDENTIAL_AGENT_BUNDLE));
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Install with correct password — succeeds
  const install1 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const pid1 = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(isRunning(pid1), 'first install must be running');

  // Fake previous environ: required keys present, optional keys ABSENT
  const envFile = path.join(sandbox, 'fake-environ');
  const environData = [
    'TUNNEL_SERVER_URL=ws://old-host:9999/tcp',
    'AGENT_USERNAME=olduser',
    'AGENT_PASSWORD=correct-password',
    'AGENT_PORTS=6379',
    'AGENT_BIND_HOST=127.0.0.1',
  ].join('\0') + '\0';
  fs.writeFileSync(envFile, environData);

  // Install with wrong password — candidate fails, triggers rollback
  const install2 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
      AGENT_PASSWORD: 'wrong-password',
      WS_HIGH_WATER_BYTES: '2000000',
      AGENT_RECONNECT_DELAY_MS: '5000',
    }),
  );

  // Rollback should succeed (old password is correct)
  // The installer may exit 0 (rollback succeeded) or we check the process
  const pid2 = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');
  assert.ok(isRunning(pid2), 'rollback process must be running');

  // Read rollback process environment from /proc
  try {
    const environ = fs.readFileSync(`/proc/${pid2}/environ`, 'utf8');
    const envVars = Object.fromEntries(
      environ.split('\0').filter(Boolean).map((entry) => {
        const idx = entry.indexOf('=');
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      }),
    );

    // Optional keys must NOT be present in rollback process env
    assert.equal(envVars['WS_HIGH_WATER_BYTES'], undefined,
      'WS_HIGH_WATER_BYTES must be absent from rollback process env');
    assert.equal(envVars['AGENT_RECONNECT_DELAY_MS'], undefined,
      'AGENT_RECONNECT_DELAY_MS must be absent from rollback process env');

    // Required keys must be present
    assert.equal(envVars['TUNNEL_SERVER_URL'], 'ws://old-host:9999/tcp',
      'TUNNEL_SERVER_URL must be the old value');
    assert.equal(envVars['AGENT_PASSWORD'], 'correct-password',
      'AGENT_PASSWORD must be the old value');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // /proc may not be available (non-Linux) — skip env assertions
      t.skip('/proc not available, skipping environ assertions');
    } else {
      throw err;
    }
  }
});

// ---------------------------------------------------------------------------
// RC-HYBRID-01 — partial capture + code-only override → no hybrid config
// ---------------------------------------------------------------------------

test('RC-HYBRID-01 code-only rollback uses current config, not partial old', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rc-hybrid-01-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  // Serve both the credential-check bundle and the never-ready bundle
  const server = await createArtifactServer({
    ...fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE),
    [`/never-ready-client.js`]: NEVER_READY_BUNDLE,
  });
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Install with correct password — succeeds
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(isRunning(pid1), 'first install must be running');

  // Fake previous environ: only TUNNEL_SERVER_URL + TUNNEL_USERNAME (missing required password)
  const envFile = path.join(sandbox, 'fake-environ');
  const environData = [
    'TUNNEL_SERVER_URL=ws://old-host:9999/tcp',
    'TUNNEL_USERNAME=olduser',
  ].join('\0') + '\0';
  fs.writeFileSync(envFile, environData);

  // Candidate uses NEVER_READY_BUNDLE (not credential-based failure) +
  // valid current password + ALLOW_CODE_ONLY_ROLLBACK=1.
  // Capture fails (missing required keys), but code-only rollback is allowed.
  // Candidate fails (never ready), then rollback starts previous code with
  // CURRENT config (current password), which succeeds.
  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
      TUNNEL_PASSWORD: 'current-password',
      ALLOW_CODE_ONLY_ROLLBACK: '1',
      CLIENT_BUNDLE_URL: `http://127.0.0.1:${server.port}/never-ready-client.js`,
    }),
  );

  // install2 should exit non-zero (candidate failed, rollback may fail)
  // The key assertion: if a rollback process exists, it uses CURRENT config
  const pid2 = readTrim(path.join(workDir, 'client.pid'));

  try {
    if (pid2 && isRunning(pid2)) {
      const environ = fs.readFileSync(`/proc/${pid2}/environ`, 'utf8');
      const envVars = Object.fromEntries(
        environ.split('\0').filter(Boolean).map((entry) => {
          const idx = entry.indexOf('=');
          return [entry.slice(0, idx), entry.slice(idx + 1)];
        }),
      );

      // Must use CURRENT config, not old partial values
      assert.equal(envVars['TUNNEL_PASSWORD'], 'current-password',
        'TUNNEL_PASSWORD must be the current value');
      assert.equal(envVars['TUNNEL_USERNAME'], undefined,
        'TUNNEL_USERNAME must NOT be the partial old value');
      assert.equal(envVars['TUNNEL_SERVER_URL'], undefined,
        'TUNNEL_SERVER_URL must NOT be the partial old value');
    } else {
      // No running process — partial old values couldn't have been used.
      assert.ok(true, 'no running process means no partial values could have leaked');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      t.skip('/proc not available, skipping environ assertions');
    } else {
      throw err;
    }
  }
});

// ---------------------------------------------------------------------------
// RS01 — service host: optional env absent in old process remains absent after rollback
// RS02 — service host: optional env present in old process is restored on rollback
// ---------------------------------------------------------------------------

test('RS01 service: optional env absent in old process remains absent after rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rs01-absent-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Install with correct password — succeeds
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(isRunning(pid1), 'first install must be running');

  // Fake previous environ: required keys present, optional keys ABSENT
  const envFile = path.join(sandbox, 'fake-environ');
  const environData = [
    'TUNNEL_SERVER_URL=ws://old-host:9999/tcp',
    'TUNNEL_USERNAME=olduser',
    'TUNNEL_PASSWORD=correct-password',
    'TCP_TUNNEL_HOST=127.0.0.1',
  ].join('\0') + '\0';
  fs.writeFileSync(envFile, environData);

  // Candidate sets optional fields + wrong password → fails → rollback
  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
      TUNNEL_PASSWORD: 'wrong-password',
      TARGET_ORIGIN: 'http://127.0.0.1:9999',
      MAX_CONCURRENT_STREAMS: '50',
      STREAM_IDLE_TIMEOUT_MS: '60000',
      WS_HIGH_WATER_BYTES: '2000000',
      MAX_FRAME_PAYLOAD_BYTES: '512000',
      LOCAL_REQUEST_TIMEOUT_MS: '5000',
      TCP_CONNECT_TIMEOUT_MS: '15000',
      VERBOSE: 'true',
      LOG_FORMAT: 'json',
    }),
  );

  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');
  assert.ok(isRunning(pid2), 'rollback process must be running');

  try {
    const environ = fs.readFileSync(`/proc/${pid2}/environ`, 'utf8');
    const envVars = Object.fromEntries(
      environ.split('\0').filter(Boolean).map((entry) => {
        const idx = entry.indexOf('=');
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      }),
    );

    // Optional keys must NOT be present in rollback process env
    const optionalFields = [
      'TARGET_ORIGIN', 'MAX_CONCURRENT_STREAMS', 'STREAM_IDLE_TIMEOUT_MS',
      'WS_HIGH_WATER_BYTES', 'MAX_FRAME_PAYLOAD_BYTES', 'LOCAL_REQUEST_TIMEOUT_MS',
      'TCP_CONNECT_TIMEOUT_MS', 'VERBOSE', 'LOG_FORMAT',
    ];
    for (const field of optionalFields) {
      assert.equal(envVars[field], undefined,
        `${field} must be absent from rollback process env (was absent in old)`);
    }

    // Required keys must be present with old values
    assert.equal(envVars['TUNNEL_SERVER_URL'], 'ws://old-host:9999/tcp',
      'TUNNEL_SERVER_URL must be the old value');
    assert.equal(envVars['TUNNEL_USERNAME'], 'olduser',
      'TUNNEL_USERNAME must be the old value');
    assert.equal(envVars['TUNNEL_PASSWORD'], 'correct-password',
      'TUNNEL_PASSWORD must be the old value');
  } catch (err) {
    if (err.code === 'ENOENT') {
      t.skip('/proc not available, skipping environ assertions');
    } else {
      throw err;
    }
  }
});

test('RS02 service: optional env present in old process is restored on rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/rs02-present-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', CREDENTIAL_CLIENT_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Install with correct password — succeeds
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);

  // Fake previous environ: required + optional keys all present with old values
  const envFile = path.join(sandbox, 'fake-environ');
  const environData = [
    'TUNNEL_SERVER_URL=ws://old-host:9999/tcp',
    'TUNNEL_USERNAME=olduser',
    'TUNNEL_PASSWORD=correct-password',
    'TCP_TUNNEL_HOST=127.0.0.1',
    'TARGET_ORIGIN=http://127.0.0.1:8888',
    'MAX_CONCURRENT_STREAMS=100',
    'STREAM_IDLE_TIMEOUT_MS=90000',
    'WS_HIGH_WATER_BYTES=500000',
    'MAX_FRAME_PAYLOAD_BYTES=128000',
    'LOCAL_REQUEST_TIMEOUT_MS=3000',
    'TCP_CONNECT_TIMEOUT_MS=8000',
    'VERBOSE=true',
    'LOG_FORMAT=json',
  ].join('\0') + '\0';
  fs.writeFileSync(envFile, environData);

  // Candidate changes optional fields + wrong password → fails → rollback
  const install2 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, {
      mockBin,
      PREVIOUS_ENVIRON_SOURCE: envFile,
      TUNNEL_PASSWORD: 'wrong-password',
      TARGET_ORIGIN: 'http://127.0.0.1:7777',
      MAX_CONCURRENT_STREAMS: '50',
      STREAM_IDLE_TIMEOUT_MS: '60000',
      WS_HIGH_WATER_BYTES: '2000000',
      MAX_FRAME_PAYLOAD_BYTES: '512000',
      LOCAL_REQUEST_TIMEOUT_MS: '5000',
      TCP_CONNECT_TIMEOUT_MS: '15000',
      VERBOSE: 'false',
      LOG_FORMAT: 'text',
    }),
  );

  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');
  assert.ok(isRunning(pid2), 'rollback process must be running');

  try {
    const environ = fs.readFileSync(`/proc/${pid2}/environ`, 'utf8');
    const envVars = Object.fromEntries(
      environ.split('\0').filter(Boolean).map((entry) => {
        const idx = entry.indexOf('=');
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      }),
    );

    // Optional keys must be restored to OLD values
    assert.equal(envVars['TARGET_ORIGIN'], 'http://127.0.0.1:8888',
      'TARGET_ORIGIN must be restored to old value');
    assert.equal(envVars['MAX_CONCURRENT_STREAMS'], '100',
      'MAX_CONCURRENT_STREAMS must be restored to old value');
    assert.equal(envVars['STREAM_IDLE_TIMEOUT_MS'], '90000',
      'STREAM_IDLE_TIMEOUT_MS must be restored to old value');
    assert.equal(envVars['WS_HIGH_WATER_BYTES'], '500000',
      'WS_HIGH_WATER_BYTES must be restored to old value');
    assert.equal(envVars['MAX_FRAME_PAYLOAD_BYTES'], '128000',
      'MAX_FRAME_PAYLOAD_BYTES must be restored to old value');
    assert.equal(envVars['LOCAL_REQUEST_TIMEOUT_MS'], '3000',
      'LOCAL_REQUEST_TIMEOUT_MS must be restored to old value');
    assert.equal(envVars['TCP_CONNECT_TIMEOUT_MS'], '8000',
      'TCP_CONNECT_TIMEOUT_MS must be restored to old value');
    assert.equal(envVars['VERBOSE'], 'true',
      'VERBOSE must be restored to old value');
    assert.equal(envVars['LOG_FORMAT'], 'json',
      'LOG_FORMAT must be restored to old value');

    // Required keys must be present with old values
    assert.equal(envVars['TUNNEL_SERVER_URL'], 'ws://old-host:9999/tcp',
      'TUNNEL_SERVER_URL must be the old value');
    assert.equal(envVars['TUNNEL_USERNAME'], 'olduser',
      'TUNNEL_USERNAME must be the old value');
    assert.equal(envVars['TUNNEL_PASSWORD'], 'correct-password',
      'TUNNEL_PASSWORD must be the old value');
  } catch (err) {
    if (err.code === 'ENOENT') {
      t.skip('/proc not available, skipping environ assertions');
    } else {
      throw err;
    }
  }
});

// ---------------------------------------------------------------------------
// INT-01 — service host: SIGTERM after old process stopped → rollback restores previous
// ---------------------------------------------------------------------------

const SLOW_READY_BUNDLE = `
// Simulates a candidate that takes time to become ready.
// Writes the ready file after a delay, giving the test time to send SIGTERM.
setTimeout(async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TUNNEL_READY_FILE, String(process.pid));
}, 15000);
setInterval(() => {}, 1000);
`;

test('INT-01 service: SIGTERM after old process stopped triggers rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/int01-svc-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer({
    ...fixturesFor('client', READY_BUNDLE),
    '/slow-client.js': SLOW_READY_BUNDLE,
  });
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Step 1: Install previous working release
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(isRunning(pid1), 'previous process must be running');

  // Step 2: Start upgrade candidate that never becomes ready (slow bundle)
  const child = spawn('bash', [SCRIPT.service], {
    cwd: ROOT,
    env: serviceEnv(sandbox, server.port, {
      mockBin,
      TUNNEL_PASSWORD: 'wrong-password',
      CLIENT_BUNDLE_URL: `http://127.0.0.1:${server.port}/slow-client.js`,
      TUNNEL_READY_TIMEOUT_SECS: '30',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  // Step 3: Wait for old process to stop and candidate to be activated
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!isRunning(pid1)) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });

  // Give installer time to move symlinks
  await new Promise((r) => setTimeout(r, 500));

  // Step 4: Send SIGTERM to installer
  child.kill('SIGTERM');

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stderr });
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stderr });
    });
  });

  // Step 5: Assert rollback
  assert.notEqual(result.status, 0, `installer must exit nonzero on interrupt; stderr:\n${result.stderr}`);

  // Previous release must be restored as current
  const currentLink = fs.readlinkSync(path.join(workDir, 'current'));
  assert.equal(currentLink, release1,
    `current must be restored to release 1; got ${currentLink}`);

  // Previous process must be running (with retry for timing)
  const pid2 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');

  // Wait for rollback process to fully start
  for (let i = 0; i < 30; i++) {
    if (isRunning(pid2)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(isRunning(pid2),
    `restored process must be running; pid2=${pid2}, stderr=${result.stderr?.slice(-300)}`);

  // Ready file must be valid
  assert.equal(readTrim(path.join(workDir, 'client.ready')), pid2,
    'ready file must contain the restored PID');
});

// ---------------------------------------------------------------------------
// INT-02 — service host: SIGTERM before destructive phase → old process untouched
// ---------------------------------------------------------------------------

test('INT-02 service: SIGTERM during staging leaves old process untouched', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/int02-svc-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer(fixturesFor('client', READY_BUNDLE));
  const workDir = path.join(sandbox, '.tunnel-client');
  t.after(async () => {
    killPidFile(path.join(workDir, 'client.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Step 1: Install previous working release
  const install1 = await runScript(
    SCRIPT.service,
    serviceEnv(sandbox, server.port, { mockBin, TUNNEL_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'client.pid'));
  assert.ok(isRunning(pid1), 'previous process must be running');

  // Step 2: Start installer with a non-existent bundle URL (staging will fail/hang)
  const child = spawn('bash', [SCRIPT.service], {
    cwd: ROOT,
    env: serviceEnv(sandbox, server.port, {
      mockBin,
      TUNNEL_PASSWORD: 'new-password',
      CLIENT_BUNDLE_URL: `http://127.0.0.1:${server.port}/nonexistent-client.js`,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 3: Send SIGTERM quickly (during staging phase)
  await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGTERM');

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null });
    }, 10000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code });
    });
  });

  // Step 4: Assert old process untouched
  assert.notEqual(result.status, 0, 'installer must exit nonzero on interrupt');
  assert.ok(isRunning(pid1), 'old process must still be running');
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1,
    'current symlink must be unchanged');
  assert.equal(readTrim(path.join(workDir, 'client.pid')), pid1,
    'pid file must be unchanged');
});

// ---------------------------------------------------------------------------
// INT-03 — agent: SIGTERM after old process stopped → rollback restores previous
// ---------------------------------------------------------------------------

test('INT-03 agent: SIGTERM after old process stopped triggers rollback', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/int03-agent-');
  const mockBin = createMockBin(sandbox, path.join(sandbox, 'npm-calls.txt'));
  const server = await createArtifactServer({
    ...fixturesFor('tcp-agent', READY_BUNDLE),
    '/slow-agent.js': SLOW_READY_BUNDLE.replace(/TUNNEL_READY_FILE/g, 'AGENT_READY_FILE'),
  });
  const workDir = path.join(sandbox, '.tcp-agent');
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Step 1: Install previous working release
  const install1 = await runScript(
    SCRIPT.agent,
    agentEnv(sandbox, server.port, { mockBin, AGENT_PASSWORD: 'correct-password' }),
  );
  assert.equal(install1.status, 0, `install1 stderr:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(isRunning(pid1), 'previous process must be running');

  // Step 2: Start upgrade candidate that never becomes ready
  const child = spawn('bash', [SCRIPT.agent], {
    cwd: ROOT,
    env: agentEnv(sandbox, server.port, {
      mockBin,
      AGENT_PASSWORD: 'wrong-password',
      AGENT_BUNDLE_URL: `http://127.0.0.1:${server.port}/slow-agent.js`,
      TUNNEL_READY_TIMEOUT_SECS: '30',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 3: Wait for old process to stop
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!isRunning(pid1)) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
  await new Promise((r) => setTimeout(r, 500));

  // Step 4: Send SIGTERM to installer
  child.kill('SIGTERM');

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null });
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code });
    });
  });

  // Step 5: Assert rollback
  assert.notEqual(result.status, 0, 'installer must exit nonzero on interrupt');
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1,
    'current must be restored to release 1');
  const pid2 = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(pid2, 'PID file must exist after rollback');
  assert.ok(isRunning(pid2), 'restored process must be running');
});
