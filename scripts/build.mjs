// workmate4dsh build: host ESM bundle + two client exits (design D5):
//   dist/client/app.js    — standalone IIFE page (React inlined)
//   dist/client/client.js — DSH ModuleLoader CJS module (react/cordis external)
// plus dist/client/index.html for the standalone route.
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await mkdir('dist/client', { recursive: true })

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

await build({
  entryPoints: ['src/client/main.tsx'],
  outfile: 'dist/client/app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})
console.log('[build] standalone panel → dist/client/app.js')

const CLIENT_ID = 'workmate4dsh'
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/cordis'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})
console.log('[build] client module → dist/client/client.js')

const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkMate 提案</title>
</head>
<body>
<div id="root"></div>
<script src="./app.js"></script>
</body>
</html>
`
await writeFile('dist/client/index.html', indexHtml, 'utf8')
console.log('[build] dist/client/index.html')
