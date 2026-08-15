/**
 * Strict AGENT_PORTS parser for tcp-agent.js.
 *
 * Unlike the server-side readPortList (which silently deduplicates), this
 * parser canonicalizes decimal tokens — including leading-zero aliases — and
 * rejects malformed input (empty entries, non-numeric tokens, out-of-range
 * ports) as well as duplicates after numeric canonicalization (e.g. 06379,6379).
 *
 * The function is intentionally pure (no process.exit) so it can be unit-
 * tested without spawning a subprocess.
 */

/**
 * Parse and validate a comma-separated AGENT_PORTS string.
 *
 * @param {string} raw  The raw env-var value.
 * @returns {number[]} Canonical port numbers in input order.
 * @throws {Error} on any validation failure.
 */
export function parseAgentPorts(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('AGENT_PORTS is required');
  }

  const tokens = raw.split(',');
  const ports = [];
  const seen = new Set();

  for (const rawToken of tokens) {
    const token = rawToken.trim();

    if (!token) {
      throw new Error('AGENT_PORTS contains an empty entry');
    }

    if (!/^\d+$/.test(token)) {
      throw new Error(`AGENT_PORTS contains a non-numeric port: ${token}`);
    }

    const port = Number(token);

    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error(`AGENT_PORTS port out of range: ${token}`);
    }

    if (seen.has(port)) {
      throw new Error(`AGENT_PORTS contains duplicate port: ${port}`);
    }

    seen.add(port);
    ports.push(port);
  }

  return ports;
}
