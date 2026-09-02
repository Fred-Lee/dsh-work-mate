// Shared esbuild config for all Helmsman packages.
// Bundles only relative imports; npm deps stay external (installed by pnpm
// in the profile's node_modules at runtime).
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)))
const outDir = join(pkgDir, 'dist')
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(pkgDir, 'src/index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})
console.log(`[build] ${pkgDir} → dist/index.js`)
