#!/usr/bin/env node
/**
 * Helmsman DSH toolchain governance check.
 *
 * Single authoritative source for every declared version of Helmsman's
 * verified DSH toolchain is the root `toolchain.json`. This script makes that
 * manifest checkable and fails fast on drift:
 *
 *   --structural                validate manifest shape, internal consistency,
 *                               cross-check the prose docs (WORKBENCH-SETUP,
 *                               DISTRIBUTION) and the committed
 *                               docs/COMPATIBILITY.md against the manifest.
 *   --live --profile <name>     compare the installed state of a real DSH
 *                               profile (default "web") against the manifest:
 *                               community plugins, @deepseek-ai kernel
 *                               packages, and the running Node/pnpm engines.
 *   --generate-compat           write docs/COMPATIBILITY.md from the manifest
 *                               (deterministic). docs/COMPATIBILITY.md must
 *                               always equal this output.
 *
 * Exit codes: 0 = OK, 1 = mismatch/drift, 2 = usage or environment error.
 * Zero runtime dependencies (Node >= 22). English CLI output.
 *
 * Cross-checks that need the full repo (Helmsman packages, bundle patch) are
 * only enabled when the manifest sits in the repository root, so tests can run
 * against a minimal fixture tree.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXIT_OK = 0
export const EXIT_MISMATCH = 1
export const EXIT_ENV = 2

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const DEFAULT_MANIFEST = 'toolchain.json'
export const DEFAULT_DOCS = ['docs/WORKBENCH-SETUP.md', 'docs/DISTRIBUTION.md']
export const DEFAULT_COMPAT = 'docs/COMPATIBILITY.md'
const BUNDLE_PATCH = join('packages', 'bundle', 'cordis.patch.yml')

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    profile: null,
    manifest: null,
    docs: null,
    compat: null,
    structural: false,
    live: false,
    generateCompat: false,
    verbose: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`option ${arg} requires a value`)
      return argv[++i]
    }
    switch (arg) {
      case '--structural':
        opts.structural = true
        break
      case '--live':
        opts.live = true
        break
      case '--generate-compat':
        opts.generateCompat = true
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--profile':
        opts.profile = next()
        break
      case '--manifest':
        opts.manifest = next()
        break
      case '--docs':
        opts.docs = next().split(',').map((s) => s.trim()).filter(Boolean)
        break
      case '--compat':
        opts.compat = next()
        break
      case '-h':
      case '--help':
        throw new HelpRequested()
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
        positional.push(arg)
    }
  }
  if (positional.length > 0) throw new Error(`unexpected positional arguments: ${positional.join(' ')}`)
  if (!opts.structural && !opts.live && !opts.generateCompat) {
    throw new Error('no mode selected; use --structural, --live and/or --generate-compat')
  }
  return opts
}

class HelpRequested extends Error {}

const USAGE = `usage: node scripts/check-toolchain.mjs <mode> [options]

modes (combinable):
  --structural            validate toolchain.json, cross-check docs and the
                          committed docs/COMPATIBILITY.md (exit 1 on drift)
  --live --profile <n>    compare an installed DSH profile (default: web) to
                          the manifest (community plugins, kernel, engines)
  --generate-compat       regenerate docs/COMPATIBILITY.md from toolchain.json

options:
  --manifest <path>       manifest path (default: <repo root>/toolchain.json)
  --docs <a.md,b.md>      docs to cross-check instead of WORKBENCH-SETUP/DISTRIBUTION
  --compat <path>         compatibility doc path (default: docs/COMPATIBILITY.md)
  --verbose               extra detail
  -h, --help              show this help

exit codes: 0 OK, 1 mismatch/drift, 2 usage/environment error
`

// ---------------------------------------------------------------------------
// Version helpers (zero-dependency semver subset, no ranges with wildcards)
// ---------------------------------------------------------------------------

/** @returns {{core:[number,number,number], pre:string|null, raw:string}|null} */
export function parseVersion(str) {
  if (typeof str !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/.exec(str.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? null,
    raw: str.trim(),
  }
}

/** @returns {number} negative/0/positive. */
function compareCore(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function compareVersions(a, b) {
  const c = compareCore(a.core, b.core)
  if (c !== 0) return c
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1 // release > prerelease
  if (b.pre === null) return -1
  const aIds = a.pre.split('.')
  const bIds = b.pre.split('.')
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i++) {
    if (i >= aIds.length) return -1
    if (i >= bIds.length) return 1
    const x = aIds[i]
    const y = bIds[i]
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (xn !== yn) {
      return xn ? -1 : 1 // numeric identifiers sort lower
    } else {
      const d = x.localeCompare(y)
      if (d !== 0) return d
    }
  }
  return 0
}

/** Loose equality: same release core + same prerelease identifiers. */
export function versionsEqual(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  if (compareCore(pa.core, pb.core) !== 0) return false
  if (pa.pre === null || pb.pre === null) return pa.pre === pb.pre
  const aPre = pa.pre.split('.')
  const bPre = pb.pre.split('.')
  return aPre.length === bPre.length && aPre.every((id, i) => id === bPre[i])
}

const ALLOWED_OPS = ['^', '~', '>=', '<=', '>', '<', '=', '']

/** Parse a comparator such as `^22.19`, `>=24`, `~1.2.3`. */
function parseComparator(tok) {
  const m = /^(?<op>\^|~|>=|<=|>|<|=)?(?<v>\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/.exec(tok.trim())
  if (!m) return null
  const op = m.groups.op ?? '='
  if (!ALLOWED_OPS.includes(op)) return null
  const parts = m.groups.v.split('.').map((s, i) => (i === 3 ? s : Number(s)))
  return { op, parts }
}

/** Expand a comparator into lower/upper version bounds (null = unbounded). */
function comparatorBounds(c) {
  const core = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    if (typeof c.parts[i] === 'number') core[i] = c.parts[i]
  }
  const lower = (v) => ({ core: [...v], pre: null })
  const bump = (i) => {
    const v = [...core]
    v[i] += 1
    for (let j = i + 1; j < 3; j++) v[j] = 0
    return v
  }
  switch (c.op) {
    case '^': {
      const [x, y] = [core[0], core[1]]
      const upper = x > 0 ? bump(0) : y > 0 ? bump(1) : bump(2)
      return { lower: lower(core), upper: lower(upper) }
    }
    case '~': {
      const hasMinor = typeof c.parts[1] === 'number'
      const upper = hasMinor ? bump(1) : bump(0)
      return { lower: lower(core), upper: lower(upper) }
    }
    case '>=':
      return { lower: lower(core), upper: null }
    case '>':
      return { lower: lower([...core].map((n, i) => (i === 2 ? n + 1 : n))), upper: null }
    case '<=':
      return { lower: null, upper: lower(core) }
    case '<':
      return { lower: null, upper: lower(core) }
    case '=':
    case '':
    default:
      return { lower: lower(core), upper: lower(core) }
  }
}

/**
 * Does `version` satisfy `range` (space/`||` separated comparators)?
 * Supports the subset of npm ranges the repo pins: ^ ~ >= <= > < = and ||
 * over dotted (possibly partial) versions. Never wildcard `*`/`x`.
 * @returns {boolean}
 */
export function satisfiesRange(range, version) {
  const v = parseVersion(version)
  if (!v) return false
  for (const alt of String(range).split('||')) {
    const tokens = alt.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    let ok = true
    for (const tok of tokens) {
      const c = parseComparator(tok)
      if (!c) return false // unsupported comparator -> treat range as unsatisfiable
      const { lower, upper } = comparatorBounds(c)
      if (lower && compareVersions(v, lower) < 0) { ok = false; break }
      if (upper && compareVersions(v, upper) >= 0) { ok = false; break }
    }
    if (ok) return true
  }
  return false
}

/** Confirm a range only uses operators this script understands. */
export function isSupportedRange(range) {
  for (const alt of String(range).split('||')) {
    for (const tok of alt.trim().split(/\s+/).filter(Boolean)) {
      if (parseComparator(tok) === null) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Manifest model helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/** The components the docs are allowed to mention (they carry a version). */
function docComponents(manifest) {
  const out = []
  const harness = manifest?.platform?.harness
  if (harness && isNonEmptyString(harness.version)) {
    out.push({ kind: 'platform', name: harness.name, aliases: [harness.name, 'deepseek-harness', 'harness'], version: harness.version })
  }
  for (const [pkgName, entry] of Object.entries(manifest?.kernel ?? {})) {
    if (isNonEmptyString(entry?.version)) {
      const unscoped = pkgName.replace(/^@[^/]+\//, '')
      out.push({ kind: 'kernel', name: pkgName, aliases: [pkgName, unscoped], version: entry.version })
    }
  }
  for (const plugin of manifest?.plugins?.community ?? []) {
    if (!isNonEmptyString(plugin?.name) || !isNonEmptyString(plugin.version)) continue
    const unscoped = plugin.name.replace(/^@[^/]+\//, '')
    out.push({
      kind: 'community',
      name: plugin.name,
      aliases: [...new Set([plugin.name, unscoped])],
      version: plugin.version,
    })
  }
  for (const plugin of manifest?.helmsman?.plugins ?? []) {
    if (!isNonEmptyString(plugin?.name) || !isNonEmptyString(plugin.version)) continue
    const base = plugin.name.replace(/^@helmsman\//, '')
    const unscoped = plugin.name.replace(/^@[^/]+\//, '')
    out.push({
      kind: 'helmsman',
      name: plugin.name,
      aliases: [...new Set([plugin.name, `helmsman-${base}`, base])],
      version: plugin.version,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

export function validateManifestSchema(manifest) {
  const problems = []
  const section = (key) => {
    if (!(key in manifest)) problems.push(`missing required top-level section "${key}"`)
    return manifest[key]
  }
  const platform = section('platform')
  const kernel = section('kernel')
  const plugins = section('plugins')
  const engines = section('engines')
  const helmsman = section('helmsman')
  const knownIssues = section('knownIssues')
  if (problems.length > 0) return problems

  // platform
  if (!platform || typeof platform !== 'object') {
    problems.push('platform must be an object')
  } else {
    const harness = platform.harness
    if (!harness || typeof harness !== 'object') {
      problems.push('platform.harness is required')
    } else {
      for (const f of ['name', 'version', 'source']) {
        if (!isNonEmptyString(harness[f])) problems.push(`platform.harness.${f} must be a non-empty string`)
      }
      if (isNonEmptyString(harness.version) && !parseVersion(harness.version)) {
        problems.push(`platform.harness.version "${harness.version}" is not a semver version`)
      }
    }
  }

  // kernel
  if (!kernel || typeof kernel !== 'object' || Array.isArray(kernel)) {
    problems.push('kernel must be an object keyed by package name')
  } else {
    for (const required of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
      if (!(required in kernel)) problems.push(`kernel.${required} is required`)
    }
    for (const [pkg, entry] of Object.entries(kernel)) {
      if (!entry || typeof entry !== 'object') {
        problems.push(`kernel.${pkg} must be an object`)
        continue
      }
      if (!ALLOWED_KINDS.includes(entry.kind)) problems.push(`kernel.${pkg}.kind must be one of ${ALLOWED_KINDS.join(', ')}`)
      if (entry.kind === 'pinned' && !isNonEmptyString(entry.version)) {
        problems.push(`kernel.${pkg} (kind=pinned) needs a version`)
      } else if (entry.kind === 'peer' && !isNonEmptyString(entry.requirement)) {
        problems.push(`kernel.${pkg} (kind=peer) needs a requirement`)
      }
      if (isNonEmptyString(entry.version) && !parseVersion(entry.version)) {
        problems.push(`kernel.${pkg}.version "${entry.version}" is not a semver version`)
      }
    }
  }

  // plugins.community
  if (!plugins || typeof plugins !== 'object' || !Array.isArray(plugins.community)) {
    problems.push('plugins.community must be an array')
  } else {
    if (plugins.community.length === 0) problems.push('plugins.community must not be empty')
    for (const [i, p] of plugins.community.entries()) {
      const at = `plugins.community[${i}]`
      if (!p || typeof p !== 'object') {
        problems.push(`${at} must be an object`)
        continue
      }
      for (const f of ['name', 'version', 'source']) {
        if (!isNonEmptyString(p[f])) problems.push(`${at}.${f} must be a non-empty string`)
      }
      if (isNonEmptyString(p.version) && !parseVersion(p.version)) {
        problems.push(`${at}.version "${p.version}" is not a semver version`)
      }
      if (p.group !== undefined && !['workbench', 'reused'].includes(p.group)) {
        problems.push(`${at}.group must be "workbench" or "reused"`)
      }
      if (p.optional !== undefined && typeof p.optional !== 'boolean') {
        problems.push(`${at}.optional must be a boolean`)
      }
    }
  }

  // engines
  if (!engines || typeof engines !== 'object') {
    problems.push('engines must be an object')
  } else {
    for (const tool of ['node', 'pnpm']) {
      if (!isNonEmptyString(engines[tool])) {
        problems.push(`engines.${tool} must be a non-empty range string`)
      } else if (!isSupportedRange(engines[tool])) {
        problems.push(`engines.${tool} range "${engines[tool]}" uses unsupported operators (allowed: ^ ~ >= <= > < = and ||)`)
      }
    }
  }

  // helmsman
  if (!helmsman || typeof helmsman !== 'object') {
    problems.push('helmsman must be an object')
  } else {
    const bundle = helmsman.bundle
    if (!bundle || typeof bundle !== 'object') {
      problems.push('helmsman.bundle is required')
    } else {
      for (const f of ['name', 'version', 'source']) {
        if (!isNonEmptyString(bundle[f])) problems.push(`helmsman.bundle.${f} must be a non-empty string`)
      }
    }
    if (!Array.isArray(helmsman.plugins) || helmsman.plugins.length === 0) {
      problems.push('helmsman.plugins must be a non-empty array')
    } else {
      for (const [i, p] of helmsman.plugins.entries()) {
        const at = `helmsman.plugins[${i}]`
        if (!p || typeof p !== 'object') {
          problems.push(`${at} must be an object`)
          continue
        }
        for (const f of ['name', 'version', 'source']) {
          if (!isNonEmptyString(p[f])) problems.push(`${at}.${f} must be a non-empty string`)
        }
        if (isNonEmptyString(p.name) && !p.name.startsWith('@helmsman/')) {
          problems.push(`${at}.name should be an @helmsman/* package (got "${p.name}")`)
        }
        if (isNonEmptyString(p.version) && !parseVersion(p.version)) {
          problems.push(`${at}.version "${p.version}" is not a semver version`)
        }
      }
    }
  }

  // knownIssues
  if (!Array.isArray(knownIssues)) {
    problems.push('knownIssues must be an array')
  } else {
    for (const [i, issue] of knownIssues.entries()) {
      if (!issue || typeof issue !== 'object') {
        problems.push(`knownIssues[${i}] must be an object`)
        continue
      }
      if (!isNonEmptyString(issue.id)) problems.push(`knownIssues[${i}].id must be a non-empty string`)
      if (!isNonEmptyString(issue.summary)) problems.push(`knownIssues[${i}].summary must be a non-empty string`)
      if (issue.affected !== undefined && !Array.isArray(issue.affected)) {
        problems.push(`knownIssues[${i}].affected must be an array`)
      }
    }
  }
  return problems
}
const ALLOWED_KINDS = ['peer', 'pinned']

export function validateInternalConsistency(manifest) {
  const problems = []
  const lists = []
  if (Array.isArray(manifest?.plugins?.community)) {
    lists.push(['community plugins', manifest.plugins.community, true])
  }
  if (Array.isArray(manifest?.helmsman?.plugins)) {
    lists.push(['helmsman plugins', manifest.helmsman.plugins, false])
  }
  const seenNames = new Set()
  for (const [label, list, versionsUnique] of lists) {
    const versions = new Map()
    const names = new Set()
    for (const [i, p] of list.entries()) {
      if (!p || !isNonEmptyString(p.name)) continue
      if (names.has(p.name)) {
        problems.push(`${label} duplicate name "${p.name}" (entries ${[...names].indexOf(p.name)} and ${i})`)
      }
      names.add(p.name)
      if (seenNames.has(p.name)) {
        problems.push(`"${p.name}" is listed more than once across manifest sections`)
      }
      seenNames.add(p.name)
      if (versionsUnique && p.version !== undefined) {
        if (versions.has(p.version)) {
          problems.push(`${label}: two plugins claim the same version "${p.version}" (${versions.get(p.version)} and ${p.name})`)
        }
        versions.set(p.version, p.name)
      }
    }
  }
  // kernel and community lists may not overlap.
  for (const p of manifest?.plugins?.community ?? []) {
    if (manifest?.kernel && p.name in manifest.kernel) {
      problems.push(`"${p.name}" appears in both kernel and plugins.community`)
    }
  }
  // The known-good profile must not pin the broken rc line described as broken.
  return problems
}

// ---------------------------------------------------------------------------
// Doc cross-check: any version string in the prose docs that contradicts the
// manifest is a manifest violation (prose must not pin a different version).
// ---------------------------------------------------------------------------

const VERSION_TOKEN_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?/g
// Engine requirement comparators as a doc would state them. `=`/bare `<`/`>`
// are left out: `exit=0`-style prose would otherwise be read as a version.
const COMPARATOR_TOKEN_RE = /(>=|<=|\^|~|≥|≤)\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/g

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAlias(line, aliases) {
  // Longest alias wins so a scoped name shadows its unscoped form.
  let best = null
  for (const alias of aliases) {
    if (!alias) continue
    const idx = line.indexOf(alias)
    if (idx === -1) continue
    if (best === null || alias.length > best.alias.length) best = { alias, idx }
  }
  return best
}

function comparatorList(rangeStr) {
  const out = []
  for (const alt of String(rangeStr).split('||')) {
    for (const tok of alt.trim().split(/\s+/).filter(Boolean)) {
      const c = parseComparator(tok)
      if (c) out.push(normalizeComparator(c))
    }
  }
  return out.sort()
}

function normalizeComparator(c) {
  return `${c.op}${c.parts.slice(0, 3).map((p) => (typeof p === 'number' ? String(p) : '')).filter(Boolean).join('.')}`
}

/**
 * @param {string} docText full document text
 * @param {string} docName short label for error messages
 * @param {object} manifest parsed manifest
 * @returns {string[]} problems
 */
export function crossCheckDoc(docText, docName, manifest) {
  const problems = []
  const components = docComponents(manifest)
  const lines = docText.split(/\r?\n/)

  for (const [idx, rawLine] of lines.entries()) {
    const lineNo = idx + 1
    const line = rawLine

    // 1) versioned components (plugins, kernel pins, harness)
    const tokens = []
    for (const m of line.matchAll(VERSION_TOKEN_RE)) tokens.push({ raw: m[0], index: m.index })
    if (tokens.length > 0) {
      for (const comp of components) {
        const hit = findAlias(line, comp.aliases)
        if (!hit) continue
        const claim = tokens.filter((t) => t.index >= hit.idx - 8)
        if (claim.length === 0) continue
        const matches = claim.some((t) => versionsEqual(t.raw, comp.version))
        if (!matches) {
          problems.push(
            `${docName}:${lineNo}: version for "${comp.name}" contradicts toolchain.json ` +
            `(expected ${comp.version}, found ${claim.map((t) => t.raw).join(', ')})`,
          )
        }
      }
    }

    // 2) engines: a doc line that restates a Node/pnpm requirement must state
    // exactly the manifest's constraint for that tool. The scan is windowed
    // from the tool keyword to the next tool keyword or punctuation delimiter
    // so `pnpm ≥10` next to `Node ^22.19` stays attributed to pnpm.
    for (const tool of ['node', 'pnpm']) {
      const engineRange = manifest?.engines?.[tool]
      if (!isNonEmptyString(engineRange)) continue
      const kw = findAlias(line, tool === 'node' ? ['node', 'Node'] : ['pnpm'])
      if (!kw) continue
      const windowStart = kw.idx + kw.alias.length
      const re = tool === 'node' ? /\bnode\b/gi : /\bpnpm\b/gi
      let next = line.length
      re.lastIndex = windowStart
      const nxt = re.exec(line)
      if (nxt) next = Math.min(next, nxt.index)
      const delim = /[、，,;；。]/g
      delim.lastIndex = windowStart
      const d = delim.exec(line)
      if (d) next = Math.min(next, d.index)
      const slice = line.slice(windowStart, next)
      const comps = []
      for (const m of slice.matchAll(COMPARATOR_TOKEN_RE)) {
        const op = m[1] === '≥' ? '>=' : m[1] === '≤' ? '<=' : m[1]
        const c = parseComparator(`${op}${m[2]}`)
        if (c) comps.push(normalizeComparator(c))
      }
      if (comps.length === 0) continue
      const expected = comparatorList(engineRange)
      comps.sort()
      if (JSON.stringify(comps) !== JSON.stringify(expected)) {
        problems.push(
          `${docName}:${lineNo}: ${tool} engine constraint contradicts toolchain.json ` +
          `(expected "${engineRange}", found ${comps.join(', ') || '(none)'})`,
        )
      }
    }
  }
  return problems
}

/** @returns {{problems: string[], notes: string[]}} */
export function structuralValidate(root, manifest, { compatPath } = {}) {
  const problems = []
  const notes = []
  problems.push(...validateManifestSchema(manifest))
  problems.push(...validateInternalConsistency(manifest))

  // Prose docs cross-check.
  for (const rel of DEFAULT_DOCS) {
    const file = join(root, rel)
    if (!existsSync(file)) {
      problems.push(`cross-check target missing: ${rel}`)
      continue
    }
    const docName = rel.replace(/^docs\//, '')
    problems.push(...crossCheckDoc(readFileSync(file, 'utf8'), docName, manifest))
  }

  // packages/bundle/cordis.patch.yml + packages/<dir>/package.json cross-check
  // (only meaningful inside the monorepo).
  const packagesDir = join(root, 'packages')
  if (existsSync(packagesDir)) {
    const patchFile = join(root, BUNDLE_PATCH)
    if (!existsSync(patchFile)) {
      problems.push(`cross-check target missing: ${BUNDLE_PATCH}`)
    } else {
      const patchNames = extractBundleNames(readFileSync(patchFile, 'utf8'))
      const manifestNames = new Set((manifest?.helmsman?.plugins ?? []).map((p) => p.name))
      for (const n of manifestNames) {
        if (!patchNames.has(n)) problems.push(`helmsman plugin "${n}" is missing from ${BUNDLE_PATCH}`)
      }
      for (const n of patchNames) {
        if (!manifestNames.has(n)) problems.push(`${BUNDLE_PATCH} lists "${n}" which is absent from toolchain.json helmsman.plugins`)
      }
    }
    for (const p of manifest?.helmsman?.plugins ?? []) {
      const manifestFile = join(packagesDir, p.dir ?? p.name.replace(/^@helmsman\//, ''), 'package.json')
      if (!existsSync(manifestFile)) {
        notes.push(`skipped package.json cross-check for ${p.name}: ${manifestFile} not found`)
        continue
      }
      let pkg = null
      try {
        pkg = JSON.parse(readFileSync(manifestFile, 'utf8'))
      } catch {
        problems.push(`could not parse ${manifestFile}`)
        continue
      }
      if (pkg.name !== p.name) {
        problems.push(`${manifestFile} name "${pkg.name}" differs from manifest "${p.name}"`)
      }
      if (!versionsEqual(pkg.version, p.version)) {
        problems.push(`${manifestFile} version "${pkg.version}" differs from manifest "${p.version}" for ${p.name}`)
      }
    }

    // Every @helmsman/* package must be mountable as a profile bundle: DSH
    // refuses to boot when a bundle entry lacks `dsh.bundle.patch`, and the
    // published tarball loses the bundle layer when files[] omits the patch.
    // Neither defect is reachable from unit tests — they only appear once the
    // package is really installed into a profile — so check it here.
    for (const dirEntry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirEntry.isDirectory()) continue
      const pkgFile = join(packagesDir, dirEntry.name, 'package.json')
      if (!existsSync(pkgFile)) continue
      let pkg = null
      try {
        pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      } catch {
        problems.push(`could not parse ${pkgFile}`)
        continue
      }
      if (!String(pkg.name ?? '').startsWith('@helmsman/')) continue
      const rel = pkg.dsh?.bundle?.patch
      if (typeof rel !== 'string' || rel.length === 0) {
        problems.push(
          `packages/${dirEntry.name}/package.json (${pkg.name}) declares no dsh.bundle.patch — a profile referencing it refuses to boot`,
        )
        continue
      }
      const patchBase = rel.replace(/^\.\//, '')
      if (!existsSync(join(packagesDir, dirEntry.name, patchBase))) {
        problems.push(`packages/${dirEntry.name}/${patchBase} is referenced by dsh.bundle.patch but does not exist`)
      }
      const files = Array.isArray(pkg.files) ? pkg.files : []
      if (!files.includes(patchBase)) {
        problems.push(
          `packages/${dirEntry.name}/package.json files[] omits "${patchBase}" — the packed tarball would lose its bundle layer`,
        )
      }
    }
  } else {
    notes.push('no packages/ directory under the manifest root — monorepo cross-checks skipped')
  }

  // docs/COMPATIBILITY.md must equal the deterministic generator output.
  const compatFile = compatPath ?? join(root, DEFAULT_COMPAT)
  const generated = renderCompatMarkdown(manifest)
  if (!existsSync(compatFile)) {
    problems.push(`${DEFAULT_COMPAT} is missing; regenerate with: node scripts/check-toolchain.mjs --generate-compat`)
  } else if (readFileSync(compatFile, 'utf8') !== generated) {
    problems.push(`${DEFAULT_COMPAT} has drifted from toolchain.json; regenerate with: node scripts/check-toolchain.mjs --generate-compat`)
  }
  return { problems, notes }
}

function extractBundleNames(patchText) {
  const names = new Set()
  for (const m of patchText.matchAll(/name:\s*'(@helmsman\/[a-z0-9-]+)'/g)) names.add(m[1])
  return names
}

// ---------------------------------------------------------------------------
// docs/COMPATIBILITY.md generation (deterministic)
// ---------------------------------------------------------------------------

export function renderCompatMarkdown(manifest) {
  const L = []
  const push = (s = '') => L.push(s)
  const esc = (s) => String(s ?? '')
  push('# Helmsman DSH Toolchain Compatibility')
  push()
  push('> AUTO-GENERATED from `toolchain.json` — do not edit by hand.')
  push('> Regenerate with: `node scripts/check-toolchain.mjs --generate-compat`')
  push('> This file must always equal that generator output; `--structural` enforces it.')
  push()
  push('Records the known-good ("verified") and known-broken version combinations for the DSH workbench used by Helmsman. The only authoritative source of versions is the root `toolchain.json`; this document and the setup guides must not contradict it.')

  // platform
  const h = manifest.platform?.harness
  push()
  push('## Verified toolchain')
  push()
  push('### DSH platform')
  push()
  push('| component | version | source |')
  push('|---|---|---|')
  push(`| ${esc(h?.name)} | ${esc(h?.version)} | ${esc(h?.source)} |`)
  if (h?.note) {
    push()
    push(`Note: ${esc(h.note)}`)
  }

  // kernel
  const kernel = manifest.kernel ?? {}
  push()
  push('### @deepseek-ai kernel')
  push()
  push('| package | kind | pinned version / peer requirement |')
  push('|---|---|---|')
  for (const [name, entry] of Object.entries(kernel)) {
    const val = entry.kind === 'pinned' ? esc(entry.version) : esc(entry.requirement)
    push(`| ${esc(name)} | ${esc(entry.kind)} | ${val} |`)
  }

  // community plugins
  const community = manifest.plugins?.community ?? []
  const workbench = community.filter((p) => p.group !== 'reused')
  const reused = community.filter((p) => p.group === 'reused')
  push()
  push('### Community plugins — workbench (required in the profile)')
  push()
  push('| plugin | version | source (`dsh plugin add`) |')
  push('|---|---|---|')
  for (const p of workbench) push(`| ${esc(p.name)} | ${esc(p.version)} | ${esc(p.source)} |`)
  push()
  push('### Community plugins — reused by Helmsman (optional, feature-scoped)')
  push()
  push('| plugin | version | source (`dsh plugin add`) |')
  push('|---|---|---|')
  for (const p of reused) push(`| ${esc(p.name)} | ${esc(p.version)} | ${esc(p.source)} |`)

  // helmsman
  push()
  push('### Helmsman self plugins')
  push()
  const bundle = manifest.helmsman?.bundle
  if (bundle) {
    push('Bundle (installs the whole tree; not a layer itself):')
    push()
    push(`| package | version | source |`)
    push(`|---|---|---|`)
    push(`| ${esc(bundle.name)} | ${esc(bundle.version)} | ${esc(bundle.source)} |`)
  }
  const self = manifest.helmsman?.plugins ?? []
  push()
  push(`Layers (${self.length} plugins):`)
  push()
  push('| package | version | source |')
  push('|---|---|---|')
  for (const p of self) push(`| ${esc(p.name)} | ${esc(p.version)} | ${esc(p.source)} |`)

  // engines
  push()
  push('### Toolchain engines')
  push()
  push('| tool | constraint |')
  push('|---|---|')
  for (const [tool, range] of Object.entries(manifest.engines ?? {})) push(`| ${esc(tool)} | ${esc(range)} |`)

  // knownIssues
  const issues = manifest.knownIssues ?? []
  push()
  push('## Known issues')
  push()
  if (issues.length === 0) {
    push('_None recorded._')
  }
  for (const issue of issues) {
    push(`### ${esc(issue.id)} — ${esc(issue.summary)}`)
    push()
    push(esc(issue.detail))
    if (issue.symptom) {
      push()
      push(`Symptom: \`${esc(issue.symptom)}\``)
    }
    if (Array.isArray(issue.affected) && issue.affected.length > 0) {
      push()
      push(`Affected: ${issue.affected.map((a) => `\`${esc(a)}\``).join(', ')}`)
    }
    if (issue.resolution) {
      push()
      push(`Resolution: ${esc(issue.resolution)}`)
    }
    push()
  }
  return `${L.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Live profile comparison
// ---------------------------------------------------------------------------

export function defaultProfileDir(profile) {
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/** Parse `pnpm list --json` into name -> installed version (recursively). */
export function flattenPnpmList(json) {
  const installed = new Map()
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return { installed, error: 'could not parse pnpm list --json output' }
  }
  // pnpm list nodes are keyed by package name; only the root entry carries
  // `name`, nested entries do not. Thread the key down as we recurse.
  const walk = (node, name) => {
    if (!node || typeof node !== 'object') return
    if (typeof name === 'string' && typeof node.version === 'string') {
      installed.set(name, node.version)
    }
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = node[key]
      if (deps && typeof deps === 'object') {
        for (const [childName, child] of Object.entries(deps)) walk(child, childName)
      }
    }
  }
  if (Array.isArray(data)) {
    for (const entry of data) walk(entry, entry?.name)
  } else {
    walk(data, data?.name)
  }
  return { installed, error: null }
}

/**
 * Compare a manifest against an installed profile snapshot.
 * @returns {{diffs: {name:string, kind:string, expected:string, actual:string}[],
 *            notes: string[]}}
 */
export function liveDiff(manifest, installed, { nodeVersion, pnpmVersion } = {}) {
  const diffs = []
  const notes = []
  // Engines.
  if (nodeVersion !== undefined && pnpmVersion !== undefined) {
    const node = String(nodeVersion).replace(/^v/, '')
    if (manifest?.engines?.node && !satisfiesRange(manifest.engines.node, node)) {
      diffs.push({ name: 'node', kind: 'engine', expected: manifest.engines.node, actual: node })
    }
    const pnpm = String(pnpmVersion)
    if (manifest?.engines?.pnpm && !satisfiesRange(manifest.engines.pnpm, pnpm)) {
      diffs.push({ name: 'pnpm', kind: 'engine', expected: manifest.engines.pnpm, actual: pnpm })
    }
  } else {
    notes.push('liveDiff: engine versions not provided — skipping engine comparison')
  }

  // Community plugins.
  for (const p of manifest?.plugins?.community ?? []) {
    const actual = installed.get(p.name)
    if (actual === undefined) {
      if (p.optional) {
        notes.push(`optional community plugin ${p.name} is not installed (feature-scoped reuse; skipping)`)
      } else {
        diffs.push({ name: p.name, kind: 'community', expected: p.version, actual: 'not installed' })
      }
      continue
    }
    if (actual.startsWith('link:')) {
      notes.push(`${p.name} is installed from a link (${actual}) — exact version validated by the monorepo build, not here`)
      continue
    }
    if (!versionsEqual(actual, p.version)) {
      diffs.push({ name: p.name, kind: 'community', expected: p.version, actual })
    }
  }

  // Kernel.
  for (const [pkg, entry] of Object.entries(manifest?.kernel ?? {})) {
    const actual = installed.get(pkg)
    if (entry.kind === 'pinned') {
      if (actual === undefined) {
        diffs.push({ name: pkg, kind: 'kernel', expected: entry.version, actual: 'not installed' })
      } else if (!actual.startsWith('link:') && !versionsEqual(actual, entry.version)) {
        diffs.push({ name: pkg, kind: 'kernel', expected: entry.version, actual })
      }
    } else if (entry.kind === 'peer') {
      if (actual === undefined) {
        notes.push(`peer kernel ${pkg} is not a profile dependency (resolved from the host harness at runtime)`)
      } else if (actual.startsWith('link:')) {
        notes.push(`peer kernel ${pkg} resolves from a link (${actual})`)
      } else {
        notes.push(`peer kernel ${pkg} present at ${actual}`)
      }
    }
  }

  // Helmsman self plugins (presence + exact version when resolvable).
  for (const p of manifest?.helmsman?.plugins ?? []) {
    const actual = installed.get(p.name)
    if (actual === undefined) {
      diffs.push({ name: p.name, kind: 'helmsman', expected: `installed (${p.version})`, actual: 'not installed' })
    } else if (!actual.startsWith('link:') && !versionsEqual(actual, p.version)) {
      diffs.push({ name: p.name, kind: 'helmsman', expected: p.version, actual })
    }
  }
  return { diffs, notes }
}

function spawnOutput(cmd, args, { cwd } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (res.error) return { error: res.error, status: res.status }
  return { error: null, status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * Run the live comparison against a real profile.
 * @returns {{exit: number, message: string, diffs: *[], notes: string[]}}
 */
export function runLive(manifest, profile, { profileDir } = {}) {
  const dir = profileDir ?? defaultProfileDir(profile)
  if (!existsSync(dir)) {
    return {
      exit: EXIT_ENV,
      message: `profile directory not found: ${dir} (expected a dsh profile named "${profile}"; set DSH_HOME if profiles live elsewhere)`,
      diffs: [],
      notes: [],
    }
  }
  const list = spawnOutput('pnpm', ['list', '--json'], { cwd: dir })
  if (list.error || list.status !== 0) {
    return {
      exit: EXIT_ENV,
      message: `failed to list installed packages for profile "${profile}" in ${dir}: ${(list.error ?? list.stderr ?? 'pnpm exited nonzero').toString().trim()}`,
      diffs: [],
      notes: [],
    }
  }
  const { installed, error } = flattenPnpmList(list.stdout)
  if (error) {
    return { exit: EXIT_ENV, message: error, diffs: [], notes: [] }
  }
  const nodeRes = spawnOutput(process.execPath, ['-p', 'process.version'])
  const pnpmRes = spawnOutput('pnpm', ['--version'])
  const nodeVersion = nodeRes.error || nodeRes.status !== 0 ? undefined : nodeRes.stdout.trim().replace(/^v/, '')
  const pnpmVersion = pnpmRes.error || pnpmRes.status !== 0 ? undefined : pnpmRes.stdout.trim()
  const { diffs, notes } = liveDiff(manifest, installed, { nodeVersion, pnpmVersion })
  const messages = []
  messages.push(`profile: ${profile} (${dir})`)
  messages.push(`node ${nodeVersion ?? '(unavailable)'} vs engines ${manifest.engines?.node}`)
  messages.push(`pnpm ${pnpmVersion ?? '(unavailable)'} vs engines ${manifest.engines?.pnpm}`)
  if (diffs.length === 0) {
    messages.push('OK: installed profile matches toolchain.json')
  } else {
    messages.push(`MISMATCH: ${diffs.length} drift(s) against toolchain.json`)
    for (const d of diffs) {
      messages.push(`  - [${d.kind}] ${d.name}: expected ${d.expected}, actual ${d.actual}`)
    }
  }
  for (const n of notes) messages.push(`  note: ${n}`)
  return { exit: diffs.length === 0 ? EXIT_OK : EXIT_MISMATCH, message: messages.join('\n'), diffs, notes }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  process.stderr.write(USAGE)
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(USAGE)
      return EXIT_OK
    }
    process.stderr.write(`error: ${err.message}\n\n`)
    printUsage()
    return EXIT_ENV
  }

  const manifestPath = opts.manifest ? resolve(opts.manifest) : join(REPO_ROOT, DEFAULT_MANIFEST)
  const root = dirname(manifestPath)
  if (!existsSync(manifestPath)) {
    process.stderr.write(`toolchain.json not found at ${manifestPath} (run from the repo root or pass --manifest)\n`)
    return EXIT_ENV
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`error: cannot parse ${manifestPath}: ${err.message}\n`)
    return opts.structural ? EXIT_MISMATCH : EXIT_ENV
  }

  if (opts.generateCompat) {
    const compatPath = opts.compat ? resolve(opts.compat) : join(root, DEFAULT_COMPAT)
    writeFileSync(compatPath, renderCompatMarkdown(manifest))
    process.stdout.write(`wrote ${compatPath}\n`)
    if (!opts.structural && !opts.live) return EXIT_OK
  }

  let exit = EXIT_OK
  if (opts.structural) {
    const { problems, notes } = structuralValidate(root, manifest)
    if (opts.verbose) for (const n of notes) process.stdout.write(`note: ${n}\n`)
    if (problems.length === 0) {
      process.stdout.write('OK: toolchain.json is valid and consistent with the docs\n')
    } else {
      process.stdout.write(`MISMATCH: ${problems.length} structural problem(s)\n`)
      for (const p of problems) process.stdout.write(`  - ${p}\n`)
      exit = EXIT_MISMATCH
    }
  }

  if (opts.live) {
    const profile = opts.profile ?? manifest?.platform?.defaultProfile ?? 'web'
    const res = runLive(manifest, profile)
    process.stdout.write(`${res.message}\n`)
    if (res.exit !== EXIT_OK && exit === EXIT_OK) exit = res.exit
  }
  return exit
}

// Allow tests to import this module without running main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

export { main }
