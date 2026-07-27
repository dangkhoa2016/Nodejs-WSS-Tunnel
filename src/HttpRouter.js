import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ADMIN_SECRET, INSTALL_UUID, MAX_CONCURRENT_STREAMS, SERVER_HOST, TUNNEL_PATH } from './config.js';
import { getConfig, logStandard, logVerbose, setConfig } from './logger.js';
import { FrameCodec, PROTO } from './protocol.js';
import { sanitizeHeaders, validateHmacSignature, verifyBasicAuth } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

export class HttpRouter {
  constructor(streamManager, clientManager) {
    this.streamManager = streamManager;
    this.clientManager = clientManager;
  }

  _validateAdmin(req, pathname) {
    if (!ADMIN_SECRET) {
      return false;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }

    const expires = url.searchParams.get('expires');
    const sig = url.searchParams.get('sig');

    return validateHmacSignature(pathname, ADMIN_SECRET, expires, sig);
  }

  _handleConfigRequest(req, res) {
    const pathname = `/${INSTALL_UUID}-config`;

    if (!this._validateAdmin(req, pathname)) {
      logStandard('auth', 'hmac_validate', { path: pathname, ok: false });
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    logStandard('auth', 'hmac_validate', { path: pathname, ok: true });

    if (req.method === 'GET') {
      const state = getConfig();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    const maxLen = 1024;

    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > maxLen) {
        req.destroy();
      }
    });

    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
        return;
      }

      if (typeof parsed.verbose !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid_verbose', message: '"verbose" must be a boolean' }));
        return;
      }

      if (parsed.logFormat !== undefined && !['json', 'text'].includes(parsed.logFormat)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid_logFormat', message: '"logFormat" must be "json" or "text"' }));
        return;
      }

      setConfig({ verbose: parsed.verbose, logFormat: parsed.logFormat });

      const newState = getConfig();
      logStandard('auth', 'config_update', { verbose: newState.verbose, logFormat: newState.logFormat });

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, ...newState }));
    });
  }

  handleRequest(req, res) {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/__health' || pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (pathname === '/' && req.method === 'GET') {
      if (!this.clientManager.getActiveClient()) {
        res.writeHead(302, { Location: '/__info' });
        res.end();
        return;
      }
    }

    if (pathname === '/__info' && req.method === 'GET') {
      this._serveLandingPage(res);
      return;
    }

    if (pathname === `/${INSTALL_UUID}-install`) {
      this._serveFile(res, path.join(PROJECT_ROOT, 'serve', 'setup.sh'), 'application/x-sh');
      return;
    }

    if (pathname === `/${INSTALL_UUID}-config`) {
      this._handleConfigRequest(req, res);
      return;
    }

    if (pathname === '/client.js') {
      this._serveFile(res, path.join(PROJECT_ROOT, 'dist', 'client.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/client-package.json') {
      this._serveFile(res, path.join(PROJECT_ROOT, 'serve', 'client-package.json'), 'application/json; charset=utf-8');
      return;
    }

    if (pathname === TUNNEL_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    this._proxyHttpRequest(req, res);
  }

  _serveFile(res, filePath, contentType) {
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(content);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  _serveLandingPage(res) {
    try {
      const htmlPath = path.join(PROJECT_ROOT, 'public', 'index.html');
      let html = fs.readFileSync(htmlPath, 'utf8');

      html = html.replaceAll('{{INSTALL_URL}}', `${SERVER_HOST}/${INSTALL_UUID}-install`);
      html = html.replaceAll('{{CONFIG_URL}}', `/${INSTALL_UUID}-config`);
      html = html.replaceAll('{{TUNNEL_PATH}}', TUNNEL_PATH);
      html = html.replaceAll('{{SERVER_HOST}}', SERVER_HOST);

      const wssUrl = SERVER_HOST.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + TUNNEL_PATH;
      html = html.replaceAll('{{TUNNEL_WSS_URL}}', wssUrl);

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  handleUpgrade(req, socket, head, wss) {
    let pathname;
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      pathname = parsedUrl.pathname;
    } catch {
      pathname = req.url.split('?')[0];
    }

    if (pathname !== TUNNEL_PATH) {
      try {
        socket.write('HTTP/1.1 501 Not Implemented\r\n' + 'Connection: close\r\n' + '\r\n');
      } catch {
        // ignore
      }

      socket.destroy();
      return;
    }

    if (!verifyBasicAuth(req)) {
      logStandard('auth', 'ws_reject', { pathname, reason: 'invalid_credentials' });
      try {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'WWW-Authenticate: Basic realm="tunnel"\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n',
        );
      } catch {
        // ignore
      }
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  _proxyHttpRequest(req, res) {
    if (req.headers.upgrade) {
      res.writeHead(501, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Upgrade is not supported by this tunnel');
      return;
    }

    logVerbose('http', 'request', {
      method: req.method,
      url: req.url,
      remoteAddr: req.socket?.remoteAddress,
      streamCount: this.streamManager.size,
    });

    if (this.streamManager.size >= MAX_CONCURRENT_STREAMS) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too many concurrent streams');
      return;
    }

    const ws = this.clientManager.getActiveClient();

    if (!ws) {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'tunnel_unavailable',
          message: 'No tunnel client connected',
        }),
      );
      return;
    }

    let streamId;

    try {
      streamId = this.streamManager.allocateStreamId();
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No available stream id');
      return;
    }

    const headers = sanitizeHeaders(req.headers, { removeHost: true });

    if (req.headers.host) {
      headers['x-forwarded-host'] = req.headers.host;
    }

    if (req.socket.remoteAddress) {
      const xff = req.socket.remoteAddress;

      if (headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = Array.isArray(headers['x-forwarded-for'])
          ? [...headers['x-forwarded-for'], xff]
          : `${headers['x-forwarded-for']}, ${xff}`;
      } else {
        headers['x-forwarded-for'] = xff;
      }
    }

    if (!headers['x-forwarded-proto']) {
      headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    }

    logVerbose('proxy', 'forward', {
      streamId,
      method: req.method,
      url: req.url,
      xForwardedFor: headers['x-forwarded-for'],
      xForwardedHost: headers['x-forwarded-host'],
      xForwardedProto: headers['x-forwarded-proto'],
    });

    const meta = {
      method: req.method,
      url: req.url,
      headers,
    };

    const state = this.streamManager.createStream({ ws, req, res, meta, streamId });

    if (!state) return;

    pipeline(req, state.requestWriter, (err) => {
      if (err && !state.cleaned) {
        this.streamManager.abortStream(state, 'Request stream error', true);
      }
    });

    req.on('error', () => {
      logVerbose('stream', 'abort', { streamId, reason: 'Incoming request error' });
      this.streamManager.abortStream(state, 'Incoming request error', true);
    });

    res.on('close', () => {
      if (!state.cleaned && !state.responseEnded) {
        logVerbose('stream', 'abort', { streamId, reason: 'End user closed connection early' });
        this.streamManager.abortStream(state, 'End user closed connection early', true);
      }
    });

    res.on('finish', () => {
      state.responseEnded = true;
      logVerbose('http', 'response', {
        streamId: state.id,
        method: state.meta.method,
        url: state.meta.url,
      });
      this.streamManager.cleanupStream(state);
    });
  }
}
