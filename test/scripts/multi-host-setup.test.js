import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const serviceHost = read('scripts/setup-service-host.sh');
const appHost = read('scripts/setup-application-host.sh');
const scripts = [serviceHost, appHost];

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

test('artifact downloads verify TLS by default and use the current ws range', () => {
  for (const script of scripts) {
    assert.doesNotMatch(script, /curl\s+-[A-Za-z]*k[A-Za-z]*/);
    assert.match(script, /"ws":"\^8\.21\.3"/);
  }
});

test('bundle and manifest URLs default to https and need an explicit insecure override', () => {
  for (const script of scripts) {
    assert.match(script, /https:\/\/\$SERVER_HOST/);
    assert.match(script, /ALLOW_INSECURE_BUNDLE_URL/);
    assert.match(script, /ALLOW_FALLBACK_MANIFEST/);
  }
});

test('stale PID files cannot target arbitrary processes', () => {
  for (const script of scripts) {
    assert.match(script, /is_expected_process\(\)/);
    assert.match(script, /ps -p "\$pid" -o args=/);
    assert.match(script, /refusing to operate/);
  }
});

test('roles use the correct WebSocket paths and loopback binding', () => {
  assert.match(serviceHost, /env_server_url="wss:\/\/\$SERVER_HOST\/tunnel"/);
  assert.match(appHost, /env_server_url="wss:\/\/\$SERVER_HOST\/tcp"/);
  assert.match(appHost, /AGENT_BIND_HOST="\$\{AGENT_BIND_HOST:-127\.0\.0\.1\}"/);
});

test('readiness uses an explicit ready file plus auth_failed fast-fail', () => {
  assert.match(serviceHost, /TUNNEL_READY_FILE/);
  assert.match(appHost, /AGENT_READY_FILE/);
  for (const script of scripts) {
    assert.match(script, /auth_failed/);
  }
});

test('transactional lifecycle helpers are present', () => {
  const helpers = [
    'download_atomic',
    'activate_release',
    'wait_for_readiness',
    'rollback_to_previous',
    'cleanup_failed_activation',
    'acquire_lock',
    'stage_release',
  ];
  for (const script of scripts) {
    for (const fn of helpers) {
      assert.match(script, new RegExp(`^${fn}\\(\\)`, 'm'), `missing helper ${fn}`);
    }
  }
});

test('installers hold an install lock and reject concurrent runs', () => {
  for (const script of scripts) {
    assert.match(script, /\.install\.lock/);
    assert.match(script, /Another installation is already running/);
  }
});

test('the release model uses current/previous symlinks and per-release dependencies', () => {
  for (const script of scripts) {
    assert.match(script, /release\.XXXXXXXX/);
    assert.match(script, /current_release_path/);
    assert.match(script, /previous_release_path/);
    assert.match(script, /npm install --omit=dev/);
  }
});

test('SERVER_HOST validation rejects schemes, paths, queries, whitespace and bad ports', () => {
  for (const script of scripts) {
    assert.match(script, /SERVER_HOST must not include a scheme/);
    assert.match(script, /SERVER_HOST contains invalid characters/);
    assert.match(script, /SERVER_HOST has a malformed port/);
    assert.match(script, /unbracketed multi-colon/);
  }
});

test('INSTALL_UUID rejects path injection characters', () => {
  for (const script of scripts) {
    assert.match(script, /INSTALL_UUID contains invalid characters/);
  }
});

test('application host requires and validates AGENT_PORTS explicitly', () => {
  assert.match(appHost, /AGENT_PORTS is required, e\.g\. 6379 or 6379,5432/);
  assert.match(appHost, /out of range \(1\.\.65535\)/);
  assert.match(appHost, /duplicate port/);
  assert.doesNotMatch(appHost, /AGENT_PORTS="\$\{AGENT_PORTS:-\}6379,5432"/);
});

test('application host rejects non-loopback bind without an explicit override', () => {
  assert.match(appHost, /ALLOW_REMOTE_AGENT_BIND/);
  assert.match(appHost, /Refusing a non-loopback bind/);
});

test('application host never renders the Redis password in command output', () => {
  assert.doesNotMatch(appHost, /AUTH_ARGS/);
  assert.match(appHost, /REDISCLI_AUTH='<redis-password>' redis-cli/);
});

test('no fixed sleep is treated as readiness', () => {
  for (const script of scripts) {
    assert.match(script, /wait_for_readiness/);
    assert.doesNotMatch(script, /sleep [0-9]+ && .*exit 0/);
  }
});

test('presence-aware rollback config uses OLD_*_SET flags', () => {
  for (const script of scripts) {
    assert.match(script, /OLD_TUNNEL_SERVER_URL_SET/);
    assert.match(script, /OLD_.*_SET=1/);
  }
});

test('rollback failure cleans up stale metadata', () => {
  for (const script of scripts) {
    assert.match(script, /cleanup_stale_metadata/);
  }
});

test('PID lifecycle uses resolve_running_managed_pid', () => {
  for (const script of scripts) {
    assert.match(script, /resolve_running_managed_pid/);
  }
});

test('Linux /proc environ is documented in script headers', () => {
  for (const script of scripts) {
    assert.match(script, /\/proc\/\$pid\/environ/);
  }
});

test('ALLOW_CODE_ONLY_ROLLBACK is supported for code-only rollback', () => {
  for (const script of scripts) {
    assert.match(script, /ALLOW_CODE_ONLY_ROLLBACK/);
  }
});
