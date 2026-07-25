import fs from 'node:fs';

let promptFdOpen = true;

try {
  fs.fstatSync(200);
} catch (error) {
  if (error?.code === 'EBADF') {
    promptFdOpen = false;
  } else {
    throw error;
  }
}

fs.writeFileSync(
  process.env.TUNNEL_CAPTURE_FILE,
  JSON.stringify({
    server: process.env.TUNNEL_SERVER_URL,
    username: process.env.TUNNEL_USERNAME,
    password: process.env.TUNNEL_PASSWORD,
    target: process.env.TARGET_ORIGIN,
    promptFdOpen,
  }),
  { mode: 0o600 },
);
fs.writeFileSync(process.env.TUNNEL_READY_FILE, `${process.pid}\n`, { mode: 0o600 });
setInterval(() => {}, 1000);
