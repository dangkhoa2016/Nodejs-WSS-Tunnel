const readyPath = process.env.TUNNEL_READY_FILE || process.env.AGENT_READY_FILE;
if (readyPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(readyPath, String(process.pid));
}
setInterval(() => {}, 1000);
