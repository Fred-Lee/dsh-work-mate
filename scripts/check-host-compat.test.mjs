import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installedKernelVersion, isEvaluatedPeer, structuralPeerCheck } from './check-host-compat.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-host-compat.mjs')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A throwaway repo shape the CLI can be pointed at with --root. */
function fixture(peers, baseline = '0.2.1-alpha.1') {
  const dir = mkdtempSync(join(tmpdir(), 'host-compat-fixture-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', peerDependencies: peers }, null, 2))
  writeFileSync(join(dir, 'toolchain.json'), JSON.stringify({ manifestVersion: 1, profile: { dsh: baseline } }, null, 2))
  return dir
}

test('only @deepseek-ai/dsh and @deepseek-ai/dsh-* peers are evaluated', () => {
  assert.equal(isEvaluatedPeer('@deepseek-ai/dsh-tools'), true)
  assert.equal(isEvaluatedPeer('@deepseek-ai/dsh'), true)
  assert.equal(isEvaluatedPeer('@deepseek-ai/cordis'), false)
  assert.equal(isEvaluatedPeer('@deepseek-ai/schemastery'), false)
  assert.equal(isEvaluatedPeer('@linxin666/dsh-tools'), false)
})

test('the committed manifest keeps every dsh kernel peer on *', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  assert.deepEqual(structuralPeerCheck(pkg), [])
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '*')
})

test('a narrow dsh peer range is reported as a host-refusal risk', () => {
  const problems = structuralPeerCheck({
    peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.2-alpha.5', '@deepseek-ai/cordis': '^4.0.2' },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must stay '\*'/)
})

test('the CLI accepts the committed repo in structural mode', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--structural'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /\[host-compat\] ok/)
})

test('the CLI fails a fixture whose dsh peer range is narrow', () => {
  const dir = fixture({ '@deepseek-ai/dsh-tools': '^0.1.2-alpha.5' })
  const result = spawnSync(process.execPath, [SCRIPT, '--structural', '--root', dir], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must stay '\*'/)
})

test('the CLI reports baseline drift against the installed kernel line', (t) => {
  const installed = installedKernelVersion()
  if (installed === undefined) {
    t.skip('no installed kernel copy to compare against')
    return
  }
  const dir = fixture({ '@deepseek-ai/dsh-tools': '*' }, '9.9.9')
  const result = spawnSync(process.execPath, [SCRIPT, '--structural', '--root', dir], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /host baseline drift/)
})
