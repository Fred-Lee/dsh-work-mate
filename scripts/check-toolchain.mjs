#!/usr/bin/env node
/**
 * WorkMate DSH toolchain governance check (structural only).
 *
 * `toolchain.json` is the single authoritative source for every declared
 * version of the verified DSH toolchain. This script fails fast on drift:
 *
 *   --structural                validate the manifest shape and cross-check it
 *                               against package.json (devDependencies exact
 *                           pin, peerDependencies contract, engines).
 *
 * Exit codes: 0 = OK, 1 = mismatch/drift, 2 = usage or environment error.
 * Zero runtime dependencies (Node >= 22). English CLI output.
 *
 * The peer `dsh-tools: "*"` entry is the host contract (any host-installed
 * version) and is deliberately NOT diffed against the require pin — the pin
 * governs the devDependencies copy we typecheck/build against.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXIT_OK = 0
export const EXIT_MISMATCH = 1
export const EXIT_ENV = 2

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const DEFAULT_MANIFEST = 'toolchain.json'

export function parseArgs(argv) {
  const opts = { manifest: null, structural: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--structural') opts.structural = true
    else if (arg === '--manifest') {
      i += 1
      if (i >= argv.length) throw new Error('option --manifest requires a value')
      opts.manifest = argv[i]
    } else throw new Error(`unknown option: ${arg}`)
  }
  if (!opts.structural) throw new Error('nothing to do: pass --structural')
  return opts
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

/** Cross-check the manifest against package.json. Returns problem strings. */
export function structuralCheck(manifest, pkg) {
  const problems = []

  if (manifest === null || typeof manifest !== 'object') {
    problems.push('manifest: not a JSON object')
    return problems
  }
  if (manifest.manifestVersion !== 1) {
    problems.push(`manifest: unsupported manifestVersion ${JSON.stringify(manifest.manifestVersion)}, expected 1`)
  }

  const require_ = manifest.require
  if (require_ === null || typeof require_ !== 'object' || Object.keys(require_).length === 0) {
    problems.push('manifest.require: must be a non-empty object of "@deepseek-ai/<pkg>": "<range>"')
  } else {
    const devDeps = pkg.devDependencies ?? {}
    for (const [name, range] of Object.entries(require_)) {
      if (!name.startsWith('@deepseek-ai/')) {
        problems.push(`manifest.require: '${name}' is not an @deepseek-ai/* kernel package`)
        continue
      }
      if (typeof range !== 'string' || range.trim() === '') {
        problems.push(`manifest.require['${name}']: range must be a non-empty string`)
        continue
      }
      const actual = devDeps[name]
      if (actual === undefined) {
        problems.push(`package.json: devDependencies missing '${name}' (require pins ${range})`)
      } else if (actual !== range) {
        problems.push(`version drift: package.json devDependencies['${name}'] is '${actual}', toolchain.json requires '${range}'`)
      }
    }
  }

  const peers = pkg.peerDependencies ?? {}
  if (require_ !== null && typeof require_ === 'object' && typeof require_['@deepseek-ai/cordis'] === 'string') {
    if (peers['@deepseek-ai/cordis'] !== require_['@deepseek-ai/cordis']) {
      problems.push(
        `peer contract: package.json peerDependencies['@deepseek-ai/cordis'] is '${peers['@deepseek-ai/cordis']}', toolchain.json requires '${require_['@deepseek-ai/cordis']}'`,
      )
    }
  }
  if (require_ !== null && typeof require_ === 'object' && typeof require_['@deepseek-ai/dsh-tools'] === 'string') {
    if (peers['@deepseek-ai/dsh-tools'] !== '*') {
      problems.push(
        `peer contract: package.json peerDependencies['@deepseek-ai/dsh-tools'] must be '*' (host-installed; the pin only governs devDependencies), got '${peers['@deepseek-ai/dsh-tools']}'`,
      )
    }
  }

  if (pkg.engines?.node !== manifest.engines?.node) {
    problems.push(
      `engines drift: package.json engines.node is '${pkg.engines?.node}', toolchain.json requires '${manifest.engines?.node}'`,
    )
  }
  if (typeof manifest.profile?.dsh !== 'string' || manifest.profile.dsh.trim() === '') {
    problems.push('manifest.profile.dsh: record the verified host DSH baseline (informational)')
  }

  return problems
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[toolchain] ${error instanceof Error ? error.message : String(error)}`)
    console.error('[toolchain] usage: check-toolchain.mjs --structural [--manifest toolchain.json]')
    process.exit(EXIT_ENV)
  }

  const manifestPath = resolve(opts.manifest ?? join(REPO_ROOT, DEFAULT_MANIFEST))
  const problems = []
  const manifest = readJson(manifestPath, problems, 'manifest')
  const pkg = readJson(join(REPO_ROOT, 'package.json'), problems, 'package.json')

  if (manifest !== null && pkg !== null) problems.push(...structuralCheck(manifest, pkg))

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[toolchain] ${problem}`)
    console.error(`[toolchain] FAILED — ${problems.length} problem(s) against ${manifestPath}`)
    process.exit(EXIT_MISMATCH)
  }
  console.log(`[toolchain] ok — toolchain.json consistent with package.json (host baseline: ${manifest.profile.dsh})`)
  process.exit(EXIT_OK)
}

// Only run the CLI when executed directly (tests import the helpers).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
