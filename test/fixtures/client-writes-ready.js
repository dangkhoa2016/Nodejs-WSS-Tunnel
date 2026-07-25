import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const readyFile = join(process.env.HOME || '.', '.tunnel-client', 'client.ready');
writeFileSync(readyFile, String(process.pid));
setInterval(() => {}, 1000);
