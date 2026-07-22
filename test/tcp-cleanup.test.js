import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROTO, FrameCodec, sleep, setupTcpPair } from './helpers/tcp-test-setup.js';

describe('WS disconnect cleanup', () => {
  it('cleanupTcpStreams destroys all TCP streams', { timeout: 10000 }, async () => {
    const { serverWs, cleanup, streams, tcpHandler } = await setupTcpPair({ port: 25420 });

    try {
      for (let i = 0; i < 3; i++) {
        serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN, 50 + i, Buffer.from(JSON.stringify({ host: '127.0.0.1', port: 6379 }))));
      }
      await sleep(500);

      assert.ok(streams.size > 0, 'should have TCP streams after TCP_OPEN');

      tcpHandler.cleanupTcpStreams();

      assert.equal(streams.size, 0, 'all TCP streams should be cleaned up');
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });

  it('TCP streams cleaned up on rapid open/close', { timeout: 10000 }, async () => {
    const { serverWs, cleanup, streams, tcpHandler } = await setupTcpPair({ port: 25421 });

    try {
      for (let i = 0; i < 20; i++) {
        const id = 60 + i;
        serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_OPEN, id, Buffer.from(JSON.stringify({ host: '127.0.0.1', port: 6379 }))));
        await sleep(10);
        serverWs.send(FrameCodec.buildFrame(PROTO.TYPE.TCP_CLOSE, id));
      }
      await sleep(1000);

      tcpHandler.cleanupTcpStreams();

      assert.equal(streams.size, 0, 'all TCP streams should be cleaned up');
    } finally {
      for (const fn of cleanup.reverse()) fn();
    }
  });
});
