import http from 'http';
import { PORT, TUNNEL_PATH, SERVER_HOST, INSTALL_UUID, WS_MAX_PAYLOAD, validateConfig } from './config.js';
import { verifyBasicAuth } from './utils.js';
import { WebSocketServer } from 'ws';
import { StreamManager } from './StreamManager.js';
import { ClientManager } from './ClientManager.js';
import { HttpRouter } from './HttpRouter.js';
import { TcpRouter } from './TcpRouter.js';
import { logStandard, logVerbose } from './logger.js';

export class TunnelServer {
  constructor() {
    this.streamManager = new StreamManager();
    this.clientManager = new ClientManager(this.streamManager);
    this.httpRouter = new HttpRouter(this.streamManager, this.clientManager);
    this.tcpRouter = new TcpRouter(this.streamManager, this.clientManager);

    this._server = null;
    this._wss = null;
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
        address: '0.0.0.0',
        port: PORT,
        tunnelPath: TUNNEL_PATH,
        healthCheck: '/__health',
        installUuid: INSTALL_UUID,
        installUrl: `${SERVER_HOST}/${INSTALL_UUID}-install`,
      });
    });

    this.tcpRouter.start();
    this._setupProcessHandlers();
  }

  _setupProcessHandlers() {
    process.on('SIGTERM', async () => {
      console.log('[server] SIGTERM received, shutting down...');

      this.clientManager.stopHeartbeat();

      try {
        await this.tcpRouter.close();
      } catch {
        // ignore
      }

      try {
        this._wss.close();
      } catch {
        // ignore
      }

      this._server.close(() => {
        process.exit(0);
      });

      setTimeout(() => process.exit(0), 5000).unref();
    });

    process.on('uncaughtException', (err) => {
      console.error('[server] uncaughtException:', err);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[server] unhandledRejection:', reason);
    });
  }
}
