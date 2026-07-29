import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const serveDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(serveDir, '..');
const outDir = path.resolve(process.env.OUT_DIR || path.join(root, 'dist'));

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(serveDir, 'client.js')],
    outfile: path.join(outDir, 'client.js'),
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
    outfile: path.join(outDir, 'tcp-agent.js'),
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
