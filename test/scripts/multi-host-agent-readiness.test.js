import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_AGENT = path.join(ROOT, 'scripts/setup-application-host.sh');
const INSTALL_UUID = 'test-uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
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

// Mock npm that copies the repo's real ws package into the release so the
// bundled agent can resolve it offline.
function createMockBin(sandbox) {
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const wsDir = path.join(ROOT, 'node_modules/ws');
  fs.writeFileSync(
    path.join(bin, 'npm'),
    ['#!/bin/sh', 'mkdir -p "$PWD/node_modules"', `cp -r "${wsDir}" "$PWD/node_modules/ws"`, 'exit 0', ''].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  return bin;
}

function runScript(scriptPath, env, timeoutMs = 60000) {
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

function agentEnv(sandbox, serverHost, artifactPort, mockBin, overrides = {}) {
  const env = {
    HOME: sandbox,
    AGENT_DIR: path.join(sandbox, '.tcp-agent'),
    SERVER_HOST: serverHost,
    INSTALL_UUID,
    AGENT_USERNAME: 'admin',
    AGENT_PASSWORD: 'secret',
    AGENT_PORTS: '6379,5432',
    AGENT_BUNDLE_URL: `http://127.0.0.1:${artifactPort}/${INSTALL_UUID}-tcp-agent.js`,
    AGENT_MANIFEST_URL: `http://127.0.0.1:${artifactPort}/${INSTALL_UUID}-tcp-agent-package.json`,
    ALLOW_INSECURE_BUNDLE_URL: '1',
    TUNNEL_READY_TIMEOUT_SECS: '10',
    TUNNEL_ROLLBACK_TIMEOUT_SECS: '10',
    NODE_EXTRA_CA_CERTS: process.env.__WSS_TEST_CERT__ || '',
  };
  if (mockBin) env.PATH = `${mockBin}:${process.env.PATH}`;
  return { ...env, ...overrides };
}

// ---------------------------------------------------------------------------
// Suite-level setup: real bundled agent + TLS mock WSS
// ---------------------------------------------------------------------------

let agentBundle = null;
let manifestJson = null;
let certPem = null;
let keyPem = null;
let wssServer = null;
let wssPort = 0;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'serve/tcp-agent.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['ws'],
    banner: { js: '#!/usr/bin/env node\n' },
    write: false,
    logLevel: 'silent',
  });
  agentBundle = out.outputFiles[0].contents;

  manifestJson = fs.readFileSync(path.join(ROOT, 'serve/tcp-agent-package.json'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-cert-'));
  certPem = path.join(dir, 'cert.pem');
  keyPem = path.join(dir, 'key.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPem,
    '-out',
    certPem,
    '-days',
    '2',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  process.env.__WSS_TEST_CERT__ = certPem;

  const httpsServer = https.createServer({
    cert: fs.readFileSync(certPem),
    key: fs.readFileSync(keyPem),
  });
  const wss = new WebSocketServer({ server: httpsServer });
  const connections = new Set();
  wss.on('connection', (ws) => {
    ws.binaryType = 'nodebuffer';
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
  });
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  wssPort = httpsServer.address().port;
  wssServer = {
    connections,
    close: async () => {
      for (const ws of [...connections]) ws.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => httpsServer.close(r));
    },
  };
});

test.after(async () => {
  if (wssServer) await wssServer.close();
  if (certPem) fs.rmSync(path.dirname(certPem), { recursive: true, force: true });
  delete process.env.__WSS_TEST_CERT__;
});

