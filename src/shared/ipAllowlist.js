/**
 * Returns true if `remoteAddr` matches any entry in `allowlist`.
 * Empty allowlist means "allow all". IPv4-only.
 *
 * Known limitation: does not handle native IPv6.
 * ::ffff:127.0.0.1 is normalized to 127.0.0.1 (IPv4-mapped prefix stripped).
 * Native ::1 will NOT match an IPv4 allowlist entry.
 */
export function isIpAllowed(remoteAddr, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const ip = normalizeIp(remoteAddr);
  return allowlist.some((entry) => matchCidr(ip, entry));
}

export function isValidIpOrCidr(entry) {
  if (typeof entry !== 'string' || entry === '') return false;
  if (!entry.includes('/')) return ipToInt(entry) !== null;
  const [range, bitsStr] = entry.split('/');
  const bits = Number.parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  return ipToInt(range) !== null;
}

function normalizeIp(addr) {
  if (!addr) return '';
  if (addr.startsWith('::ffff:')) return addr.slice(7);
  return addr;
}

function matchCidr(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number.parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipToInt(ip) {
  const parts = (ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
