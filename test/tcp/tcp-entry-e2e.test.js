import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { describe, it } from 'node:test';

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

function createEchoServerOn(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

function waitExit(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', resolve);
  });
}

function waitForLine(proc, needle, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${needle}" in process output`)), timeoutMs);
    const onData = (buf) => {
      if (buf.toString().includes(needle)) {
        clearTimeout(timer);
        proc.stdout.removeListener('data', onData);
        proc.stderr.removeListener('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
}

function echoOnce(port, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`echo timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString().includes(marker)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(chunks).toString());
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(marker);
  });
}

const SKIP_CODES = new Set(['EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'ENODEV', 'EAFNOSUPPORT']);

describe('TCP entry round-trip through real processes', () => {
  it('echoes bytes from the agent listener to the service behind the tunnel client', { timeout: 30000 }, async (t) => {
    let echo;
    try {
      echo = await createEchoServerOn('127.0.0.2');
    } catch (err) {
      if (SKIP_CODES.has(err.code)) {
        t.skip(`127.0.0.2 loopback alias unavailable (${err.code})`);
        return;
      }
      throw err;
    }
    const echoPort = echo.address().port;
    const serverPort = await findFreePort();

    const baseEnv = {
      ...process.env,
      LOG_FORMAT: 'text',
    };

    const server = spawn(process.execPath, ['src/index.js'], {
      env: {
        ...baseEnv,
        NODE_ENV: 'test',
        PORT: String(serverPort),
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        TCP_AGENT_ALLOWED_PORTS: String(echoPort),
        TCP_TUNNEL_HOST: '127.0.0.2',
        TCP_CLIENT_ALLOWED_HOSTS: '127.0.0.2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const client = spawn(process.execPath, ['serve/client.js'], {
      env: {
        ...baseEnv,
        TUNNEL_SERVER_URL: `ws://127.0.0.1:${serverPort}/tunnel`,
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        TARGET_ORIGIN: 'http://127.0.0.1:8000',
        TCP_TUNNEL_HOST: '127.0.0.2',
        TCP_CLIENT_ALLOWED_HOSTS: '127.0.0.2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const agent = spawn(process.execPath, ['serve/tcp-agent.js'], {
      env: {
        ...baseEnv,
        TUNNEL_SERVER_URL: `ws://127.0.0.1:${serverPort}/tcp`,
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        AGENT_PORTS: String(echoPort),
        AGENT_BIND_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    t.after(async () => {
      for (const proc of [agent, client, server]) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      }
      await Promise.all([agent, client, server].map(waitExit));
      await new Promise((resolve) => echo.close(resolve));
    });

    await waitForLine(server, '[ws] startup');
    await waitForLine(client, '[client] connected');
    await waitForLine(agent, '[agent] connected');

    const marker = `echo-${Date.now()}`;
    const echoed = await echoOnce(echoPort, marker, 8000);

    assert.equal(echoed, marker);
  });
});
