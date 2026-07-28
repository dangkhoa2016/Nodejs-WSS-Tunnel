import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { FrameCodec, PROTO } from '../src/protocol.js';
import { canConnect } from './helpers/tcp-test-setup.js';

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

function wsConnectUpgrade(url, authHeader, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    };
    if (authHeader) headers.Authorization = authHeader;
    Object.assign(headers, extraHeaders);

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function waitForListening(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
    const onData = (data) => {
      if (data.toString().includes('[ws] startup')) {
        clearTimeout(timeout);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with code ${code}`));
    });
  });
}

function spawnServer(port, envOverrides) {
  return spawn('node', ['src/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      TUNNEL_USERNAME: 'admin',
      TUNNEL_PASSWORD: 'secret',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function open(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function makeCollector(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let frame;
    try {
      frame = FrameCodec.parseFrame(data);
    } catch {
      return;
    }
    let consumed = false;
    for (const w of waiters) {
      if (!w.done && w.pred(frame)) {
        w.done = true;
        clearTimeout(w.timer);
        w.resolve(frame);
        consumed = true;
        break;
      }
    }
    if (!consumed) queue.push(frame);
  });
  return {
    queue,
    waitFor(type, streamId = null, timeout = 5000) {
      const pred = (f) => f.type === type && (streamId === null || f.streamId === streamId);
      const idx = queue.findIndex(pred);
      if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          done: false,
          resolve,
          timer: setTimeout(() => {
            w.done = true;
            reject(new Error(`timeout waiting for frame type=${type} streamId=${streamId}`));
          }, timeout),
        };
        waiters.push(w);
      });
    },
    waitForData(streamId, needle, timeout = 5000) {
      const buf = [];
      const check = (frame) => {
        if (frame.type !== PROTO.TYPE.TCP_DATA || frame.streamId !== streamId) return false;
        buf.push(frame.payload);
        return Buffer.concat(buf).includes(Buffer.from(needle));
      };
      const idx = queue.findIndex(check);
      if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = {
          pred: (frame) => check(frame),
          done: false,
          resolve,
          timer: setTimeout(() => {
            w.done = true;
            reject(new Error(`timeout waiting for data containing ${JSON.stringify(needle)} on stream ${streamId}`));
          }, timeout),
        };
        waiters.push(w);
      });
    },
  };
}

const TCP_HANDLER_DEFAULTS = {
  MAX_CONCURRENT_STREAMS: 200,
  TCP_TUNNEL_HOST: '127.0.0.1',
  TCP_CLIENT_ALLOWED_HOSTS: ['127.0.0.1'],
  TCP_CONNECT_TIMEOUT_MS: 5000,
  WS_HIGH_WATER: 1024 * 1024,
  WS_LOW_WATER: 512 * 1024,
};

describe('TCP agent over WebSocket (e2e)', () => {
  let serverProc;
  let serverPort;
  let disabledProc;
  let disabledPort;
  let originProc;
  let originPort;
  let tlsProc;
  let tlsPort;
  let agentCredsProc;
  let agentCredsPort;

  before(async () => {
    serverPort = await findFreePort();
    serverProc = spawnServer(serverPort, { TCP_AGENT_ALLOWED_PORTS: '6379' });
    await waitForListening(serverProc);

    disabledPort = await findFreePort();
    disabledProc = spawnServer(disabledPort, { TCP_AGENT_ALLOWED_PORTS: '' });
    await waitForListening(disabledProc);

    originPort = await findFreePort();
    originProc = spawnServer(originPort, {
      TCP_AGENT_ALLOWED_PORTS: '6379',
      TCP_AGENT_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    await waitForListening(originProc);

    tlsPort = await findFreePort();
    tlsProc = spawnServer(tlsPort, {
      TCP_AGENT_ALLOWED_PORTS: '6379',
      TCP_AGENT_REQUIRE_TLS: 'true',
    });
    await waitForListening(tlsProc);

    agentCredsPort = await findFreePort();
    agentCredsProc = spawnServer(agentCredsPort, {
      TCP_AGENT_ALLOWED_PORTS: '6379',
      TCP_AGENT_USERNAME: 'agent',
      TCP_AGENT_PASSWORD: 'agentpass',
    });
    await waitForListening(agentCredsProc);
  });

  after(async () => {
    for (const proc of [serverProc, disabledProc, originProc, tlsProc, agentCredsProc]) {
      if (!proc) continue;
      proc.kill();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        proc.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  });

  it('/tcp upgrade rejects missing credentials with 401', async () => {
    const res = await wsConnectUpgrade(`http://localhost:${serverPort}/tcp`);
    assert.equal(res.status, 401);
  });

  it('/tcp upgrade rejects wrong password with 401', async () => {
    const res = await wsConnectUpgrade(`http://localhost:${serverPort}/tcp`, basicAuth('admin', 'wrong'));
    assert.equal(res.status, 401);
  });

  it('/tcp plain GET returns 404', async () => {
    const res = await httpGet(`http://localhost:${serverPort}/tcp`);
    assert.equal(res.status, 404);
  });

  it('disabled endpoint rejects upgrade with 501', async () => {
    const res = await wsConnectUpgrade(`http://localhost:${disabledPort}/tcp`, basicAuth('admin', 'secret'));
    assert.equal(res.status, 501);
  });

  it('disabled endpoint plain GET returns 404', async () => {
    const res = await httpGet(`http://localhost:${disabledPort}/tcp`);
    assert.equal(res.status, 404);
  });

  it('relays Redis PING/PONG through the agent path', { timeout: 20000 }, async (t) => {
    if (!(await canConnect('127.0.0.1', 6379))) {
      if (process.env.REQUIRE_TCP_SERVICES === '1') throw new Error('Redis service required');
      t.skip('Redis not available');
      return;
    }

    const { createTcpClientHandler } = await import('../src/TcpClientHandler.js');

    const tunnelWs = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel`, {
      headers: { Authorization: basicAuth('admin', 'secret') },
    });
    tunnelWs.binaryType = 'nodebuffer';
    await open(tunnelWs);

    const clientStreams = new Map();
    const tcpHandler = createTcpClientHandler({
      ...TCP_HANDLER_DEFAULTS,
      streams: clientStreams,
      sendFrame: (ws, frame) => {
        if (ws.readyState === 1) ws.send(frame, { binary: true });
        return true;
      },
      sendJsonFrame: (ws, type, streamId, obj) => {
        if (ws.readyState === 1) {
          ws.send(FrameCodec.buildFrame(type, streamId, Buffer.from(JSON.stringify(obj))), { binary: true });
        }
        return true;
      },
      buildFrame: FrameCodec.buildFrame,
      parseJsonPayload: (p) => JSON.parse(p.toString('utf8')),
      resetIdleTimer: () => {},
      cleanupStream: () => {},
    });

    tunnelWs.on('message', (data, isBinary) => {
      if (!isBinary) return;
      let frame;
      try {
        frame = FrameCodec.parseFrame(data);
      } catch {
        return;
      }
      tcpHandler.handleServerFrame(
        frame.type,
        tunnelWs,
        frame.streamId,
        frame.payload,
        clientStreams.get(frame.streamId),
      );
    });

    tunnelWs.on('close', () => tcpHandler.cleanupTcpStreams());

    const agentWs = new WebSocket(`ws://127.0.0.1:${serverPort}/tcp`, {
      headers: { Authorization: basicAuth('admin', 'secret') },
    });
    agentWs.binaryType = 'nodebuffer';
    await open(agentWs);

    const agentFrames = makeCollector(agentWs);

    agentWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CONNECT, 0, Buffer.from(JSON.stringify({ port: 6379 }))), {
      binary: true,
    });

    const ack = await agentFrames.waitFor(PROTO.TYPE.TCP_CONNECT_ACK);
    const streamId = ack.streamId;
    assert.equal(JSON.parse(ack.payload.toString()).port, 6379);

    agentWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_DATA, streamId, Buffer.from('*1\r\n$4\r\nPING\r\n')), {
      binary: true,
    });

    const reply = await agentFrames.waitForData(streamId, 'PONG');
    assert.ok(Buffer.concat([reply.payload]).toString().includes('PONG'));

    tunnelWs.terminate();
    agentWs.terminate();
  });

  it('falls back to tunnel credentials for /tcp when agent creds are unset', async () => {
    const res = await wsConnectUpgrade(`http://localhost:${serverPort}/tcp`, basicAuth('admin', 'secret'));
    assert.equal(res.status, 101);
  });

  it('uses dedicated agent credentials when configured', async () => {
    const bad = await wsConnectUpgrade(`http://localhost:${agentCredsPort}/tcp`, basicAuth('admin', 'secret'));
    assert.equal(bad.status, 401);

    const good = await wsConnectUpgrade(`http://localhost:${agentCredsPort}/tcp`, basicAuth('agent', 'agentpass'));
    assert.equal(good.status, 101);

    const tunnelWithAgentCreds = await wsConnectUpgrade(
      `http://localhost:${agentCredsPort}/tunnel`,
      basicAuth('agent', 'agentpass'),
    );
    assert.equal(tunnelWithAgentCreds.status, 401);

    const tunnelWithTunnelCreds = await wsConnectUpgrade(
      `http://localhost:${agentCredsPort}/tunnel`,
      basicAuth('admin', 'secret'),
    );
    assert.equal(tunnelWithTunnelCreds.status, 101);
  });

  it('rejects agent upgrades with a disallowed Origin', async () => {
    const rejected = await wsConnectUpgrade(`http://localhost:${originPort}/tcp`, basicAuth('admin', 'secret'), {
      Origin: 'https://evil.example.com',
    });
    assert.equal(rejected.status, 403);

    const allowed = await wsConnectUpgrade(`http://localhost:${originPort}/tcp`, basicAuth('admin', 'secret'), {
      Origin: 'https://app.example.com',
    });
    assert.equal(allowed.status, 101);

    const noOrigin = await wsConnectUpgrade(`http://localhost:${originPort}/tcp`, basicAuth('admin', 'secret'));
    assert.equal(noOrigin.status, 101);
  });

  it('enforces TLS when TCP_AGENT_REQUIRE_TLS is set', async () => {
    const plain = await wsConnectUpgrade(`http://localhost:${tlsPort}/tcp`, basicAuth('admin', 'secret'));
    assert.equal(plain.status, 426);

    const forwarded = await wsConnectUpgrade(`http://localhost:${tlsPort}/tcp`, basicAuth('admin', 'secret'), {
      'X-Forwarded-Proto': 'https',
    });
    assert.equal(forwarded.status, 101);

    const onPlainServer = await wsConnectUpgrade(`http://localhost:${serverPort}/tcp`, basicAuth('admin', 'secret'));
    assert.equal(onPlainServer.status, 101);
  });
});
