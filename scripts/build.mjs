// esbuild host bundler: relative imports are bundled, npm deps stay external
// (the profile's node_modules provides them at runtime) — same discipline the
// Helmsman line used across 15 packages.
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})
console.log('[build] workmate4dsh → dist/index.js')
