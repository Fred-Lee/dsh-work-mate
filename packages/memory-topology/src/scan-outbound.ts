/**
 * Outbound HTTP call scanner — the mirror image of `scan-rest.ts`.
 *
 * `scan-rest` finds the endpoints a service EXPOSES; this module finds the calls
 * a service MAKES, plus the base-address/config clues that name the callee. The
 * output feeds `derive-dependencies.ts`, which turns clues into confirmable
 * dependency candidates.
 *
 * Recognised call forms (spec `dependency-derivation` §「出站调用扫描」):
 *  - Java: `RestTemplate` (`getForObject`/`postForObject`/`exchange`/…),
 *    `WebClient` (`uri`/`baseUrl`), `@FeignClient` + interface-level `@*Mapping`,
 *    `HttpClient` (`URI.create(...)`, `new HttpGet(...)`).
 *  - JS/TS: `axios.<verb>(…)`, `axios.create({ baseURL })`, `fetch(…)`,
 *    `http(s).<verb>(…)`; template-literal interpolation is normalised to the
 *    placeholder form `` `/api/users/${id}/orders` `` → `/api/users/{}/orders`.
 *
 * Name clues (which service is being called) come from:
 *  - `@FeignClient` attributes — including the *placeholder-key* form that is the
 *    dominant real-world shape and the reason this scanner exists:
 *      `@FeignClient(name = "${project.feign-client-config.internal-bc-es.name}")`
 *    → target `internal-bc-es`, with a resolved config value as extra evidence;
 *  - `*.base-url` / `*.url` / `*.host` style config keys (`.properties`, YAML,
 *    `.env`), resolved against local config files only;
 *  - URLs inside call literals, k8s service DNS (`<svc>.<ns>.svc.cluster.local`)
 *    and `http://<svc>:<port>` forms.
 *
 * Contract: static and offline. No network request is ever issued; resource
 * limits and root containment are exactly the ones from `scan-rest.ts` (D6).
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { assertScanRoot, SCAN_LIMITS, SCAN_SKIP_DIRS, type ScanOptions } from './scan-rest.ts'
import { parseYamlSubset, type YamlValue } from './yaml.ts'

/** Where a clue came from: a call site, a config entry, or a Feign annotation. */
export type OutboundEvidenceKind = 'call' | 'config' | 'feign'

export interface OutboundEvidence {
  /** Path relative to the scanned root, slash-separated. */
  file: string
  line?: number
  kind: OutboundEvidenceKind
}

/**
 * One outbound clue. A clue is either a **call** (it carries a `path`), a
 * **name/config** clue (`path === ''` — "this service is addressed with this
 * base address"), or both.
 *
 * `target` is a *name clue*, not necessarily a declared service —
 * `derive-dependencies.ts` decides whether it resolves to a registered service.
 */
export interface OutboundCall {
  /** Request path in placeholder form (`/api/users/{}/orders`); `''` = name-only clue. */
  path: string
  method?: string
  /** Primary target service name clue (Feign key segment, config key segment, host). */
  target?: string
  /** Additional names the same clue points at (resolved config value host, …). */
  targetAliases?: string[]
  /** Dotted config key behind the clue, when there is one. */
  configKey?: string
  /** Base address / URL / prefix observed for this clue. */
  baseUrl?: string
  /**
   * The call path lost its class-level prefix because that prefix is an
   * unresolved placeholder — path matching must use the method-level path only
   * and the evidence must say so (design D3).
   */
  prefixUnresolved?: boolean
  /** Human-readable, UI-facing detail of the clue (Chinese where it matters). */
  detail?: string
  /** Degradation marker surfaced as evidence (「值未解析」/「前缀未解析」). */
  note?: string
  evidence: OutboundEvidence
}

/** How much of a repository the scan reads. */
export type OutboundScanScope = 'config' | 'full'

export interface OutboundScanOptions extends ScanOptions {
  /** Hard cap on emitted clues (bounded output on huge trees). */
  maxClues?: number
  /** Config files collected for placeholder-value resolution. */
  maxConfigFiles?: number
  /** Config files above this size are ignored (they are not configuration). */
  maxConfigFileBytes?: number
  /**
   * `'config'` reads ONLY configuration files (name-tier clues — the config is
   * the source of truth for who calls whom); `'full'` additionally walks source
   * files for call sites and endpoint detail. The scanner-level default stays
   * `'full'` (backwards compatible); the derivation layer defaults to
   * `'config'` — see `derive-dependencies.ts`.
   */
  scope?: OutboundScanScope
}

const EXTRA_DEFAULTS = {
  maxClues: 2000,
  maxConfigFiles: 200,
  maxConfigFileBytes: 64 * 1024,
  scope: 'full' as OutboundScanScope,
}

