import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  flattenPnpmList,
  liveDiff,
  parseVersion,
  renderCompatMarkdown,
  satisfiesRange,
  versionsEqual,
} from './check-toolchain.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT)
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const CHECK = join(SCRIPT_DIR, 'check-toolchain.mjs')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-fixture-'))
  cpSync(join(REPO_ROOT, 'toolchain.json'), join(dir, 'toolchain.json'))
  const docs = join(dir, 'docs')
  mkdirSync(docs)
  cpSync(join(REPO_ROOT, 'docs', 'WORKBENCH-SETUP.md'), join(docs, 'WORKBENCH-SETUP.md'))
  cpSync(join(REPO_ROOT, 'docs', 'DISTRIBUTION.md'), join(docs, 'DISTRIBUTION.md'))
  cpSync(join(REPO_ROOT, 'docs', 'COMPATIBILITY.md'), join(docs, 'COMPATIBILITY.md'))
  return dir
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, obj) {
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`)
}

function runStructural(dir) {
  return spawnSync(process.execPath, [CHECK, '--manifest', join(dir, 'toolchain.json'), '--structural'], {
    encoding: 'utf8',
  })
}

function setCommunityVersion(manifest, name, version) {
  const p = manifest.plugins.community.find((x) => x.name === name)
  assert.ok(p, `fixture manifest should contain ${name}`)
  p.version = version
}

test('structural check passes on a clean fixture of the current manifest', () => {
  const dir = fixture()
  const res = runStructural(dir)
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.match(res.stdout, /OK: toolchain\.json is valid and consistent with the docs/)
})

/**
 * Fixture with a `packages/` tree, which switches on the monorepo
 * cross-checks (bundle patch ↔ manifest, per-package.json identity, and the
 * profile-bundle declaration check added after a package shipped without one).
 */
function packagesFixture(widget = {}) {
  const dir = fixture()
  const pkgs = join(dir, 'packages')
  const manifest = readJson(join(dir, 'toolchain.json'))
  mkdirSync(join(pkgs, 'bundle'), { recursive: true })
  const names = manifest.helmsman.plugins.map((p) => p.name)
  writeFileSync(
    join(pkgs, 'bundle', 'cordis.patch.yml'),
    names.map((n) => `    - id: ${n}\n      name: '${n}'`).join('\n') + '\n',
  )
  const widgetDir = join(pkgs, 'widget')
  mkdirSync(widgetDir, { recursive: true })
  writeJson(join(widgetDir, 'package.json'), {
    name: '@helmsman/widget',
    version: '0.1.0',
    files: widget.files ?? ['dist', 'cordis.patch.yml'],
    ...(widget.declares === false ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  })
  if (widget.declares !== false) {
    writeFileSync(join(widgetDir, 'cordis.patch.yml'), "# @helmsman/widget bundle layer\n- insert:\n    - id: helmsman-widget\n      name: '@helmsman/widget'\n")
  }
  return dir
}

test('a package without dsh.bundle.patch fails the structural check', () => {
  // Regression: @helmsman/artifacts shipped without the declaration, which made
  // a real profile refuse to boot — a defect unit tests cannot reach.
  const res = runStructural(packagesFixture({ declares: false }))
  assert.equal(res.status, 1, `stdout: ${res.stdout}`)
  assert.match(res.stdout, /@helmsman\/widget.*declares no dsh\.bundle\.patch/)
})

test('a package whose files[] omits its bundle patch fails the structural check', () => {
  const res = runStructural(packagesFixture({ files: ['dist'] }))
  assert.equal(res.status, 1, `stdout: ${res.stdout}`)
  assert.match(res.stdout, /files\[\] omits "cordis\.patch\.yml"/)
})

test('a package with a complete bundle declaration passes', () => {
  const res = runStructural(packagesFixture())
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`)
})

test('manifest version drift fails fast with an expected-vs-actual diff', () => {
  const dir = fixture()
  const manifest = readJson(join(dir, 'toolchain.json'))
  setCommunityVersion(manifest, 'dsh-better-sidebar', '0.19.0') // deliberate drift
  writeJson(join(dir, 'toolchain.json'), manifest)

  const res = runStructural(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /dsh-better-sidebar/)
  assert.match(res.stdout, /expected 0\.19\.0, found 0\.18\.0/)
  assert.match(res.stdout, /docs\/COMPATIBILITY\.md has drifted/)
})

test('doc-vs-manifest conflict fails (manifest is authoritative)', () => {
  const dir = fixture()
  const workbench = join(dir, 'docs', 'WORKBENCH-SETUP.md')
  const text = readFileSync(workbench, 'utf8').replace('| dsh-better-sidebar | 0.18.0 |', '| dsh-better-sidebar | 0.19.0 |')
  assert.notEqual(text, readFileSync(workbench, 'utf8'))
  writeFileSync(workbench, text)

  const res = runStructural(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /WORKBENCH-SETUP\.md:\d+: version for "dsh-better-sidebar"/)
  assert.match(res.stdout, /expected 0\.18\.0, found 0\.19\.0/)
})

