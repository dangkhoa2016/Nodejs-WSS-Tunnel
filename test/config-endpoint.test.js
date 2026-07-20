import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

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

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function signUrl(basePath, secret, expiresInSec = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const payload = `${basePath}|${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { expires, sig };
}

describe('Config endpoint integration tests', () => {
  let serverProc;
  let serverPort;
  let serverUuid;
  let onServerData;
  const ADMIN_SECRET = 'test-admin-secret-123';

  const baseUrl = () => `http://localhost:${serverPort}`;
  const configPath = () => `/${serverUuid}-config`;

  function signedConfigUrl(secret = ADMIN_SECRET, expiresInSec = 3600) {
    const { expires, sig } = signUrl(configPath(), secret, expiresInSec);
    return `${baseUrl()}${configPath()}?expires=${expires}&sig=${sig}`;
  }

  before(async () => {
    serverPort = await findFreePort();

    serverProc = spawn('node', ['src/index.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(serverPort),
        TUNNEL_USERNAME: 'admin',
        TUNNEL_PASSWORD: 'secret',
        ADMIN_SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        reject(new Error(`Server start timeout. Output so far:\n${output}`));
      }, 15000);

      onServerData = (data) => {
        output += data.toString();
        const uuidMatch = output.match(/Install UUID: ([\w-]+)/);
        if (uuidMatch) {
          serverUuid = uuidMatch[1];
          clearTimeout(timeout);
          resolve();
        }
      };

      serverProc.stdout.on('data', onServerData);
      serverProc.stderr.on('data', onServerData);
      serverProc.on('exit', (code) => {
        if (!serverUuid) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}. Output so far:\n${output}`));
        }
      });
    });
  });

  after(async () => {
    if (serverProc) {
      serverProc.stdout.off('data', onServerData);
      serverProc.stderr.off('data', onServerData);
      serverProc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        serverProc.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  });

  describe('Config endpoint - auth', () => {
    it('returns 404 when no signed URL is provided', async () => {
      const res = await fetch(`${baseUrl()}${configPath()}`);
      assert.equal(res.status, 404);
      assert.equal(res.body, 'Not found');
    });

    it('returns 404 with wrong secret', async () => {
      const url = signedConfigUrl('wrong-secret');
      const res = await fetch(url);
      assert.equal(res.status, 404);
    });

    it('returns 404 with expired signature', async () => {
      const { expires, sig } = signUrl(configPath(), ADMIN_SECRET, -100);
      const url = `${baseUrl()}${configPath()}?expires=${expires}&sig=${sig}`;
      const res = await fetch(url);
      assert.equal(res.status, 404);
    });

    it('returns 404 with tampered signature', async () => {
      const { expires, sig } = signUrl(configPath(), ADMIN_SECRET, 3600);
      const tampered = `${sig.slice(0, -2)}ff`;
      const url = `${baseUrl()}${configPath()}?expires=${expires}&sig=${tampered}`;
      const res = await fetch(url);
      assert.equal(res.status, 404);
    });

    it('returns 404 with missing sig param', async () => {
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const url = `${baseUrl()}${configPath()}?expires=${expires}`;
      const res = await fetch(url);
      assert.equal(res.status, 404);
    });

    it('returns 404 with missing expires param', async () => {
      const url = `${baseUrl()}${configPath()}?sig=abc123`;
      const res = await fetch(url);
      assert.equal(res.status, 404);
    });
  });

  describe('Config endpoint - GET', () => {
    it('returns current config state', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const body = res.json();
      assert.equal(typeof body.verbose, 'boolean');
      assert.equal(typeof body.logFormat, 'string');
      assert.ok(['json', 'text'].includes(body.logFormat));
    });
  });

  describe('Config endpoint - POST', () => {
    it('enables verbose logging', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: true }),
      });
      assert.equal(res.status, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.verbose, true);
    });

    it('disables verbose logging', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: false }),
      });
      assert.equal(res.status, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.verbose, false);
    });

    it('changes logFormat to json', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: false, logFormat: 'json' }),
      });
      assert.equal(res.status, 200);
      const body = res.json();
      assert.equal(body.logFormat, 'json');

      // Reset back to text
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: false, logFormat: 'text' }),
      });
    });

    it('rejects invalid JSON body', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      assert.equal(res.status, 400);
      const body = res.json();
      assert.equal(body.error, 'invalid_json');
    });

    it('rejects missing verbose field', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const body = res.json();
      assert.equal(body.error, 'invalid_verbose');
    });

    it('rejects non-boolean verbose', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: 'yes' }),
      });
      assert.equal(res.status, 400);
      const body = res.json();
      assert.equal(body.error, 'invalid_verbose');
    });

    it('rejects invalid logFormat', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: true, logFormat: 'xml' }),
      });
      assert.equal(res.status, 400);
      const body = res.json();
      assert.equal(body.error, 'invalid_logFormat');
    });

    it('accepts verbose without logFormat (partial update)', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: true }),
      });
      assert.equal(res.status, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.verbose, true);
      assert.ok(['json', 'text'].includes(body.logFormat));

      // Reset
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbose: false }),
      });
    });
  });

  describe('Config endpoint - method not allowed', () => {
    it('returns 405 for PUT', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, { method: 'PUT' });
      assert.equal(res.status, 405);
    });

    it('returns 405 for DELETE', async () => {
      const url = signedConfigUrl();
      const res = await fetch(url, { method: 'DELETE' });
      assert.equal(res.status, 405);
    });
  });

  describe('Health check still works', () => {
    it('returns 200 ok', async () => {
      const res = await fetch(`${baseUrl()}/__health`);
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ok');
    });

    it('returns 200 ok for /healthz', async () => {
      const res = await fetch(`${baseUrl()}/healthz`);
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ok');
    });
  });
});
