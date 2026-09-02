/**
 * REST API endpoint scanner — walks a service's source tree and extracts
 * HTTP endpoints from:
 *  - Java / Spring: @RestController/@Controller + @RequestMapping + @*Mapping
 *  - NestJS (TypeScript): @Controller + @Get/@Post/@Put/@Delete/@Patch decorators
 *  - Express-style (JS/TS): router.get('/x'), app.post('/y')
 *
 * Resource limits (depth, file count, file size) keep the scan bounded on
 * large repos; paths are confined to the configured root.
 */
import { readFile, readdir, stat, realpath } from 'node:fs/promises'
import { extname, dirname, join, relative, resolve, sep } from 'node:path'
import type { ApiEndpoint } from './types.ts'

export interface ScanOptions {
  /** Directory-local paths to skip (defaults cover build outputs & deps). */
  skipDirs?: string[]
  maxDepth?: number
  maxFiles?: number
  maxFileBytes?: number
}

const DEFAULT_SKIP = new Set([
  'node_modules', '.git', 'target', 'build', 'dist', '.gradle', '.idea', '.vscode', 'coverage', '__pycache__', '.next',
])

const DEFAULTS: Required<Omit<ScanOptions, 'skipDirs'>> = {
  maxDepth: 8,
  maxFiles: 3000,
  maxFileBytes: 512 * 1024,
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

const SPRING_METHOD_RE = /@(Get|Post|Put|Delete|Patch)Mapping(?:\s*\(\s*(?:value\s*=\s*)?"([^"]*)"[^)]*\))?/g
const SPRING_REQMAP_RE = /@RequestMapping(?:\s*\(\s*(?:value\s*=\s*)?"([^"]*)"[^)]*\))?/
const NEST_METHOD_RE = /@(Get|Post|Put|Delete|Patch)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g
const NEST_CONTROLLER_RE = /@Controller\(\s*(?:'([^']*)'|"([^']*)")?\s*\)[\s\S]{0,200}?(?:export\s+)?class\s+(\w+)/
const EXPRESS_RE = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g

interface ScanAccumulator {
  endpoints: ApiEndpoint[]
  filesSeen: number
  truncated: boolean
}

export async function scanRestApis(rootPath: string, opts: ScanOptions = {}): Promise<ApiEndpoint[]> {
  const root = await assertInside(rootPath)
  const acc: ScanAccumulator = { endpoints: [], filesSeen: 0, truncated: false }
  const skip = new Set([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])])
  const limits = { ...DEFAULTS, ...opts }
  await walk(root, root, 0, skip, limits, acc)
  return acc.endpoints.slice(0, 500)
}

async function assertInside(rootPath: string): Promise<string> {
  const abs = resolve(rootPath)
  // Compare against the realpath of the parent so symlinked roots like
  // macOS /var → /private/var are allowed, but a root-internal symlink
  // pointing outside still trips the check.
  const [parentReal, real] = await Promise.all([realpath(resolve(dirname(abs))), realpath(abs)])
  if (!real.startsWith(parentReal + sep)) {
    throw new Error(`resolved path escapes scan root: ${rootPath} -> ${real}`)
  }
  return abs
}

async function walk(
  dir: string,
  root: string,
  depth: number,
  skip: Set<string>,
  limits: { maxDepth: number; maxFiles: number; maxFileBytes: number },
  acc: ScanAccumulator,
): Promise<void> {
  if (depth > limits.maxDepth || acc.truncated) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (acc.truncated) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue
      await walk(full, root, depth + 1, skip, limits, acc)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    const isJava = ext === '.java'
    const isTs = ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.mts'
    if (!isJava && !isTs) continue
    acc.filesSeen += 1
    if (acc.filesSeen > limits.maxFiles) {
      acc.truncated = true
      return
    }
    let content: string
    try {
      const info = await stat(full)
      if (info.size > limits.maxFileBytes) continue
      content = await readFile(full, 'utf8')
    } catch {
      continue
    }
    const relPath = relative(root, full).split(sep).join('/')
    if (isJava) scanJava(content, relPath, acc)
    else scanTypeScript(content, relPath, acc)
  }
}

function scanJava(content: string, file: string, acc: ScanAccumulator): void {
  if (!content.includes('@Controller') && !content.includes('@RestController') && !content.includes('Mapping')) return
  // Class-level base path (@RequestMapping on the controller) + every method
  // mapping in the file. @RequestMapping is not a method annotation, so the
  // two sets never collide.
  const base = content.match(SPRING_REQMAP_RE)?.[1] ?? ''
  const cls = content.match(/class\s+(\w+)/)?.[1] ?? 'Unknown'
  for (const m of content.matchAll(SPRING_METHOD_RE)) {
    const method = m[1]!.toUpperCase()
    acc.endpoints.push({
      method,
      path: joinPaths(base, m[2] ?? ''),
      handler: `${cls}.${method.toLowerCase()}`,
      description: file,
    })
  }
}

function scanTypeScript(content: string, file: string, acc: ScanAccumulator): void {
  // NestJS decorators
  if (content.includes('@Controller')) {
    const ctrl = content.match(NEST_CONTROLLER_RE)
    const base = ctrl?.[1] ?? ctrl?.[2] ?? ''
    for (const m of content.matchAll(NEST_METHOD_RE)) {
      acc.endpoints.push({
        method: m[1]!.toUpperCase(),
        path: joinPaths(base, m[2] ?? m[3] ?? ''),
        handler: `${ctrl?.[3] ?? 'Controller'}.${m[1]!.toLowerCase()}`,
        description: file,
      })
    }
  }
  // Express-style routes
  for (const m of content.matchAll(EXPRESS_RE)) {
    acc.endpoints.push({
      method: m[1]!.toUpperCase(),
      path: normalizeExpressPath(m[2]!),
      handler: undefined,
      description: file,
    })
  }
}

function joinPaths(base: string, sub: string): string {
  const b = base.replace(/\/+$/, '')
  const s = sub.startsWith('/') || sub === '' ? sub : `/${sub}`
  const joined = `${b}${s}`
  return joined === '' ? '/' : joined.startsWith('/') ? joined : `/${joined}`
}

function normalizeExpressPath(p: string): string {
  return p.startsWith('/') ? p : `/${p}`
}

export function methodLabel(m: string): string {
  return HTTP_METHODS.includes(m.toUpperCase() as (typeof HTTP_METHODS)[number]) ? m.toUpperCase() : 'GET'
}
