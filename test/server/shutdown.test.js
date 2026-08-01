import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TunnelServer } from '../../src/server/TunnelServer.js';

test('close returns one shared promise', async () => {
  const server = new TunnelServer();
  const first = server.close();
  const second = server.close();
  assert.equal(first, second);
  return first;
});

test('close waits for the WebSocket server callback', async () => {
  const server = new TunnelServer();
  let finishWssClose;
  server._wss = {
    close(callback) {
      finishWssClose = callback;
    },
  };

  let settled = false;
  const closing = server.close().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finishWssClose();
  await closing;
  assert.equal(settled, true);
});

test('close waits for the HTTP server callback', async () => {
  const server = new TunnelServer();
  let finishHttpClose;
  server._server = {
    close(callback) {
      finishHttpClose = callback;
    },
  };

  let settled = false;
  const closing = server.close().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finishHttpClose();
  await closing;
  assert.equal(settled, true);
});

test('close waits for TCP server callbacks', async () => {
  const server = new TunnelServer();
  let finishTcpClose;
  server.tcpRouter._servers.set(6379, {
    close(callback) {
      finishTcpClose = callback;
    },
  });

  let settled = false;
  const closing = server.close().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finishTcpClose();
  await closing;
  assert.equal(settled, true);
});

test('close isolates component errors', async () => {
  const server = new TunnelServer();
  mock.method(server.tcpRouter, 'close', () => Promise.reject(new Error('tcp fail')));
  mock.method(server.clientManager, 'close', async () => {
    throw new Error('cm fail');
  });

  let threw = false;
  try {
    await server.close();
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'close must not throw despite component failures');
  assert.equal(server._shuttingDown, true);
});

test('close logs TCP listener failures', async () => {
  const server = new TunnelServer();

  const listenerError = new Error('listener close failed');
  const fakeServer = {
    close(callback) {
      callback(listenerError);
    },
  };
  server.tcpRouter._servers.set(6379, fakeServer);

  let httpClosed = false;
  server._server = {
    close(callback) {
      httpClosed = true;
      callback();
    },
  };
  let wssClosed = false;
  server._wss = {
    close(callback) {
      wssClosed = true;
      callback();
    },
  };

  const errorLogs = [];
  mock.method(console, 'error', (...args) => {
    errorLogs.push(args);
  });

  await server.close();

  assert.ok(
    errorLogs.some((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('[error] [shutdown] close_error') &&
          arg.includes('listener close failed'),
      ),
    ),
  );
  assert.equal(httpClosed, true);
  assert.equal(wssClosed, true);
});

test('close() without start does not throw', async () => {
  const server = new TunnelServer();
  await server.close();
  assert.ok(true);
});
