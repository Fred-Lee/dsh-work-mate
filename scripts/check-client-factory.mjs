/**
 * Client factory evaluation gate (change `add-client-factory-gate`).
 *
 * `dist/client/client.js` is a CJS module wrapped in
 * `window.__ModuleLoader__.load({ id, factory })`. Four things can go wrong
 * there without any unit test noticing, and all four only show up on a real
 * host: the id drifts from the package name, the factory exports no `apply`,
 * `inject` is not a string array, or the module requires an external the
 * profile never made available. This gate evaluates the artifact once in a VM
 * and asserts those four facts.
 *
 * WHAT THIS IS NOT: end-to-end acceptance. The Proxy stub only proves the module
 * evaluates without throwing; `apply` is never invoked and nothing is rendered.
 * Layout, slot wiring and interaction still need a real host.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

/** Externals the DSH client host provides; anything else must be bundled. */
export const ALLOWED_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
]

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..')
export const CLIENT_BUNDLE = join(REPO_ROOT, 'dist', 'client', 'client.js')

/**
 * Readable message for a value thrown across the VM boundary: a context-realm
 * Error is not `instanceof` the host realm's Error, so read `.message` directly.
 */
function describeError(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
    return error.message
  }
  return String(error)
}

/** Recursive stub: any property is itself, and it is callable/constructable. */
function anyStub() {
  const target = function stub() {
    return undefined
  }
  return new Proxy(target, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === 'toString') return () => ''
      return anyStub()
    },
    apply: () => anyStub(),
    construct: () => anyStub(),
    has: () => true,
  })
}

/**
 * Evaluate one client bundle string and report what the factory did.
 * Returns diagnostics instead of throwing so callers can print a full report.
 *
 * @param {string} code
 * @param {{ expectedId?: string, allowedExternals?: string[], timeoutMs?: number }} [options]
 * @returns {{
 *   ok: boolean, id?: string, loadCount: number, requires: string[], deniedRequires: string[],
 *   applyType?: string, injectType?: string, problems: string[], error?: string,
 * }}
 */
export function evaluateClientFactory(code, options = {}) {
  const allowed = options.allowedExternals ?? ALLOWED_EXTERNALS
  const requires = []
  const deniedRequires = []
  const loads = []

  const requireStub = (name) => {
    requires.push(name)
    if (!allowed.includes(name)) {
      deniedRequires.push(name)
      throw new Error(`external require denied: ${name}`)
    }
    // React-like surface: a Proxy keeps the module's top-level access working.
    return anyStub()
  }

  const loader = {
    load: (entry) => {
      loads.push({ id: typeof entry?.id === 'string' ? entry.id : '', factory: entry?.factory })
    },
  }
  const windowStub = new Proxy({}, {
    get: (target, property) => (property in target ? target[property] : anyStub()),
  })
  windowStub['__ModuleLoader__'] = loader

  const sandboxTarget = {
    __ModuleLoader__: loader,
    window: windowStub,
    document: anyStub(),
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
  }
  // Seed the real JS intrinsics: the catch-all Proxy below answers every global
  // name, so without this `new Error('x')` would be a stub and the module's
  // thrown value would be unreadable.
  const INTRINSICS = [
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Promise', 'JSON', 'Math',
    'Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'String', 'Number',
    'Boolean', 'Symbol', 'Reflect', 'Proxy', 'BigInt', 'Intl', 'URL', 'URLSearchParams',
    'TextEncoder', 'TextDecoder', 'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
    'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'fetch', 'localStorage',
    'sessionStorage', 'navigator', 'location', 'history', 'getComputedStyle', 'matchMedia',
  ]
  for (const key of INTRINSICS) {
    if (!(key in sandboxTarget)) sandboxTarget[key] = key in globalThis ? globalThis[key] : anyStub()
  }
  // Unknown browser globals answer with stubs rather than ReferenceError: the
  // gate is about the loading contract, not about DOM behaviour.
  const sandbox = new Proxy(sandboxTarget, {
    get: (target, property) => (property in target ? target[property] : anyStub()),
    has: () => true,
  })
  sandboxTarget['globalThis'] = sandbox

  const problems = []
  let applyType
  let injectType
  const timeoutMs = options.timeoutMs ?? 10_000
  const context = createContext(sandbox)
  try {
    runInContext(code, context, { timeout: timeoutMs })
  } catch (error) {
    const message = describeError(error)
    problems.push(`evaluating the bundle threw: ${message}`)
    return { ok: false, loadCount: loads.length, requires, deniedRequires, problems, error: message }
  }

  if (loads.length !== 1) problems.push(`__ModuleLoader__.load must be called exactly once, saw ${loads.length}`)
  const first = loads[0]
  if (first === undefined) return { ok: false, loadCount: loads.length, requires, deniedRequires, problems }
  if (options.expectedId !== undefined && first.id !== options.expectedId) {
    problems.push(`load id ${JSON.stringify(first.id)} does not match package name ${JSON.stringify(options.expectedId)}`)
  }
  if (typeof first.factory !== 'function') {
    problems.push('load factory is not a function')
  } else {
    try {
      // Call the factory INSIDE the context: a factory that spins at its own
      // top level then hits the same VM timeout instead of hanging the gate.
      sandboxTarget['__factory'] = first.factory
      sandboxTarget['__require'] = requireStub
      const exported = runInContext('__factory(__require)', context, { timeout: timeoutMs })
      const record = exported ?? {}
      applyType = typeof record['apply']
      if (applyType !== 'function') problems.push(`module.exports.apply is ${applyType}, expected function`)
      if (record['inject'] !== undefined) {
        injectType = Array.isArray(record['inject']) ? 'array' : typeof record['inject']
        if (injectType !== 'array' || record['inject'].some((name) => typeof name !== 'string')) {
          problems.push('module.exports.inject must be an array of strings')
        }
      }
    } catch (error) {
      problems.push(`factory threw: ${describeError(error)}`)
    }
  }
  for (const name of deniedRequires) problems.push(`external not in the allow-list: ${name}`)

  return {
    ok: problems.length === 0,
    ...(first.id !== '' ? { id: first.id } : {}),
    loadCount: loads.length,
    requires: [...new Set(requires)],
    deniedRequires: [...new Set(deniedRequires)],
    ...(applyType !== undefined ? { applyType } : {}),
    ...(injectType !== undefined ? { injectType } : {}),
    problems,
  }
}

function readPackageName() {
  const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  return JSON.parse(raw).name ?? ''
}

export function report(evaluation, expectedId) {
  if (evaluation.ok) {
    console.log(
      `[client-gate] ok — id '${expectedId}', apply: ${evaluation.applyType ?? 'n/a'}, ` +
        `inject: ${evaluation.injectType ?? 'none'}, externals: ${evaluation.requires.join(', ') || 'none'}`,
    )
    console.log('[client-gate] scope: loading contract only — rendering still needs a real host')
    return 0
  }
  console.error('[client-gate] FAILED')
  for (const problem of evaluation.problems) console.error(`  - ${problem}`)
  console.error('[client-gate] scope: loading contract only — this gate cannot prove the UI renders')
  return 1
}

function main() {
  const expectedId = readPackageName()
  let code
  try {
    code = readFileSync(CLIENT_BUNDLE, 'utf8')
  } catch {
    console.error(`[client-gate] missing ${CLIENT_BUNDLE} — run \`pnpm build\` first`)
    process.exit(1)
  }
  process.exit(report(evaluateClientFactory(code, { expectedId }), expectedId))
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('check-client-factory.mjs')) main()
