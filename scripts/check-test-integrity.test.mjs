import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateIntegrity, executedFiles, parseInclude } from './check-test-integrity.mjs'

test('parses the include globs from vitest.config.ts', () => {
  const include = parseInclude(`export default defineConfig({\n  test: { include: ['src/**/*.test.{ts,tsx}', "scripts/**/*.test.mjs"] },\n})`)
  assert.deepEqual(include, ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'])
  assert.deepEqual(parseInclude('export default {}'), [])
})

test('accepts a run where every declared file executed and nothing was skipped', () => {
  const problems = evaluateIntegrity({
    onDisk: ['src/a.test.ts', 'src/b.test.ts'],
    executed: ['src/a.test.ts', 'src/b.test.ts'],
    counts: { passed: 12, failed: 0, pending: 0, todo: 0, totalSuites: 2, passedSuites: 2 },
  })
  assert.deepEqual(problems, [])
})

test('flags a declared file that never ran (the silent-exclusion green)', () => {
  const problems = evaluateIntegrity({
    onDisk: ['src/a.test.ts', 'src/b.test.ts'],
    executed: ['src/a.test.ts'],
    counts: { passed: 3, failed: 0, pending: 0, todo: 0, totalSuites: 1, passedSuites: 1 },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /没有执行：src\/b\.test\.ts/)
})

test('flags a skipped or todo case as a false green', () => {
  const skipped = evaluateIntegrity({
    onDisk: ['src/a.test.ts'],
    executed: ['src/a.test.ts'],
    counts: { passed: 3, failed: 0, pending: 2, todo: 0, totalSuites: 1, passedSuites: 1 },
  })
  assert.match(skipped.join(' '), /2 条用例被 skip/)

  const todo = evaluateIntegrity({
    onDisk: ['src/a.test.ts'],
    executed: ['src/a.test.ts'],
    counts: { passed: 3, failed: 0, pending: 0, todo: 1, totalSuites: 1, passedSuites: 1 },
  })
  assert.match(todo.join(' '), /1 条用例是 todo/)
})

test('flags a run that executed nothing at all', () => {
  const problems = evaluateIntegrity({
    onDisk: [],
    executed: [],
    counts: { passed: 0, failed: 0, pending: 0, todo: 0, totalSuites: 0, passedSuites: 0 },
  })
  assert.match(problems.join(' '), /没有任何测试文件/)
  assert.match(problems.join(' '), /通过的用例数为 0/)
})

test('flags a failure and an empty suite set separately from an empty test set', () => {
  const problems = evaluateIntegrity({
    onDisk: ['src/a.test.ts'],
    executed: ['src/a.test.ts'],
    counts: { passed: 0, failed: 4, pending: 0, todo: 0, totalSuites: 1, passedSuites: 0 },
  })
  assert.match(problems.join(' '), /4 条用例失败/)
  assert.match(problems.join(' '), /没有任何测试套件通过/)
})

test('executedFiles normalizes absolute names to repo-relative', () => {
  const files = executedFiles({ testResults: [{ name: '/repo/src/a.test.ts' }, { name: '/repo/src/b.test.ts' }] }, '/repo')
  assert.deepEqual(files.sort(), ['src/a.test.ts', 'src/b.test.ts'])
})