const SOURCE_EXTS = new Set(['.java', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs'])
const CONFIG_EXTS = new Set(['.yml', '.yaml', '.properties', '.env', '.conf'])

/** The notion of "a real HTTP verb", shared with `scan-rest`'s endpoint filter. */
export const HTTP_VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

/** Hosts that are infrastructure/tooling rather than project services. */
const HOST_DENYLIST = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  'raw.githubusercontent.com',
])

/** Key segments too generic to be a service name. */
const GENERIC_KEY_SEGMENTS = new Set([
  'url', 'uri', 'host', 'hostname', 'domain', 'base', 'base-url', 'baseurl', 'endpoint', 'addr', 'address',
  'server-addr', 'server', 'port', 'name', 'value', 'path', 'prefix', 'config', 'properties', 'service',
  'api', 'http', 'https', 'spring', 'logging', 'management',
])

/** `…-url` / `…-host` style tails of a config key. */
const KEY_URL_TAIL = /(?:^|[._-])(url|uri|base[-_]?url|endpoint|addr|address|server[-_]?addr)$/i
const KEY_HOST_TAIL = /(?:^|[._-])(host|hostname|domain)$/i

/**
 * Property names that close a config key. Used to find the service-name segment
 * that sits *immediately before* the property:
 * `internal-homework.base-url` → `internal-homework`.
 */
const CONFIG_PROPERTY_NAMES = new Set([
  'url', 'uri', 'host', 'hostname', 'domain', 'name', 'path', 'base-url', 'baseurl', 'base-uri',
  'endpoint', 'addr', 'address', 'port', 'prefix', 'version', 'timeout', 'servers', 'nodes',
])

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scans `rootPath` for outbound calls and target clues. Throws when the path
 * escapes its own root (same containment rule as `scan-rest`) and never issues
 * a network request.
 */
export async function scanOutboundCalls(rootPath: string, opts: OutboundScanOptions = {}): Promise<OutboundCall[]> {
  const root = await assertScanRoot(rootPath)
  const extra = { ...EXTRA_DEFAULTS, ...opts }
  const acc: ScanAccumulator = {
    calls: [],
    feigns: [],
    configs: [],
    filesSeen: 0,
    truncated: false,
    limits: { ...SCAN_LIMITS, ...opts },
    extra,
  }
  await walk(root, root, 0, new Set([...SCAN_SKIP_DIRS, ...(opts.skipDirs ?? [])]), acc)

  const config = buildConfigIndex(acc.configs)
  const clues: OutboundCall[] = []
  // 1. Config/base clues (independent of any code file).
  for (const entry of config.entries) {
    const clue = configClue(entry)
    if (clue) clues.push(clue)
  }
  // 2. Feign name + call clues, with placeholder resolution against the config index.
  for (const feign of acc.feigns) clues.push(...feignClues(feign, config))
  // 3. Plain call-site clues (RestTemplate / WebClient / HttpClient / axios / fetch).
  for (const call of acc.calls) clues.push(callClue(call))

  return dedupeClues(clues).slice(0, extra.maxClues)
}

// ---------------------------------------------------------------------------
// Walking (same discipline as scan-rest: bounded depth/count/size, no network)
// ---------------------------------------------------------------------------

interface RawCall {
  /** Raw literal: an absolute URL or a request path. */
  literal: string
  method?: string
  file: string
  line: number
  /** Source form, for evidence (`RestTemplate.getForObject(…)`). */
  form: string
}

interface RawMapping {
  path: string
  method?: string
  line: number
}

interface FeignInterface {
  file: string
  line: number
  /** Attribute values as written (may be `${placeholder}`). */
  nameAttr?: string
  urlAttr?: string
  pathAttr?: string
  /** Positional `@FeignClient("name")` form. */
  nameLiteral?: string
  mappings: RawMapping[]
}

interface ConfigFile {
  file: string
  content: string
}

interface ScanAccumulator {
  calls: RawCall[]
  feigns: FeignInterface[]
  configs: ConfigFile[]
  filesSeen: number
  truncated: boolean
  limits: { maxDepth: number; maxFiles: number; maxFileBytes: number }
  extra: typeof EXTRA_DEFAULTS
}

async function walk(dir: string, root: string, depth: number, skip: Set<string>, acc: ScanAccumulator): Promise<void> {
  if (depth > acc.limits.maxDepth || acc.truncated) return
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
      await walk(full, root, depth + 1, skip, acc)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    const isSource = SOURCE_EXTS.has(ext)
    const isConfig = CONFIG_EXTS.has(ext) || isDotEnv(entry.name)
    if (!isSource && !isConfig) continue
    // Config scope: configuration IS the source of truth for name-tier clues,
    // so source files are not even counted against the budget — never read.
    if (acc.extra.scope === 'config' && !isConfig) continue
    acc.filesSeen += 1
    if (acc.filesSeen > acc.limits.maxFiles) {
      acc.truncated = true
      return
    }
    let content: string
    try {
      const info = await stat(full)
      const cap = isConfig ? Math.min(acc.limits.maxFileBytes, acc.extra.maxConfigFileBytes) : acc.limits.maxFileBytes
      if (info.size > cap) continue
      content = await readFile(full, 'utf8')
    } catch {
      continue
    }
    const rel = relative(root, full).split(sep).join('/')
    if (isConfig) {
      if (acc.configs.length < acc.extra.maxConfigFiles) acc.configs.push({ file: rel, content })
      continue
    }
    if (ext === '.java') scanJavaFile(content, rel, acc)
    else scanJsFile(content, rel, acc)
  }
}

