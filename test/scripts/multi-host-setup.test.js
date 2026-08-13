import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const scripts = [read('scripts/setup-service-host.sh'), read('scripts/setup-application-host.sh')];

test('both roles require one explicitly configured server identity', () => {
  for (const script of scripts) {
    assert.match(script, /SERVER_HOST="\$\{SERVER_HOST:-\}"/);
    assert.match(script, /INSTALL_UUID="\$\{INSTALL_UUID:-\}"/);
    assert.doesNotMatch(script, /\.app\.github\.dev/);
  }
});

test('credentials never fall back to published example secrets', () => {
  for (const script of scripts) {
    assert.doesNotMatch(script, /change_this_strong_password/);
    assert.doesNotMatch(script, /:-admin/);
  }
});

test('artifact downloads verify TLS and use the current ws range', () => {
  for (const script of scripts) {
    assert.doesNotMatch(script, /curl\s+-[A-Za-z]*k[A-Za-z]*/);
    assert.match(script, /"ws":"\^8\.21\.3"/);
  }
});

test('stale PID files cannot target arbitrary processes', () => {
  for (const script of scripts) {
    assert.match(script, /\[\[ "\$OLD_PID" =~ \^\[0-9\]\+\$ \]\]/);
    assert.match(script, /ps -p "\$OLD_PID" -o args=/);
  }
});

test('roles use the correct WebSocket paths and loopback binding', () => {
  assert.match(scripts[0], /TUNNEL_SERVER_URL="wss:\/\/\$SERVER_HOST\/tunnel"/);
  assert.match(scripts[1], /TUNNEL_SERVER_URL="wss:\/\/\$SERVER_HOST\/tcp"/);
  assert.match(scripts[1], /AGENT_BIND_HOST="\$\{AGENT_BIND_HOST:-127\.0\.0\.1\}"/);
});

test('readiness and authentication detection supports text and JSON logs', () => {
  assert.match(scripts[0], /"cat":"client","evt":"connected"/);
  assert.match(scripts[0], /"cat":"client","evt":"auth_failed"/);
  assert.match(scripts[1], /"cat":"agent","evt":"connected"/);
  assert.match(scripts[1], /"cat":"agent","evt":"auth_failed"/);
});

test('application host never renders the Redis password in command output', () => {
  assert.doesNotMatch(scripts[1], /AUTH_ARGS/);
  assert.match(scripts[1], /REDISCLI_AUTH='<redis-password>' redis-cli/);
});