test('docs may not contradict the manifest on the dsh-tools pin or engine range', () => {
  const dir = fixture()
  const dist = join(dir, 'docs', 'DISTRIBUTION.md')
  let text = readFileSync(dist, 'utf8').replace('Node `^22.19 || >=24`', 'Node `^20.0.0 || >=24`')
  text = text.replace('`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`', '`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` (0.1.2-rc.8)')
  writeFileSync(dist, text)

  const res = runStructural(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /node engine constraint contradicts toolchain\.json/)
  assert.match(res.stdout, /expected "\^22\.19 \|\| >=24"/)
})

test('engine range satisfaction: version within range passes, outside fails', () => {
  assert.equal(satisfiesRange('^22.19 || >=24', '22.19.0'), true)
  assert.equal(satisfiesRange('^22.19 || >=24', '24.11.0'), true)
  assert.equal(satisfiesRange('^22.19 || >=24', '20.11.0'), false)
  assert.equal(satisfiesRange('>=10', '10.33.2'), true)
  assert.equal(satisfiesRange('>=10', '9.9.9'), false)
})

test('engine mismatch surfaces as an expected-vs-actual drift in live mode', () => {
  const manifest = readJson(join(REPO_ROOT, 'toolchain.json'))
  const installed = flattenPnpmList('[]').installed
  const { diffs } = liveDiff(manifest, installed, { nodeVersion: '20.11.0', pnpmVersion: '9.9.9' })
  const node = diffs.find((d) => d.name === 'node')
  const pnpm = diffs.find((d) => d.name === 'pnpm')
  assert.ok(node, 'expected an engine drift for node')
  assert.equal(node.expected, '^22.19 || >=24')
  assert.equal(node.actual, '20.11.0')
  assert.ok(pnpm, 'expected an engine drift for pnpm')
  assert.equal(pnpm.expected, '>=10')
  assert.equal(pnpm.actual, '9.9.9')
})

test('live mode flags an installed plugin whose version drifts and one that is missing', () => {
  const manifest = readJson(join(REPO_ROOT, 'toolchain.json'))
  const installed = new Map()
  installed.set('dsh-better-sidebar', '0.99.0') // wrong version
  installed.set('@deepseek-ai/dsh-tools', '0.1.2-alpha.5')
  const { diffs } = liveDiff(manifest, installed, { nodeVersion: '24.11.0', pnpmVersion: '10.33.2' })
  const drift = diffs.find((d) => d.name === 'dsh-better-sidebar')
  assert.ok(drift)
  assert.equal(drift.kind, 'community')
  assert.equal(drift.expected, '0.18.0')
  assert.equal(drift.actual, '0.99.0')
  const missing = diffs.find((d) => d.name === 'dsh-plugin-check')
  assert.ok(missing)
  assert.equal(missing.actual, 'not installed')
  assert.ok(!diffs.some((d) => d.name === '@deepseek-ai/dsh-tools'), 'matching kernel pin should not drift')
})

test('pnpm list JSON parsing collects nested dependency names and versions', () => {
  const json = JSON.stringify([
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        'dsh-better-sidebar': { version: '0.18.0' },
        '@helmsman/worktree': { version: 'link:/packages/worktree' },
        '@deepseek-ai/dsh-tools': { version: '0.1.2-alpha.5' },
      },
    },
  ])
  const { installed, error } = flattenPnpmList(json)
  assert.equal(error, null)
  assert.equal(installed.get('dsh-better-sidebar'), '0.18.0')
  assert.equal(installed.get('@helmsman/worktree'), 'link:/packages/worktree')
  assert.equal(installed.get('@deepseek-ai/dsh-tools'), '0.1.2-alpha.5')
})

test('optional community plugins missing in live mode are notes, not drift', () => {
  const manifest = readJson(join(REPO_ROOT, 'toolchain.json'))
  const { diffs, notes } = liveDiff(manifest, new Map(), { nodeVersion: '24.11.0', pnpmVersion: '10.33.2' })
  assert.ok(!diffs.some((d) => d.name === 'dsh-virtual-workspace'))
  assert.ok(!diffs.some((d) => d.name === 'dsh-memory-manager'))
  assert.ok(!diffs.some((d) => d.name === 'dsh-memory-palace'))
  assert.ok(notes.some((n) => n.includes('dsh-memory-palace')))
})

test('version parsing and loose equality handle prerelease pins', () => {
  assert.ok(parseVersion('0.1.2-alpha.5'))
  assert.ok(versionsEqual('0.1.2-alpha.5', '0.1.2-alpha.5'))
  assert.ok(!versionsEqual('0.1.2-alpha.5', '0.1.2-rc.8'))
  assert.ok(!versionsEqual('0.1.2-alpha.5', '0.1.3-alpha.5'))
  assert.equal(parseVersion('not a version'), null)
})

test('COMPATIBILITY generation is deterministic and matches the committed file', () => {
  const manifest = readJson(join(REPO_ROOT, 'toolchain.json'))
  const rendered = renderCompatMarkdown(manifest)
  assert.equal(rendered, renderCompatMarkdown(manifest))
  const committed = readFileSync(join(REPO_ROOT, 'docs', 'COMPATIBILITY.md'), 'utf8')
  assert.equal(rendered, committed)
})

test('usage error returns exit code 2', () => {
  const res = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /no mode selected/)
})
