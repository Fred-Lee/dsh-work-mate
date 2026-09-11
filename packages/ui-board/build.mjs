// Build script — bundles the React client into dist/client/app.js (IIFE,
// zero runtime deps) and copies static assets. Host serves dist/client.
// Also emits a browser-safe ESM "library" entry (dist/client/embed.js) with
// react/react-dom external so a host client bundle (ui-workbench / DSH shell)
// can import <BoardView/> without duplicating React.
import { build } from 'esbuild'
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist', 'client')
// clean: 防止源文件删除后旧产物残留并被 files:["dist"] 打进包里
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

// IIFE shell (standalone SPA at /helmsman-board/, zero runtime deps).
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

// Library entry (importable BoardView). react/react-dom external.
// `?inline` CSS imports resolve to text (esbuild loader) for inject-styles.
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
  loader: { '.css': 'text' },
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
<title>⚓ Helmsman — 任务看板</title>
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

await writeFile(
  join(outDir, 'embed.d.ts'),
  `// Self-contained declaration (no ./src references — this file ships in the
// published package, where src/ does not exist).
import type { ComponentType } from 'react'
export interface BoardViewProps {
  className?: string
}
export declare const BoardView: ComponentType<BoardViewProps>
export declare const App: ComponentType
export declare const api: Record<string, (...args: never[]) => Promise<unknown>>
export declare const STAGES: readonly string[]
export declare const STAGE_LABELS: Record<string, string>
`,
  'utf8',
)
console.log('[ui-board] client bundle written to dist/client')
