// Build script — bundles the workbench React client into dist/client/app.js
// (IIFE, zero runtime deps) and a browser-safe ESM embed.js for the DSH client
// module inject path (react/react-dom external).
import { build } from 'esbuild'
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist', 'client')
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

// IIFE shell (standalone SPA, zero runtime deps).
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

// Library entry (importable by the DSH client shell). react/react-dom external.
await build({
  entryPoints: [join(root, 'src/client/embed.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  outfile: join(outDir, 'embed.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})

await writeFile(
  join(outDir, 'embed.d.ts'),
  `export { App as WorkbenchView } from '../src/client/App'
export type { PanelKind } from '../src/client/App'
`,
  'utf8',
)

// Minimal stylesheet for the stand-alone shell/lab.
await writeFile(
  join(outDir, 'styles.css'),
  `.helmsman-workbench { font-family: system-ui; padding: 12px; }
.hw-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.hw-tab { padding: 6px 12px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
.hw-tab.active { border-color: #2563eb; color: #2563eb; font-weight: 600; }
.hw-panel { max-width: 720px; }
.hw-panel textarea { width: 100%; box-sizing: border-box; margin: 6px 0; }
.hw-actions button { padding: 6px 14px; }
.hw-records { list-style: none; padding: 0; }
.hw-records li { padding: 4px 0; }
.hw-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.hw-dot[data-status="completed"] { background: #16a34a; }
.hw-dot[data-status="running"] { background: #d97706; }
.hw-dot[data-status="failed"] { background: #dc2626; }
.hw-toast { margin-top: 12px; padding: 8px; background: #f3f4f6; border-radius: 6px; }
`,
  'utf8',
)

await writeFile(
  join(outDir, 'index.html'),
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>⚓ Helmsman Workbench</title>
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
console.log('[ui-workbench] client bundle written to dist/client')
