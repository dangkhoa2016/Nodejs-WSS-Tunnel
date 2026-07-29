import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { after, test } from 'node:test';

const PORT = 17890;
const DISABLED_PORT = 17891;
const INSTALL_UUID = 'test-id';
let server;
let disabledServer;

function startServer(port, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(port),
        INSTALL_UUID,
        SERVER_HOST: `http://127.0.0.1:${port}`,
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        TUNNEL_PATH: '/tunnel',
        ADMIN_SECRET: '',
        NODE_ENV: 'test',
        ...envOverrides,
      },
    });

    if (port === PORT) {
      server = proc;
    } else {
      disabledServer = proc;
    }

    let output = '';
    proc.stdout.on('data', (d) => {
      output += d.toString();
    });
    proc.stderr.on('data', (d) => {
      output += d.toString();
    });

    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);

    const check = () => {
      if (output.includes('[ws] startup')) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('artifact routes', async (t) => {
  await startServer(PORT, { TCP_AGENT_ALLOWED_PORTS: '6379' });
  await startServer(DISABLED_PORT, { TCP_AGENT_ALLOWED_PORTS: '' });

  t.after(() => {
    try {
      server?.kill();
      disabledServer?.kill();
      server?.unref();
      disabledServer?.unref();
    } catch {}
  });

  const installRes = await get(PORT, `/${INSTALL_UUID}-install`);
  assert.equal(installRes.status, 200);
  assert.ok(installRes.body.includes(INSTALL_UUID), 'install script must embed INSTALL_UUID');
  assert.ok(!installRes.body.includes('{{INSTALL_UUID}}'), 'install script must not contain placeholder');

  const bundleRes = await get(PORT, `/${INSTALL_UUID}-client.js`);
  assert.equal(bundleRes.status, 200);

  const pkgRes = await get(PORT, `/${INSTALL_UUID}-client-package.json`);
  assert.equal(pkgRes.status, 200);
  assert.equal(JSON.parse(pkgRes.body).name, 'tunnel-client');

  const agentRes = await get(PORT, `/${INSTALL_UUID}-tcp-agent.js`);
  assert.equal(agentRes.status, 200);

  const agentPkgRes = await get(PORT, `/${INSTALL_UUID}-tcp-agent-package.json`);
  assert.equal(agentPkgRes.status, 200);
  assert.equal(JSON.parse(agentPkgRes.body).name, 'tunnel-tcp-agent');

  const disabledAgentRes = await get(DISABLED_PORT, `/${INSTALL_UUID}-tcp-agent.js`);
  assert.equal(disabledAgentRes.status, 404);

  const disabledAgentPkgRes = await get(DISABLED_PORT, `/${INSTALL_UUID}-tcp-agent-package.json`);
  assert.equal(disabledAgentPkgRes.status, 404);

  // Old short paths must no longer serve artifacts; they fall through to the
  // tunnel proxy, which returns 503 when no client is connected.
  for (const oldPath of ['/client.js', '/client-package.json', '/tcp-agent.js', '/tcp-agent-package.json']) {
    const oldRes = await get(PORT, oldPath);
    assert.equal(oldRes.status, 503, `old path ${oldPath} must no longer be served`);
  }
});
