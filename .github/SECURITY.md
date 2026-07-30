# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| latest  | :white_check_mark: |

## Reporting a Vulnerability

Please report security vulnerabilities by opening a [GitHub Security Advisory](https://github.com/dangkhoa2016/Nodejs-WSS-Tunnel/security/advisories/new).

Do NOT report security vulnerabilities via public GitHub Issues.

You should receive a response within 72 hours. If you don't, please follow up.

## Security Features & Best Practices

This project is designed to run in a secure environment with:
- WSS (WebSocket Secure) / TLS enforced behind reverse proxies (Nginx, Caddy, Cloudflare, HuggingFace Spaces)
- Token & credential-based WebSocket authentication
- HMAC-SHA256 authentication for admin management endpoints
- IP allowlist filtering capability for restricting tunnel access

