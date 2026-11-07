#!/usr/bin/env node
/**
 * WorkMate DSH host-compatibility gate.
 *
 * The host decides whether a bundle may load by evaluating ONLY the plugin's
 * `peerDependencies` whose name is `@deepseek-ai/dsh` or starts with
 * `@deepseek-ai/dsh-` against the running dsh version
 * (`packages/boot/app-boot/src/plugin-compatibility.ts`,
 * `semver.satisfies(runtime, range, { includePrerelease: true })`); a plugin
 * whose range does not satisfy the runtime is skipped outright — which is how a
 * harness update silently unloads every narrow plugin. `dependencies` are never
 * consulted.
 *
 * This gate runs that exact rule against our own manifest:
 *
 *   --runtime <version>   dsh version to evaluate against (default: the
 *                         `profile.dsh` baseline recorded in toolchain.json)
 *   --host-lib <path>     built @deepseek-ai/dsh-app-boot entry to borrow the
 *                         host's own evaluator from
 *   --structural          skip the borrowed evaluator and only enforce the
 *                         zero-dependency invariant (every @deepseek-ai/dsh*
 *                         peer range must be '*', which satisfies every host)
 *
 * The structural invariant is the real guarantee: a `*` range can never be
 * rejected, so the plugin stays installable across host updates while the
 * build-against line lives in devDependencies + toolchain.json.
 *
 * Exit codes: 0 = compatible, 1 = incompatible/drift, 2 = usage or environment.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const EXIT_OK = 0
export const EXIT_INCOMPATIBLE = 1
export const EXIT_ENV = 2

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')

/** Every dsh kernel name the host evaluates; anything else is ignored by design. */
export function isEvaluatedPeer(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * The invariant this repo can always guarantee on its own: every evaluated peer
 * range is `*`, which satisfies every possible runtime version.
 * @param pkg - parsed package.json.
 * @returns problem strings (empty = ok).
 */
export function structuralPeerCheck(pkg) {
  const problems = []
  const peers = pkg?.peerDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    if (!isEvaluatedPeer(name)) continue
    if (range !== '*') {
      problems.push(
        `peerDependencies['${name}'] is ${JSON.stringify(range)}; the host refuses any range that does not satisfy the running dsh, so dsh kernel peers must stay '*'`,
      )
    }
  }
  return problems
}

/** Candidate built host entries, newest-checked first. */
export function hostLibCandidates(explicit) {
  const candidates = []
  if (explicit !== undefined) candidates.push(explicit)
  if (process.env['DSH_APP_BOOT_LIB'] !== undefined) candidates.push(process.env['DSH_APP_BOOT_LIB'])
  // The installed host ships its own app-boot build; prefer it so the gate evaluates with the
  // code that actually runs. Harness checkouts stay as fallbacks for source-level development.
  for (const root of globalRoots()) {
    candidates.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  }
  candidates.push(resolve(REPO_ROOT, '..', 'deepseek-harness', 'packages', 'boot', 'app-boot', 'lib', 'index.js'))
  candidates.push(join(homedir(), 'Documents', 'workspace', 'deepseek-harness', 'packages', 'boot', 'app-boot', 'lib', 'index.js'))
  return candidates
}

/**
 * Global installation roots, most specific first. Node lives at `<prefix>/bin/node`, so the
 * unix global root is `<prefix>/lib/node_modules`; keep the direct sibling layout as a fallback.
 */
export function globalRoots() {
  const roots = []
  const bin = dirname(process.execPath)
  for (const root of [join(dirname(bin), 'lib', 'node_modules'), join(bin, 'node_modules')]) {
    if (existsSync(root) && !roots.includes(root)) roots.push(root)
  }
  return roots
}

/** Version of the kernel copy the running installation would answer peers from. */
export function installedKernelVersion() {
  // Since the 0.2.2 line the kernel ships inside the installed @deepseek-ai/dsh host and
  // linked importers' peer imports resolve to it (routeLinked in the host's
  // profile-resolution/resolver.ts). The ~/.dsh/profiles/node_modules copy predates that
  // model; keep reading it as a fallback so older installations still get the drift check.
  const manifests = []
  for (const root of globalRoots()) {
    manifests.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
    manifests.push(join(root, '@deepseek-ai', 'dsh-tools', 'package.json'))
  }
  manifests.push(join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue
    try {
      const version = JSON.parse(readFileSync(manifest, 'utf8')).version
      if (typeof version === 'string') return version
    } catch {
      // an unreadable manifest is treated as absent; the next candidate decides
    }
  }
  return undefined
}

