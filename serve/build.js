import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const serveDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(serveDir, '..');

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(serveDir, 'client.js')],
    outfile: path.join(root, 'dist', 'client.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['ws'],
    banner: {
      js: '#!/usr/bin/env node\n',
    },
    logLevel: 'info',
  }),
  esbuild.build({
    entryPoints: [path.join(serveDir, 'tcp-agent.js')],
    outfile: path.join(root, 'dist', 'tcp-agent.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['ws'],
    banner: {
      js: '#!/usr/bin/env node\n',
    },
    logLevel: 'info',
  }),
]);
