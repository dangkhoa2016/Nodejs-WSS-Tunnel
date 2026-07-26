import http from 'node:http';
import { WebSocketServer } from 'ws';
import { ClientManager } from './ClientManager.js';
import { HttpRouter } from './HttpRouter.js';
import { StreamManager } from './StreamManager.js';
import { TcpRouter } from './TcpRouter.js';
import { INSTALL_UUID, PORT, SERVER_HOST, TUNNEL_PATH, WS_MAX_PAYLOAD, validateConfig } from './config.js';
import { logStandard, logVerbose } from './logger.js';

const GRACEFUL_TIMEOUT_MS = 10_000;

function closeWithCallback(component) {
  if (!component) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      component.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    } catch (error) {
      if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    }
  });
}

export class TunnelServer {
  constructor() {
    this.streamManager = new StreamManager();
    this.clientManager = new ClientManager(this.streamManager);
    this.httpRouter = new HttpRouter(this.streamManager, this.clientManager);
    this.tcpRouter = new TcpRouter(this.streamManager, this.clientManager);

    this._server = null;
    this._wss = null;
    this._shuttingDown = false;
    this._closePromise = null;
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._shuttingDown = true;
    this._closePromise = this._closeComponents();
    return this._closePromise;
  }

  async _closeComponents() {
    const results = await Promise.allSettled([
      this.tcpRouter.close(),
      this.clientManager.close(),
      closeWithCallback(this._server),
      closeWithCallback(this._wss),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[server] shutdown error (isolated):', r.reason);
      }
    }
  }

  start() {
    validateConfig();

    this._server = http.createServer((req, res) => {
      try {
        this.httpRouter.handleRequest(req, res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }

        try {
          res.end('Internal tunnel error');
        } catch {
          // ignore
        }
      }
    });

    this._server.on('checkContinue', (req, res) => {
      try {
        res.writeContinue();
        this.httpRouter.handleRequest(req, res);
      } catch {
        try {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        } catch {
          // ignore
        }
      }
    });

    this._server.on('clientError', (err, socket) => {
      try {
        if (socket.writable) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
      } catch {
        // ignore
      }
    });

    this._server.on('connect', (req, socket) => {
      try {
        if (socket.writable) {
          socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
        }
      } catch {
        // ignore
      }
    });

    try {
      this._server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 0);
    } catch {
      // ignore on older Node versions
    }

    this._server.headersTimeout = 65000;
    this._server.keepAliveTimeout = 65000;

    this._wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: WS_MAX_PAYLOAD,
      perMessageDeflate: false,
    });

    this._server.on('upgrade', (req, socket, head) => {
      logVerbose('ws', 'upgrade', {
        url: req.url,
        remoteAddr: req.socket?.remoteAddress,
      });
      this.httpRouter.handleUpgrade(req, socket, head, this._wss);
    });

    this._wss.on('connection', (ws, req) => {
      logVerbose('ws', 'connect', {
        remoteAddr: req?.socket?.remoteAddress,
        clientCount: this.clientManager.clients.size + 1,
      });
      this.clientManager.addClient(ws);
    });

    this.clientManager.startHeartbeat();

    this._server.listen(PORT, '0.0.0.0', () => {
      logStandard('ws', 'startup', {
        port: PORT,
        tunnelPath: TUNNEL_PATH,
        healthCheck: '/__health',
        installUuid: INSTALL_UUID,
      });
      console.log(`[server] HTTP + WebSocket tunnel listening on 0.0.0.0:${PORT}`);
      console.log(`[server] Tunnel path: ${TUNNEL_PATH}`);
      console.log('[server] Health check: /__health');
      console.log(`[server] Install UUID: ${INSTALL_UUID}`);
      console.log(`[server] Install URL: ${SERVER_HOST}/${INSTALL_UUID}-install`);
    });

    this.tcpRouter.start();
    this._setupProcessHandlers();
  }

  _setupProcessHandlers() {
    const shutdown = async (signal) => {
      if (this._shuttingDown) return;
      if (signal) {
        logStandard('shutdown', 'signal', { signal });
      }

      const timer = setTimeout(() => {
        process.exit(1);
      }, GRACEFUL_TIMEOUT_MS).unref();

      await this.close();

      clearTimeout(timer);
      process.exit(signal === 'uncaughtException' ? 1 : 0);
    };

    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => shutdown(sig));
    }

    process.on('uncaughtException', (err) => {
      console.error('[server] uncaughtException:', err);
      this._server?.close();
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[server] unhandledRejection:', reason);
    });
  }
}