function isDotEnv(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')
}

// ---------------------------------------------------------------------------
// Java: Feign / RestTemplate / WebClient / HttpClient
// ---------------------------------------------------------------------------

const SPRING_MAPPING_RE = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g
const REST_TEMPLATE_RE =
  /\.\s*(getForObject|getForEntity|postForObject|postForEntity|put|delete|patchForObject|exchange|headForHeaders|optionsForAllow)\s*\(/g
const WEB_CLIENT_RE = /\.\s*(?:uri|baseUrl|url)\s*\(/g
const HTTP_CLIENT_RE = /(?:URI\s*\.\s*create|new\s+HttpGet|new\s+HttpPost|new\s+HttpPut|new\s+HttpDelete)\s*\(/g

function scanJavaFile(content: string, file: string, acc: ScanAccumulator): void {
  for (const feign of parseFeignInterfaces(content, file)) acc.feigns.push(feign)

  if (/getForObject|getForEntity|postForObject|postForEntity|patchForObject|headForHeaders|optionsForAllow|\.exchange\s*\(|restTemplate/i.test(content)) {
    for (const m of content.matchAll(REST_TEMPLATE_RE)) {
      const arg = readJavaLiteralAfter(content, m.index + m[0].length)
      if (!arg) continue
      acc.calls.push({
        literal: applyInterpolation(content, arg),
        file,
        line: lineOf(content, m.index),
        form: `RestTemplate.${m[1]}(…)`,
      })
    }
  }

  if (/\.uri\s*\(|baseUrl\s*\(/.test(content)) {
    for (const m of content.matchAll(WEB_CLIENT_RE)) {
      // `HttpRequest.newBuilder().uri(URI.create("…"))` is an HttpClient call —
      // the dedicated HttpClient pass below owns it (no double clue).
      if (/^\s*URI\s*\.\s*create\s*\(/.test(content.slice(m.index + m[0].length, m.index + m[0].length + 40))) continue
      const arg = readJavaLiteralAfter(content, m.index + m[0].length)
      if (!arg) continue
      acc.calls.push({
        literal: applyInterpolation(content, arg),
        file,
        line: lineOf(content, m.index),
        form: 'WebClient(…)',
      })
    }
  }

  if (/URI\s*\.\s*create|HttpGet|HttpPost|HttpPut|HttpDelete|HttpRequest/.test(content)) {
    for (const m of content.matchAll(HTTP_CLIENT_RE)) {
      const arg = readJavaLiteralAfter(content, m.index + m[0].length)
      if (!arg) continue
      acc.calls.push({
        literal: applyInterpolation(content, arg),
        file,
        line: lineOf(content, m.index),
        form: 'HttpClient(…)',
      })
    }
  }
}

/** `"/api/users/" + id` → `/api/users/{}` (Java concatenation = interpolation). */
function applyInterpolation(content: string, arg: { value: string; end: number }): string {
  if (!/^\s*\+\s*[\w$]/.test(content.slice(arg.end, arg.end + 40))) return arg.value
  return arg.value.endsWith('/') ? `${arg.value}{}` : `${arg.value}/{}`
}

function parseFeignInterfaces(content: string, file: string): FeignInterface[] {
  const out: FeignInterface[] = []
  for (const m of content.matchAll(/@FeignClient\b/g)) {
    const start = m.index!
    const args = readBalancedParens(content, start)
    const line = lineOf(content, start)
    const mappings = parseSpringMappings(content)
    if (!args) {
      out.push({ file, line, mappings })
      continue
    }
    const nameAttr = attrValue(args.text, ['name', 'value'])
    const urlAttr = attrValue(args.text, ['url'])
    const pathAttr = attrValue(args.text, ['path'])
    const positional = nameAttr || urlAttr || pathAttr ? undefined : firstStringLiteral(args.text) ?? undefined
    out.push({
      file,
      line,
      ...(nameAttr ? { nameAttr } : {}),
      ...(urlAttr ? { urlAttr } : {}),
      ...(pathAttr ? { pathAttr } : {}),
      ...(positional ? { nameLiteral: positional } : {}),
      mappings,
    })
  }
  return out
}

/** Every Spring method mapping in the file (a Feign interface holds one per method). */
function parseSpringMappings(content: string): RawMapping[] {
  const out: RawMapping[] = []
  for (const m of content.matchAll(SPRING_MAPPING_RE)) {
    const line = lineOf(content, m.index)
    const args = readBalancedParens(content, m.index)
    const path = args ? firstStringLiteral(args.text) ?? '' : ''
    const kind = m[1]!
    if (kind === 'Request') {
      const verb = args?.text.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i)?.[1]?.toUpperCase()
      out.push({ path, ...(verb ? { method: verb } : {}), line })
      continue
    }
    out.push({ path, method: kind.toUpperCase(), line })
  }
  return out
}

/** `name = "x"` / `value = "x"` inside an annotation argument list. */
function attrValue(args: string, attrs: string[]): string | undefined {
  for (const attr of attrs) {
    const found = args.match(new RegExp(`(?:^|[,({])\\s*${attr}\\s*=\\s*"([^"]*)"`))?.[1]
    if (found) return found
  }
  return undefined
}

// ---------------------------------------------------------------------------
// JS/TS: axios / fetch / http(s)
// ---------------------------------------------------------------------------

const JS_CALL_RE = /\baxios\s*\.\s*(get|post|put|delete|patch|head|options)\s*(?:<[^()<>]*>)?\s*\(/g
const JS_CREATE_RE = /\baxios\s*\.\s*create\s*(?:<[^()<>]*>)?\s*\(/g
const FETCH_RE = /\bfetch\s*\(/g
const NODE_HTTP_RE = /\b(?:https?|node:https?)\s*\.\s*(get|post|put|delete|patch|request)\s*(?:<[^()<>]*>)?\s*\(/g

function scanJsFile(content: string, file: string, acc: ScanAccumulator): void {
  if (/\baxios\b|fetch\s*\(|https?\.\s*(get|post|request)\b|require\s*\(\s*['"]https?['"]/.test(content)) {
    for (const m of content.matchAll(JS_CALL_RE)) {
      const arg = readJsStringLiteral(content, m.index + m[0].length)
      const url = arg ? applyTrailingConcat(content, arg) : objectPropValue(content, m.index + m[0].length, 'url')
      if (!url) continue
      acc.calls.push({ literal: url, method: m[1]!.toUpperCase(), file, line: lineOf(content, m.index), form: `axios.${m[1]}(…)` })
    }

    for (const m of content.matchAll(JS_CREATE_RE)) {
      const baseUrl = objectPropValue(content, m.index + m[0].length, 'baseURL') ?? objectPropValue(content, m.index + m[0].length, 'baseUrl')
      if (!baseUrl) continue
      acc.calls.push({ literal: baseUrl, file, line: lineOf(content, m.index), form: 'axios.create({ baseURL })' })
    }

    for (const m of content.matchAll(FETCH_RE)) {
      const arg = readJsStringLiteral(content, m.index + m[0].length)
      if (!arg) continue
      const method = objectPropValue(content, arg.end, 'method')?.toUpperCase()
      acc.calls.push({
        literal: applyTrailingConcat(content, arg),
        ...(method && HTTP_VERBS.has(method) ? { method } : {}),
        file,
        line: lineOf(content, m.index),
        form: 'fetch(…)',
      })
    }

    for (const m of content.matchAll(NODE_HTTP_RE)) {
      const after = m.index + m[0].length
      const arg = readJsStringLiteral(content, after)
      if (arg) {
        acc.calls.push({
          literal: applyTrailingConcat(content, arg),
          method: m[1]!.toUpperCase(),
          file,
          line: lineOf(content, m.index),
          form: `http.${m[1]}(…)`,
        })
        continue
      }
      // `http.request({ host: 'svc', path: '/api/x' })` options-object form.
      const path = objectPropValue(content, after, 'path')
      const host = objectPropValue(content, after, 'host') ?? objectPropValue(content, after, 'hostname')
      if (!path && !host) continue
      acc.calls.push({
        literal: host ? `http://${host}${path ?? ''}` : path!,
        method: m[1]!.toUpperCase(),
        file,
        line: lineOf(content, m.index),
        form: `http.${m[1]}({ host, path })`,
      })
    }
  }
}

/** Template-concat (`'/api/' + id`) appended with a placeholder, like Java. */
function applyTrailingConcat(content: string, arg: { value: string; end: number }): string {
  if (!/^\s*\+\s*(?:[\w$('"`]|\[)/.test(content.slice(arg.end, arg.end + 40))) return arg.value
  return arg.value.endsWith('/') ? `${arg.value}{}` : `${arg.value}/{}`
}

/** First `prop: 'value'` after `from` (bounded window — object literals are small). */
function objectPropValue(content: string, from: number, prop: string): string | undefined {
  const window = content.slice(from, from + 300)
  const m = window.match(new RegExp(`\\b${prop}\\s*:\\s*`))
  if (!m || m.index === undefined) return undefined
  return readJsStringLiteral(window, m.index + m[0].length)?.value
}

// ---------------------------------------------------------------------------
// Literal readers
// ---------------------------------------------------------------------------

/** First string literal inside a parenthesised argument list. */
function firstStringLiteral(args: string): string | null {
  const m = args.match(/"([^"]*)"/)
  return m ? m[1]! : null
}

/** First string literal after `from`, but never past the end of the call args. */
function readJavaLiteralAfter(content: string, from: number): { value: string; end: number } | undefined {
  const slice = content.slice(from, from + 300)
  const quote = slice.indexOf('"')
  if (quote < 0) return undefined
  const close = slice.indexOf(')')
  if (close >= 0 && close < quote) return undefined
  const end = slice.indexOf('"', quote + 1)
  if (end < 0) return undefined
  return { value: slice.slice(quote + 1, end), end: from + end + 1 }
}

/**
 * Reads the balanced `( … )` argument list of the annotation/call starting at
 * `index`; returns its inner text, or null when the token has no argument list.
 */
function readBalancedParens(content: string, index: number): { text: string } | null {
  const open = content.indexOf('(', index)
  if (open < 0 || open - index > 40) return null
  let depth = 0
  let quote: string | null = null
  const limit = Math.min(content.length, open + 2000)
  for (let i = open; i < limit; i++) {
    const ch = content[i]!
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { text: content.slice(open + 1, i) }
    }
  }
  return null
}

/** Reads a JS string/template literal starting at (or after) `from`. */
function readJsStringLiteral(content: string, from: number): { value: string; end: number } | undefined {
  const slice = content.slice(from, from + 400)
  const m = slice.match(/^\s*(['"`])([\s\S]*?)\1/)
  if (!m) return undefined
  return { value: normalizeTemplatePath(m[2]!), end: from + m[0].length }
}

/** `${…}` → `{}` (design open question: `{}` is the canonical internal form). */
export function normalizeTemplatePath(raw: string): string {
  return raw.replace(/\$\{[^{}]*\}/g, '{}')
}

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line += 1
  }
  return line
}

// ---------------------------------------------------------------------------
// Config index + name clues
// ---------------------------------------------------------------------------

export interface ConfigEntry {
  key: string
  value: string
  file: string
  line: number
}

export interface ConfigIndex {
  entries: ConfigEntry[]
  byKey: Map<string, ConfigEntry>
}

/**
 * Flattens every collected config file into dotted `key → value` entries,
 * keeping the first occurrence per key. Both YAML (nested and flat dotted keys)
 * and `key=value` properties/.env files are covered; a plain line scan is also
 * the fallback when a YAML file is not parseable by the subset parser.
 */
export function buildConfigIndex(files: Array<{ file: string; content: string }>): ConfigIndex {
  const entries: ConfigEntry[] = []
  const byKey = new Map<string, ConfigEntry>()
  const add = (key: string, value: string, file: string, line: number): void => {
    const clean = key.trim()
    if (!clean || byKey.has(clean)) return
    const trimmed = value.trim()
    const entry: ConfigEntry = { key: clean, value: trimmed, file, line }
    // Presence is indexed even when the value is empty. `path:` with nothing
    // after the colon is a legitimate, RESOLVED-empty setting — Spring Feign
    // clients in the wild leave it blank — and calling that "value unresolved"
    // put a misleading note on every such client. `entries` stays non-empty
    // only, so an empty setting never becomes a base/config clue of its own.
    byKey.set(clean, entry)
    if (trimmed !== '') entries.push(entry)
  }

  for (const { file, content } of files) {
    const name = basename(file).toLowerCase()
    if (name.endsWith('.yml') || name.endsWith('.yaml')) {
      let flattened = 0
      try {
        for (const [key, value] of flattenYaml(parseYamlSubset(content))) {
          flattened += 1
          add(key, value, file, lineOfKey(content, key))
        }
      } catch {
        flattened = 0
      }
      // A parsed YAML already carries its full dotted keys; only fall back to the
      // raw line scan (which sees bare leaf keys) when the subset parser failed.
      if (flattened > 0) continue
    }
    content.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('//')) return
      const m = line.match(/^([A-Za-z0-9_.\-$]+)\s*[:=]\s*(.+)$/)
      if (!m) return
      add(unquote(m[1]!), unquote(m[2]!), file, i + 1)
    })
  }
  return { entries, byKey }
}

/** Best-effort line number of a (possibly flattened) key, for evidence display. */
function lineOfKey(content: string, key: string): number {
  const tail = key.split('.').pop() ?? key
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`${tail}:`) || lines[i]!.includes(`${tail}=`)) return i + 1
  }
  return 1
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1)
  return t
}

function flattenYaml(value: YamlValue, prefix = ''): Array<[string, string]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const out: Array<[string, string]> = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) out.push(...flattenYaml(child, path))
    else if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') out.push([path, String(child)])
    // A key written with no value (`path:`) parses to null. Emit it as
    // present-but-empty so placeholder resolution can tell "the key is here and
    // blank" apart from "the key is missing" — the two need different notes.
    else if (child === null) out.push([path, ''])
  }
  return out
}

/** A `*.url` / `*.host` config entry (or any k8s-DNS value) → name clue. */
/** True when the URL's host is an IP literal — a machine address, not a service name. */
function ipHostOf(value: string): boolean {
  const m = value.match(/^https?:\/\/([^/:?#]+)/i)
  if (!m) return false
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(m[1]!) || m[1]!.includes(':')
}

function configClue(entry: ConfigEntry): OutboundCall | null {
  const isUrlKey = KEY_URL_TAIL.test(entry.key)
  const isHostKey = KEY_HOST_TAIL.test(entry.key)
  const dns = k8sDnsTarget(entry.value)
  const valueTarget = dns ?? hostTarget(entry.value)
  if (!isUrlKey && !isHostKey && !dns) return null
  // A `*.url`/`*.host` key must actually hold an address to be a clue at all —
  // EXCEPT when the key itself names the service and the value is an HTTP(S)
  // URL. Real configs route through gateways (`feign-client-config.internal-base.url:
  // https://gw.example.com/12091/...`), whose host is not the service name;
  // the address test would drop every such entry and config-first scanning
  // would find nothing. The key segment (segment before the property) is the
  // declaration in that case; non-HTTP values (jdbc:, plain IPs, hostnames)
  // are still rejected.
  const looksHttp = /^https?:\/\//i.test(entry.value) && !ipHostOf(entry.value)
  if ((isUrlKey || isHostKey) && !valueTarget && !looksHttp) return null

  const keySegment = serviceSegmentBeforeProperty(entry.key)
  if (!valueTarget && !keySegment) return null
  const target = keySegment ?? valueTarget!
  const aliasList = [...new Set([valueTarget, keySegment].filter((v): v is string => typeof v === 'string' && v !== target))]
  return {
    path: '',
    target,
    ...(aliasList.length > 0 ? { targetAliases: aliasList } : {}),
    configKey: entry.key,
    ...(entry.value ? { baseUrl: entry.value } : {}),
    detail: `${entry.key} = ${entry.value}`,
    evidence: { file: entry.file, line: entry.line, kind: 'config' },
  }
}

/**
 * Feign clues: one name clue for the interface (the annotation itself is the
 * evidence) plus one call clue per interface method (path tier). Placeholder
 * keys are resolved against the local config index; an unresolvable value keeps
 * the key-derived name and carries the 「值未解析」/「前缀未解析」note instead of
 * being dropped (design D3).
 */
function feignClues(feign: FeignInterface, config: ConfigIndex): OutboundCall[] {
  const out: OutboundCall[] = []
  const attrs: Array<[string, string]> = []
  if (feign.nameAttr) attrs.push(['name', feign.nameAttr])
  if (feign.urlAttr) attrs.push(['url', feign.urlAttr])
  if (feign.pathAttr) attrs.push(['path', feign.pathAttr])

  const resolved = new Map<string, ConfigEntry>()
  const aliases = new Set<string>()
  let target = feign.nameLiteral
  let unresolvedPlaceholder = false
  /** Placeholder keys that are genuinely absent locally, for an accurate note. */
  const unresolvedKeys: string[] = []

  for (const [attr, raw] of attrs) {
    const key = placeholderKey(raw)
    if (!key) {
      if (attr === 'name') target ??= raw
      if (attr === 'url') {
        const host = hostTarget(raw)
        if (host) {
          target ??= host
          aliases.add(host)
        }
      }
      continue
    }
    target ??= serviceSegmentOfKey(key, attr)
    const entry = config.byKey.get(key)
    if (!entry) {
      unresolvedPlaceholder = true
      unresolvedKeys.push(key)
      continue
    }
    resolved.set(attr, entry)
    // An empty setting resolves to "present but blank" — no clue of its own.
    if (entry.value === '') continue
    out.push({
      path: '',
      ...(serviceSegmentOfKey(key, attr) ? { target: serviceSegmentOfKey(key, attr)! } : {}),
      configKey: key,
      baseUrl: entry.value,
      detail: `${key} = ${entry.value}`,
      evidence: { file: entry.file, line: entry.line, kind: 'config' },
    })
    const host = hostTarget(entry.value)
    if (host && attr !== 'path') aliases.add(host)
  }

  const nameKey = feign.nameAttr ? placeholderKey(feign.nameAttr) : undefined
  const urlValue = resolveAttrValue(feign.urlAttr, resolved.get('url'))
  const pathValue = resolveAttrValue(feign.pathAttr, resolved.get('path'))
  const prefixUnresolved = isUnresolvedPlaceholder(feign.pathAttr, config)
  const aliasList = [...aliases].filter((a) => a !== target)
  const urlPath = urlValue && isAbsoluteUrl(urlValue) ? normalizePath(urlValue.replace(/^https?:\/\/[^/]+/i, '')) : ''

  out.push({
    path: '',
    ...(target ? { target } : {}),
    ...(aliasList.length > 0 ? { targetAliases: aliasList } : {}),
    ...(nameKey ? { configKey: nameKey } : {}),
    ...(urlValue ? { baseUrl: urlValue } : {}),
    detail: feignDetail(feign),
    ...(unresolvedPlaceholder
      ? { note: `值未解析（本地配置中未找到 ${unresolvedKeys.join('、')}）` }
      : {}),
    evidence: { file: feign.file, line: feign.line, kind: 'feign' },
  })

  // Feign composes the effective call URL as `url` + `path` + method path, so
  // the prefix is the url's own path portion AND the `path` attribute — a blank
  // `path` must not discard the url-derived part (a `??` fallback would, since
  // `''` is not nullish, which silently shortened every call path).
  const prefix = joinPaths(urlPath, pathValue ?? '')
  // A `path` key that exists locally but is blank is RESOLVED-empty, not
  // unresolved: the effective call path is then just the method path. Say so,
  // rather than reporting a parse failure that did not happen.
  const pathKey = feign.pathAttr ? placeholderKey(feign.pathAttr) : undefined
  const pathBlank = pathKey !== undefined && config.byKey.get(pathKey)?.value === ''
  for (const mapping of feign.mappings) {
    const methodPath = normalizePath(mapping.path)
    const joined = prefix ? joinPaths(prefix, methodPath) : methodPath
    out.push({
      path: joined,
      ...(mapping.method ? { method: mapping.method } : {}),
      ...(target ? { target } : {}),
      ...(aliasList.length > 0 ? { targetAliases: aliasList } : {}),
      ...(nameKey ? { configKey: nameKey } : {}),
      ...(urlValue ? { baseUrl: urlValue } : {}),
      ...(prefixUnresolved ? { prefixUnresolved: true } : {}),
      detail: `@${mapping.method === undefined ? 'RequestMapping' : `${mapping.method[0]}${mapping.method.slice(1).toLowerCase()}Mapping`}("${mapping.path}")`,
      ...(prefixUnresolved
        ? { note: `前缀未解析（${feign.pathAttr ? placeholderKey(feign.pathAttr) ?? feign.pathAttr : 'path'} 未在本地配置中解析，仅按方法级路径匹配）` }
        : pathBlank
          ? { note: '前缀为空（配置中该 path 键未设值），仅按方法级路径匹配' }
          : {}),
      evidence: { file: feign.file, line: mapping.line, kind: 'feign' },
    })
  }
  return out
}

/** Attribute value: the resolved config entry, the literal, or undefined. */
function resolveAttrValue(raw: string | undefined, entry: ConfigEntry | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (!placeholderKey(raw)) return raw
  return entry?.value
}

/** True when the attribute is a `${…}` key with no local config value. */
function isUnresolvedPlaceholder(raw: string | undefined, config: ConfigIndex): boolean {
  if (raw === undefined) return false
  const key = placeholderKey(raw)
  return key !== undefined && !config.byKey.has(key)
}

function feignDetail(feign: FeignInterface): string {
  const parts: string[] = []
  if (feign.nameAttr) parts.push(`name = "${feign.nameAttr}"`)
  else if (feign.nameLiteral) parts.push(`"${feign.nameLiteral}"`)
  if (feign.urlAttr) parts.push(`url = "${feign.urlAttr}"`)
  if (feign.pathAttr) parts.push(`path = "${feign.pathAttr}"`)
  return `@FeignClient(${parts.join(', ')})`
}

function callClue(call: RawCall): OutboundCall {
  const origin = call.literal.match(/^https?:\/\/[^/\s"']+/i)?.[0]
  if (origin) {
    const host = hostTarget(call.literal)
    const path = normalizePath(call.literal.slice(origin.length))
    return {
      path,
      ...(call.method ? { method: call.method } : {}),
      ...(host ? { target: host } : {}),
      baseUrl: origin,
      detail: `${call.form} ${call.literal}`,
      evidence: { file: call.file, line: call.line, kind: 'call' },
    }
  }
  return {
    path: normalizePath(call.literal),
    ...(call.method ? { method: call.method } : {}),
    detail: `${call.form} ${call.literal}`,
    evidence: { file: call.file, line: call.line, kind: 'call' },
  }
}

// ---------------------------------------------------------------------------
// Shared helper exports (used by derive-dependencies.ts)
// ---------------------------------------------------------------------------

function dedupeClues(clues: OutboundCall[]): OutboundCall[] {
  const seen = new Set<string>()
  const out: OutboundCall[] = []
  for (const clue of clues) {
    const key = [
      clue.evidence.file,
      clue.evidence.line ?? '',
      clue.evidence.kind,
      clue.path,
      clue.target ?? '',
      clue.configKey ?? '',
    ].join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clue)
  }
  return out
}

/** `${key}` / `${key:default}` → `key`; a literal → undefined. */
export function placeholderKey(raw: string): string | undefined {
  const m = raw.trim().match(/^\$\{([^}]+)\}$/)
  if (!m) return undefined
  return m[1]!.split(':')[0]!.trim() || undefined
}

/**
 * The service-name segment of a (dotted) config/placeholder key:
 * `project.feign-client-config.internal-bc-es.name` → `internal-bc-es`.
 * `attr` is the attribute the placeholder came from (`name`/`url`/`path`), which
 * lets us drop that trailing property segment first.
 */
export function serviceSegmentOfKey(key: string, attr?: string): string | undefined {
  const segments = key.split('.').filter(Boolean)
  if (segments.length === 0) return undefined
  if (attr && segments[segments.length - 1]!.toLowerCase() === attr.toLowerCase()) segments.pop()
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments[i]!
    if (!isPlausibleServiceName(candidate)) continue
    if (GENERIC_KEY_SEGMENTS.has(candidate.toLowerCase())) continue
    return candidate
  }
  return undefined
}

function isPlausibleServiceName(name: string): boolean {
  if (name.length < 3 || name.length > 64) return false
  // Service names in Spring/k8s use dots and dashes; underscores are the mark of
  // env-var style keys (`USER_SERVICE_BASE_URL`), whose host value names the
  // callee far more reliably → those fall through to the host-derived name.
  if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(name)) return false
  return !/^\d+$/.test(name)
}

/** `USER_SERVICE_BASE_URL` / `BASE-URL` → lower-cased, dash-joined token. */
function normalizeKeyToken(token: string): string {
  return token.trim().toLowerCase().replace(/_/g, '-')
}

/**
 * The service-name segment that sits immediately before a config key's property
 * segment: `internal-homework.base-url` → `internal-homework` (also works for the
 * `project.feign-client-config.internal-bc-es.url` and nested
 * `order-service.BASE_URL` shapes).
 *
 * Deliberately strict — it never searches further left than one segment. A
 * container path such as `services.app.environment.USER_SERVICE_URL` therefore
 * yields nothing (rather than a bogus target named `environment`), and those
 * env-style keys name the callee in their VALUE via `hostTarget`.
 */
export function serviceSegmentBeforeProperty(key: string): string | undefined {
  const segments = key.split('.').filter(Boolean)
  if (segments.length < 2) return undefined
  if (!CONFIG_PROPERTY_NAMES.has(normalizeKeyToken(segments[segments.length - 1]!))) return undefined
  const candidate = segments[segments.length - 2]!
  if (!isPlausibleServiceName(candidate)) return undefined
  if (GENERIC_KEY_SEGMENTS.has(candidate.toLowerCase())) return undefined
  return candidate
}

/**
 * Target name from an address: `http://internal-bc-es:8080` → `internal-bc-es`,
 * `svc.ns.svc.cluster.local` → `svc`. External FQDNs, IPs and infrastructure
 * hosts yield nothing (design risk note: no fuzzy guessing).
 */
export function hostTarget(value: string): string | undefined {
  if (!value) return undefined
  const url = value.match(/https?:\/\/([^/:\s"']+)/i)
  const bare = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/.test(value.trim()) ? value.trim() : undefined
  const raw = url ? url[1]! : bare
  if (!raw) return undefined
  const host = raw.replace(/:\d+$/, '').toLowerCase()
  if (!host || host.includes(':')) return undefined
  if (/^\d+(\.\d+){3}$/.test(host) || /^\d+$/.test(host)) return undefined
  if (HOST_DENYLIST.has(host)) return undefined
  if (!isPlausibleServiceName(host)) return undefined
  const labels = host.split('.').filter(Boolean)
  if (labels.length === 1) return host
  if (labels.indexOf('svc') > 0) return labels[0]
  if (labels.length === 2 && ['local', 'internal', 'lan', 'cluster'].includes(labels[1]!)) return labels[0]
  return undefined
}

/** `<svc>.<ns>.svc.cluster.local` anywhere in a value → target name. */
export function k8sDnsTarget(value: string): string | undefined {
  const m = value.match(/\b([a-z0-9][a-z0-9-]*)\.([a-z0-9-]+)\.svc(?:\.cluster\.local)?\b/i)
  if (!m) return undefined
  const host = m[1]!.toLowerCase()
  return HOST_DENYLIST.has(host) ? undefined : host
}

export function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

/** Leading slash, collapsed duplicate slashes, no trailing slash (root stays `/`). */
export function normalizePath(path: string): string {
  let p = (path ?? '').trim()
  if (p === '') return ''
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p === '' ? '/' : p
}

function joinPaths(base: string, sub: string): string {
  const b = normalizePath(base)
  const s = normalizePath(sub)
  return normalizePath(`${b === '/' ? '' : b}${s === '/' ? '' : s}`) || '/'
}

/** Path segments, used by the derivation layer's endpoint-shape comparison. */
export function pathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean)
}
