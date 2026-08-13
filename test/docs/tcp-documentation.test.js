import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const references = [read('docs/tcp-tunnel.md'), read('docs/tcp-tunnel.vi.md')];
const guides = [
  read('docs/guide-external-app-to-tcp-services.md'),
  read('docs/guide-external-app-to-tcp-services.vi.md'),
];
const multiHostGuides = [
  read('docs/guide-multi-host-tcp-services.md'),
  read('docs/guide-multi-host-tcp-services.vi.md'),
];

test('TCP references document current source paths and proxy trust', () => {
  for (const reference of references) {
    assert.match(reference, /TCP_AGENT_TRUSTED_PROXIES/);
    assert.doesNotMatch(reference, /src\/(TcpRouter|protocol|config|ipAllowlist)\.js/);
    assert.match(reference, /src\/tcp\/TcpRouter\.js/);
    assert.match(reference, /src\/shared\/protocol\.js/);
    assert.match(reference, /src\/shared\/config\.js/);
    assert.match(reference, /src\/shared\/ipAllowlist\.js/);
  }
});

test('TCP references provide complete non-interactive installation commands', () => {
  for (const reference of references) {
    assert.match(reference, /export TUNNEL_SERVER_URL=[^\n]+[\s\S]{0,240}curl[^\n]*-install[^\n]*\| bash/);
    assert.match(reference, /tcp-agent\.js/);
    assert.match(reference, /tcp-agent-package\.json/);
  }
});

test('external-service guides keep direct and agent verification distinct', () => {
  for (const guide of guides) {
    assert.doesNotMatch(guide, /redis-cli[^\n]*-p 443[^\n]*--tls/);
    assert.match(guide, /redis-cli[^\n]*-h 127\.0\.0\.1[^\n]*-p 6379/);
    assert.match(guide, /redis-cli[^\n]*<server-host>[^\n]*-p 6379/);
    assert.match(guide, /READONLY/);
    assert.match(guide, /TCP_TUNNEL_ALLOWED_IPS/);
  }
});

test('agent setup documents safe binding and matches served dependencies', () => {
  const setup = read('docs/setup-tcp-agent.sh');
  const agentManifest = JSON.parse(read('serve/tcp-agent-package.json'));
  const clientManifest = JSON.parse(read('serve/client-package.json'));
  const rootManifest = JSON.parse(read('package.json'));
  const wsRange = rootManifest.dependencies.ws;

  assert.match(setup, /#\s+AGENT_BIND_HOST\s+/);
  assert.match(setup, new RegExp(`"ws":"\\${wsRange}"`));
  assert.equal(agentManifest.dependencies.ws, wsRange);
  assert.equal(clientManifest.dependencies.ws, wsRange);
});

test('English and Vietnamese references preserve mode-first navigation', () => {
  assert.match(references[0], /^## Choose a deployment mode$/m);
  assert.match(references[1], /^## Chọn chế độ triển khai$/m);
  assert.match(guides[0], /^## Choose direct or agent mode$/m);
  assert.match(guides[1], /^## Chọn chế độ trực tiếp hoặc agent$/m);
});

test('multi-host guides document repeatable agents and limit scope', () => {
  for (const guide of multiHostGuides) {
    assert.doesNotMatch(guide, /clone (the )?repository/i);
    assert.match(guide, /setup-service-host\.sh/);
    assert.match(guide, /setup-application-host\.sh/);
    assert.match(guide, /TCP_MAX_CONNECTIONS_PER_PORT/);
    assert.match(guide, /TCP_AGENT_MAX_STREAMS_PER_AGENT/);
    assert.match(guide, /Redis ACL/i);
    assert.match(guide, /PostgreSQL role/i);
  }
});

test('multi-host guides install one pinned script without a source checkout', () => {
  assert.match(multiHostGuides[0], /raw\.githubusercontent\.com[^\n]*<release-tag>[^\n]*setup-service-host\.sh/);
  assert.match(multiHostGuides[1], /raw\.githubusercontent\.com[^\n]*<release-tag>[^\n]*setup-service-host\.sh/);
});