function fixturesFor(overrides = {}) {
  return {
    [`/${INSTALL_UUID}-tcp-agent.js`]: agentBundle,
    [`/${INSTALL_UUID}-tcp-agent-package.json`]: manifestJson,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// N01 — first install, single occupied port
// ---------------------------------------------------------------------------

test('N01 single occupied port: activation fails and no broken state remains', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-agent-n01-');
  const mockBin = createMockBin(sandbox);
  const server = await createArtifactServer(fixturesFor());
  const workDir = path.join(sandbox, '.tcp-agent');
  const agentPort = await findFreePort();
  const occupied = await occupyPort(agentPort);
  t.after(async () => {
    await occupied.close();
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT_AGENT,
    agentEnv(sandbox, `127.0.0.1:${wssPort}`, server.port, mockBin, { AGENT_PORTS: String(agentPort) }),
  );
  assert.notEqual(result.status, 0, `must fail:\n${result.stdout}\n${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(workDir, 'current')), 'no current symlink');
  assert.ok(!fs.existsSync(path.join(workDir, 'agent.pid')), 'no stale agent.pid');
  assert.ok(!fs.existsSync(path.join(workDir, 'agent.ready')), 'no stale agent.ready');
  assert.deepEqual(fs.readdirSync(path.join(workDir, 'releases')), [], 'no orphan releases');
});

// ---------------------------------------------------------------------------
// N02 — partial listener failure
// ---------------------------------------------------------------------------

test('N02 partial listener failure: never ready, failed log preserved', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-agent-n02-');
  const mockBin = createMockBin(sandbox);
  const server = await createArtifactServer(fixturesFor());
  const workDir = path.join(sandbox, '.tcp-agent');
  const portA = await findFreePort();
  const portB = await findFreePort();
  const occupied = await occupyPort(portB);
  t.after(async () => {
    await occupied.close();
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT_AGENT,
    agentEnv(sandbox, `127.0.0.1:${wssPort}`, server.port, mockBin, { AGENT_PORTS: `${portA},${portB}` }),
  );
  assert.notEqual(result.status, 0, `must fail:\n${result.stdout}\n${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(workDir, 'current')), 'no current symlink');
  assert.ok(!fs.existsSync(path.join(workDir, 'agent.ready')), 'no ready file');
  assert.ok(!fs.existsSync(path.join(workDir, 'agent.pid')), 'no stale pid');

  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  const failed = logs.filter((f) => f.startsWith('agent.failed.'));
  assert.equal(failed.length, 1, `exactly one failed log: ${logs.join(', ')}`);
  assert.ok(
    fs.readFileSync(path.join(workDir, 'logs', failed[0]), 'utf8').includes('listener_error'),
    'failed log must record the listener bind error',
  );
});

// ---------------------------------------------------------------------------
// N03 — all listeners free + WSS ready
// ---------------------------------------------------------------------------

test('N03 all ports free: install succeeds and ports are reachable', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-agent-n03-');
  const mockBin = createMockBin(sandbox);
  const server = await createArtifactServer(fixturesFor());
  const workDir = path.join(sandbox, '.tcp-agent');
  const portA = await findFreePort();
  const portB = await findFreePort();
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT_AGENT,
    agentEnv(sandbox, `127.0.0.1:${wssPort}`, server.port, mockBin, { AGENT_PORTS: `${portA},${portB}` }),
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);

  const pid = readTrim(path.join(workDir, 'agent.pid'));
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid, 'ready must match PID');
  assert.ok(isRunning(pid), 'agent must be running');
  assert.equal(await canConnect(portA), true, 'port A must be listening');
  assert.equal(await canConnect(portB), true, 'port B must be listening');
});

// ---------------------------------------------------------------------------
// N04 — first install listener failure: no broken current / no background proc
// ---------------------------------------------------------------------------

