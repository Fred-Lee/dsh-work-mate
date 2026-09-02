// Build script — bundles the React client into dist/client/app.js (IIFE,
// zero runtime deps) and copies static assets. Host serves dist/client.
import { build } from 'esbuild'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist', 'client')
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'src/client/main.tsx')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  outfile: join(outDir, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})

await copyFile(join(root, 'src/client/styles.css'), join(outDir, 'styles.css'))
await writeFile(
  join(outDir, 'index.html'),
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>⚓ Helmsman — Diff 对比视图</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div id="root"></div>
<script src="app.js"></script>
</body>
</html>
`,
  'utf8',
)
console.log('[ui-diff] client bundle written to dist/client')
