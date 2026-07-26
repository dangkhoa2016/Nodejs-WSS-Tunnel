import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { test, after } from 'node:test';

const PORT = 17890;
const INSTALL_UUID = 'test-id';
let server;

function buildFixture() {
  execFileSync(process.execPath, ['serve/build.js'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['src/index.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(PORT),
        INSTALL_UUID,
        SERVER_HOST: `http://127.0.0.1:${PORT}`,
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        TUNNEL_PATH: '/tunnel',
        ADMIN_SECRET: '',
        NODE_ENV: 'test',
      },
    });

    let output = '';
    server.stdout.on('data', (d) => { output += d.toString(); });
    server.stderr.on('data', (d) => { output += d.toString(); });

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

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('artifact routes', async (t) => {
  buildFixture();

  await startServer();

  t.after(() => {
    try {
      server.kill();
      server.unref();
    } catch {}
  });

  const installRes = await get(`/${INSTALL_UUID}-install`);
  assert.equal(installRes.status, 200);

  const bundleRes = await get('/client.js');
  assert.equal(bundleRes.status, 200);

  const pkgRes = await get('/client-package.json');
  assert.equal(pkgRes.status, 200);
  assert.equal(JSON.parse(pkgRes.body).name, 'tunnel-client');
});
