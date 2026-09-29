import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { structuralCheck } from './check-toolchain.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-toolchain.mjs')

const manifest = {
  manifestVersion: 1,
  profile: { dsh: '0.1.7-rc.2' },
  require: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '0.1.2-alpha.5' },
  engines: { node: '^22.19.0 || >=24.0.0' },
}

const pkg = {
  peerDependencies: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '*' },
  devDependencies: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '0.1.2-alpha.5' },
  engines: { node: '^22.19.0 || >=24.0.0' },
}

function runStructural(manifestJson, pkgJson) {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-fixture-'))
  writeFileSync(join(dir, 'toolchain.json'), JSON.stringify(manifestJson, null, 2))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2))
  return spawnSync(process.execPath, [SCRIPT, '--structural', '--manifest', join(dir, 'toolchain.json')], {
    encoding: 'utf8',
  })
}

test('structuralCheck accepts the committed shape', () => {
  assert.deepEqual(structuralCheck(manifest, pkg), [])
})

test('flags version drift between devDependencies and the manifest', () => {
  const drifted = {
    ...pkg,
    devDependencies: { ...pkg.devDependencies, '@deepseek-ai/dsh-tools': '0.1.5-rc.1' },
  }
  const problems = structuralCheck(manifest, drifted)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /version drift.*0\.1\.5-rc\.1/)
})

test('flags a missing devDependency and a broken peer contract', () => {
  const problems = structuralCheck(manifest, {
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '^0.1.2' },
    devDependencies: { '@deepseek-ai/cordis': '^4.0.2' },
    engines: pkg.engines,
  })
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => p.includes("devDependencies missing '@deepseek-ai/dsh-tools'")))
  assert.ok(problems.some((p) => p.includes("peerDependencies['@deepseek-ai/dsh-tools'] must be '*'")))
})

test('flags engines drift and rejects non-kernel entries', () => {
  const problems = structuralCheck(
    { ...manifest, require: { ...manifest.require, 'left-pad': '^1.0.0' }, engines: { node: '>=18' } },
    pkg,
  )
  assert.ok(problems.some((p) => p.includes("'left-pad' is not an @deepseek-ai/* kernel package")))
  assert.ok(problems.some((p) => p.includes('engines drift')))
})

test('CLI exits 0 on the real repo state and 1 on drift', () => {
  const okRun = spawnSync(process.execPath, [SCRIPT, '--structural'], { encoding: 'utf8' })
  assert.equal(okRun.status, 0, okRun.stderr)

  const drifted = { ...manifest, require: { ...manifest.require, '@deepseek-ai/dsh-tools': '9.9.9' } }
  const badRun = runStructural(drifted, pkg)
  assert.equal(badRun.status, 1)
  assert.match(badRun.stderr, /version drift/)
})