/**
 * Borrow the host's own evaluator when its built entry is on disk.
 * @param explicit - an explicit --host-lib path, when given.
 * @returns the evaluator, or undefined when unavailable.
 */
export async function loadHostEvaluator(explicit) {
  for (const candidate of hostLibCandidates(explicit)) {
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.evaluatePluginCompatibility === 'function') {
        return { evaluate: mod.evaluatePluginCompatibility, from: candidate }
      }
    } catch {
      // a host checkout that cannot be imported is treated as absent
    }
  }
  return undefined
}

function readJson(file, problems, label) {
  if (!existsSync(file)) {
    problems.push(`${label}: file not found: ${file}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`${label}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function parseArgs(argv) {
  const opts = { runtime: undefined, hostLib: undefined, structural: false, root: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--structural') opts.structural = true
    else if (arg === '--runtime' || arg === '--host-lib' || arg === '--root') {
      i += 1
      if (i >= argv.length) throw new Error(`option ${arg} requires a value`)
      if (arg === '--runtime') opts.runtime = argv[i]
      else if (arg === '--host-lib') opts.hostLib = argv[i]
      else opts.root = argv[i]
    } else throw new Error(`unknown option: ${arg}`)
  }
  return opts
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[host-compat] ${error instanceof Error ? error.message : String(error)}`)
    console.error('[host-compat] usage: check-host-compat.mjs [--runtime <dsh version>] [--host-lib <path>] [--root <dir>] [--structural]')
    process.exit(EXIT_ENV)
  }

  const root = opts.root === undefined ? REPO_ROOT : resolve(opts.root)
  const problems = []
  const pkg = readJson(join(root, 'package.json'), problems, 'package.json')
  const manifest = readJson(join(root, 'toolchain.json'), problems, 'toolchain.json')
  if (pkg === null || manifest === null) {
    for (const problem of problems) console.error(`[host-compat] ${problem}`)
    process.exit(EXIT_ENV)
  }

  const runtime = opts.runtime ?? manifest.profile?.dsh
  if (typeof runtime !== 'string' || runtime.trim() === '') {
    console.error('[host-compat] no runtime version: pass --runtime or set toolchain.json profile.dsh')
    process.exit(EXIT_ENV)
  }

  // 1. the invariant we control: '*' peers satisfy every host, forever
  const structural = structuralPeerCheck(pkg)
  problems.push(...structural)

  // 2. the host's own evaluator, when its build is on disk
  let verdict
  if (opts.structural !== true) {
    const host = await loadHostEvaluator(opts.hostLib)
    if (host === undefined) {
      console.error('[host-compat] note: built host evaluator not found; structural invariant only')
    } else {
      verdict = host.evaluate(pkg, {}, runtime)
      if (verdict !== undefined) {
        problems.push(
          `the host would refuse this plugin on dsh ${runtime}: ${Object.entries(verdict.peers)
            .map(([name, range]) => `${name}@${range}`)
            .join(', ')}`,
        )
      }
      console.error(`[host-compat] host evaluator: ${host.from}`)
    }
  }

  // 3. drift between the recorded baseline and the kernel the installation serves
  const installed = installedKernelVersion()
  if (installed !== undefined && installed !== runtime) {
    problems.push(
      `host baseline drift: toolchain.json profile.dsh is ${runtime} but the installed @deepseek-ai/dsh-tools is ${installed}; update toolchain.json + devDependencies, then re-run typecheck/test/build`,
    )
  }

  const evaluated = Object.keys(pkg.peerDependencies ?? {}).filter(isEvaluatedPeer)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[host-compat] ${problem}`)
    console.error(`[host-compat] FAILED — ${problems.length} problem(s) against dsh ${runtime}`)
    process.exit(EXIT_INCOMPATIBLE)
  }

  console.error(
    `[host-compat] ok — ${evaluated.join(', ') || 'no evaluated peers'} acceptable on dsh ${runtime}` +
      (installed !== undefined ? ` (installed kernel: ${installed})` : '') +
      (verdict === undefined ? '' : '; host evaluator agrees'),
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
