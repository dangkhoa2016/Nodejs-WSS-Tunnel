import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['client.js'],
  outfile: 'dist/client.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['ws'],
  banner: {
    js: '#!/usr/bin/env node\n',
  },
  logLevel: 'info',
});