test('N04 first install listener failure leaves no broken state or background process', async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-agent-n04-');
  const mockBin = createMockBin(sandbox);
  const server = await createArtifactServer(fixturesFor());
  const workDir = path.join(sandbox, '.tcp-agent');
  const agentPort = await findFreePort();
  const occupied = await occupyPort(agentPort);
  t.after(async () => {
    await occupied.close();
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const result = await runScript(
    SCRIPT_AGENT,
    agentEnv(sandbox, `127.0.0.1:${wssPort}`, server.port, mockBin, { AGENT_PORTS: String(agentPort) }),
  );
  assert.notEqual(result.status, 0, `must fail:\n${result.stdout}\n${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(workDir, 'current')), 'no current symlink');
  assert.ok(!fs.existsSync(path.join(workDir, 'agent.pid')), 'no stale pid');
  assert.ok(!fs.existsSync(path.join(workDir, 'agent.ready')), 'no stale ready');
  assert.equal(wssServer.connections.size, 0, 'candidate agent must not linger connected');
});

// ---------------------------------------------------------------------------
// N05 — upgrade: listener bind failure rolls back to the previous release
// ---------------------------------------------------------------------------

test('N05 upgrade listener failure: previous release restored and ready', { timeout: 120000 }, async (t) => {
  const sandbox = fs.mkdtempSync('/tmp/mh-agent-n05-');
  const mockBin = createMockBin(sandbox);
  const server = await createArtifactServer(fixturesFor());
  const workDir = path.join(sandbox, '.tcp-agent');
  const portA = await findFreePort();
  const portB = await findFreePort();
  const env = agentEnv(sandbox, `127.0.0.1:${wssPort}`, server.port, mockBin, { AGENT_PORTS: `${portA},${portB}` });
  t.after(async () => {
    killPidFile(path.join(workDir, 'agent.pid'));
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const install1 = await runScript(SCRIPT_AGENT, env);
  assert.equal(install1.status, 0, `install1 must succeed:\n${install1.stderr}`);
  const release1 = fs.readlinkSync(path.join(workDir, 'current'));
  const pid1 = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(isRunning(pid1), 'release1 agent must be running');

  // Transiently occupy portB as soon as the old process dies, so the candidate
  // fails to bind, and release it once the candidate logs the bind error so the
  // rollback can re-bind it.
  let holder = null;
  let occupied = false;
  const startedAt = Date.now();
  const poller = (async () => {
    while (Date.now() - startedAt < 20000) {
      if (!occupied && !isRunning(pid1)) {
        try {
          holder = await occupyPort(portB);
          occupied = true;
        } catch {
          // transient EADDRINUSE (socket not yet released); retry
        }
      }
      if (occupied && readTrim(path.join(workDir, 'agent.log')).includes('listener_error')) {
        await holder.close();
        holder = null;
        occupied = false;
        return;
      }
      await sleep(5);
    }
  })();

  const install2 = await runScript(SCRIPT_AGENT, env);
  await poller;
  if (holder) {
    try {
      await holder.close();
    } catch {
      // ignore
    }
  }

  assert.notEqual(install2.status, 0, `failed upgrade must exit nonzero:\n${install2.stderr}`);
  assert.equal(fs.readlinkSync(path.join(workDir, 'current')), release1, 'current must be restored to release1');
  const pid2 = readTrim(path.join(workDir, 'agent.pid'));
  assert.ok(pid2.length > 0 && pid2 !== pid1, 'rollback must start a fresh process');
  assert.equal(readTrim(path.join(workDir, 'agent.ready')), pid2, 'restored agent must be ready');
  assert.ok(isRunning(pid2), 'restored agent must be running');
  assert.ok(!isRunning(pid1), 'candidate process must be gone');

  const releases = fs.readdirSync(path.join(workDir, 'releases'));
  assert.equal(releases.length, 1, `failed release must be removed: ${releases.join(', ')}`);
  const logs = fs.readdirSync(path.join(workDir, 'logs'));
  const failed = logs.filter((f) => f.startsWith('agent.failed.'));
  assert.equal(failed.length, 1, `exactly one failed candidate log: ${logs.join(', ')}`);
  assert.ok(
    fs.readFileSync(path.join(workDir, 'logs', failed[0]), 'utf8').includes('listener_error'),
    'failed candidate log must record the listener bind error',
  );
});
