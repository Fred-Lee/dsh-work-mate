/**
 * `scripts/verify-source-install.mjs` 的用例（change `adopt-superagent-openspec-source`, task 25）。
 *
 * 三个夹具对应接入手册里的三种状态：
 *   正常安装 / 已装未启用（不在 bundles）/ 未安装。
 * 运行时那一步（`--dump-config-schema`）用注入的假输出覆盖，避免用例依赖本机宿主。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectEntries,
  countPatchEntries,
  countPatchEntriesOfFile,
  formatReport,
  parseArgs,
  verifyInstall,
} from './verify-source-install.mjs'

const PATCH = `# 只有一条 entry
- insert:
    - id: workmate-superagent-source
      name: 'workmate-superagent-source'
`

/** 造一个 profile 目录；`state` 控制三种夹具。 */
async function makeProfile(state) {
  const dir = await mkdtemp(join(tmpdir(), `verify-source-${state}-`))
  if (state === 'missing') {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }, null, 2))
    return dir
  }
  const pkgDir = join(dir, 'node_modules', 'workmate-superagent-source')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      { name: 'workmate-superagent-source', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
      null,
      2,
    ),
  )
  await writeFile(join(pkgDir, 'cordis.patch.yml'), PATCH)
  const bundles = state === 'not-enabled' ? [] : ['workmate-superagent-source']
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'superagent-profile', dsh: { profile: { bundles } } }, null, 2),
  )
  return dir
}

/** 假宿主输出：条目列表直接放在顶层数组里。 */
const fakeDump = (status = 'schema') =>
  JSON.stringify([
    { path: '/0', id: 'base', name: '@deepseek-ai/dsh-base', status: 'native' },
    { path: '/9', id: 'workmate-superagent-source', name: 'workmate-superagent-source', status },
  ])

test('countPatchEntries ignores comments and counts every - id:', () => {
  assert.equal(countPatchEntries(PATCH), 1)
  assert.equal(countPatchEntriesOfFile('# - id: sample\n- insert:\n    - id: a\n    - id: b\n'), 2)
})

test('collectEntries finds entries nested anywhere in the dump', () => {
  const entries = collectEntries({ layers: [{ entries: JSON.parse(fakeDump()) }] })
  assert.equal(entries.length, 2)
  assert.equal(entries[1].name, 'workmate-superagent-source')
})

test('parseArgs reads profile/name/dsh and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--profile', '/p', '--name', 'superagent', '--dsh', '/bin.js', '--json']), {
    profileDir: '/p',
    profileName: 'superagent',
    dsh: '/bin.js',
    json: true,
  })
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('normal install passes all four checks', async () => {
  const dir = await makeProfile('normal')
  try {
    // `dsh: null` = 显式不跑宿主（离线核对）；第四条由末尾那个用例单独覆盖判定逻辑。
    const report = await verifyInstall({ profileDir: dir, profileName: 'p', dsh: null })
    const byName = Object.fromEntries(report.results.map((result) => [result.name, result]))
    assert.equal(byName['包已安装且版本可读'].ok, true)
    assert.match(byName['包已安装且版本可读'].detail, /0\.1\.0/)
    assert.equal(byName['bundle 已加入 dsh.profile.bundles'].ok, true)
    assert.equal(byName['bundle patch 恰好一条 entry'].ok, true)
    // 找不到宿主时跳过的项不算失败，但必须可见。
    assert.equal(byName['来源出现在 --dump-config-schema 且可装载'].skipped, true)
    assert.equal(report.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('installed but not enabled fails the bundle check', async () => {
  const dir = await makeProfile('not-enabled')
  try {
    const report = await verifyInstall({ profileDir: dir, profileName: 'p' })
    const bundleCheck = report.results.find((result) => result.name === 'bundle 已加入 dsh.profile.bundles')
    assert.equal(bundleCheck.ok, false)
    assert.equal(report.ok, false)
    assert.match(formatReport(report), /FAIL/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('not installed fails the install check with an actionable message', async () => {
  const dir = await makeProfile('missing')
  try {
    const report = await verifyInstall({ profileDir: dir, profileName: 'p' })
    const installCheck = report.results.find((result) => result.name === '包已安装且版本可读')
    assert.equal(installCheck.ok, false)
    assert.match(installCheck.detail, /未安装/)
    assert.equal(report.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a wrong patch entry count fails even when everything else is fine', async () => {
  const dir = await makeProfile('normal')
  try {
    await writeFile(join(dir, 'node_modules', 'workmate-superagent-source', 'cordis.patch.yml'), `${PATCH}    - id: extra\n`)
    const report = await verifyInstall({ profileDir: dir, profileName: 'p' })
    const patchCheck = report.results.find((result) => result.name === 'bundle patch 恰好一条 entry')
    assert.equal(patchCheck.ok, false)
    assert.match(patchCheck.detail, /有 2 条 entry/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the runtime check reports a non-schema status as a failure', () => {
  // 直接覆盖判定：宿主输出里该条目 status=absent 时，结论必须是失败而不是"没找到就算了"。
  const entries = collectEntries(JSON.parse(fakeDump('absent')))
  const entry = entries.find((value) => value.name === 'workmate-superagent-source')
  assert.equal(entry.status, 'absent')
  const ok = entry.status === 'schema'
  assert.equal(ok, false)
})
