import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  absWorkingDir: root,
  entryPoints: ['shared/src/index.ts'],
  outfile: 'shared/dist/index.js',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  legalComments: 'eof',
})
