import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';

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

function wsConnectUpgrade(url, authHeader) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const key = Buffer.from(Math.random().toString(36)).toString('base64');
    const headers = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    };
    if (authHeader) headers.Authorization = authHeader;

    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, headers });

    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });

    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, upgrade: true });
    });

    req.on('error', reject);
    req.end();
  });
}

function wsOpen(url, authHeader) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (authHeader) headers.Authorization = authHeader;
    const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    ws.on('open', () => {
      ws.close();
      resolve(true);
    });
    ws.on('error', (err) => reject(err));
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
  });
}

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function captureLogs(proc) {
  const lines = [];
  const onData = (data) => {
    lines.push(data.toString());
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  return {
    lines,
    detach: () => {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
    },
  };
}

describe('WebSocket Basic Auth', () => {
  let serverProc;
  let serverPort;
  const TUNNEL_USER = 'admin';
  const TUNNEL_PASS = 'secret';

  const tunnelUrl = () => `http://localhost:${serverPort}/tunnel`;

  let onServerStdout;
  let onServerStderr;

  before(async () => {
    serverPort = await findFreePort();
    serverProc = spawn('node', ['src/index.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(serverPort),
        TUNNEL_USERNAME: TUNNEL_USER,
        TUNNEL_PASSWORD: TUNNEL_PASS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
      onServerStdout = (data) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      onServerStderr = (data) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      serverProc.stdout.on('data', onServerStdout);
      serverProc.stderr.on('data', onServerStderr);
      serverProc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      });
    });
  });

  after(async () => {
    if (serverProc) {
      serverProc.stdout.off('data', onServerStdout);
      serverProc.stderr.off('data', onServerStderr);
      serverProc.kill();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        serverProc.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  });

  it('rejects missing Authorization header with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl());
    assert.equal(res.status, 401);
  });

  it('rejects Bearer token with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl(), 'Bearer some-token');
    assert.equal(res.status, 401);
  });

  it('rejects invalid base64 in Basic with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl(), 'Basic not-base64!!!');
    assert.equal(res.status, 401);
  });

  it('rejects wrong username with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl(), basicAuth('wronguser', TUNNEL_PASS));
    assert.equal(res.status, 401);
  });

  it('rejects wrong password with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl(), basicAuth(TUNNEL_USER, 'wrongpass'));
    assert.equal(res.status, 401);
  });

  it('rejects empty username with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl(), basicAuth('', TUNNEL_PASS));
    assert.equal(res.status, 401);
  });

  it('rejects empty password with 401', async () => {
    const res = await wsConnectUpgrade(tunnelUrl(), basicAuth(TUNNEL_USER, ''));
    assert.equal(res.status, 401);
  });

  it('accepts valid credentials with WebSocket upgrade', async () => {
    const res = await wsOpen(tunnelUrl().replace('http://', 'ws://'), basicAuth(TUNNEL_USER, TUNNEL_PASS));
    assert.equal(res, true);
  });

  it('accepts password containing colon', async () => {
    const passWithColon = 'pass:word:123';
    const colonPort = await findFreePort();
    const customProc = spawn('node', ['src/index.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(colonPort),
        TUNNEL_USERNAME: 'user',
        TUNNEL_PASSWORD: passWithColon,
      },
      stdio: 'pipe',
    });

    try {
      await new Promise((r) => {
        const t = setTimeout(() => r(), 5000);
        customProc.stdout.on('data', (d) => {
          if (d.toString().includes('listening')) {
            clearTimeout(t);
            r();
          }
        });
        customProc.stderr.on('data', (d) => {
          if (d.toString().includes('listening')) {
            clearTimeout(t);
            r();
          }
        });
      });

      const res = await wsOpen(`ws://localhost:${colonPort}/tunnel`, basicAuth('user', passWithColon));
      assert.equal(res, true);
    } finally {
      customProc.kill();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        customProc.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  });

  it('does not include password in logs', async () => {
    const logs = captureLogs(serverProc);
    await wsConnectUpgrade(tunnelUrl(), basicAuth(TUNNEL_USER, TUNNEL_PASS));
    logs.detach();
    for (const line of logs.lines) {
      assert.equal(line.includes(TUNNEL_PASS), false, `Log contains password: ${line}`);
    }
  });

  it('non-tunnel path returns 501 without auth leak', async () => {
    const badUrl = `http://localhost:${serverPort}/other-path`;
    const res = await wsConnectUpgrade(badUrl);
    assert.equal(res.status, 501);
  });
});
