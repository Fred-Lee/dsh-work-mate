import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_EXTERNALS, evaluateClientFactory } from './check-client-factory.mjs'

const CLIENT_ID = 'workmate4dsh'

/** Build a plausible ModuleLoader wrapper around a CJS body. */
const bundle = (body, id = CLIENT_ID) =>
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n` +
  'var module = { exports: {} };\nvar exports = module.exports;\n' +
  `${body}\n` +
  'return module.exports; } });'

const GOOD = bundle(`
var react = require('react');
var jsx = require('react/jsx-runtime');
function apply(ctx) { ctx.slots.inject('shell.overlay', function () {}); }
exports.apply = apply;
exports.inject = ['slots'];
`)

const evaluate = (code, expectedId = CLIENT_ID) =>
  evaluateClientFactory(code, expectedId === undefined ? {} : { expectedId })

test('accepts a well-formed bundle and reports its contract', () => {
  const result = evaluate(GOOD)

  assert.equal(result.ok, true, result.problems.join('; '))
  assert.equal(result.id, CLIENT_ID)
  assert.equal(result.loadCount, 1)
  assert.equal(result.applyType, 'function')
  assert.equal(result.injectType, 'array')
  assert.deepEqual([...result.requires].sort(), ['react', 'react/jsx-runtime'])
})

test('rejects a load id that drifted from the package name', () => {
  const result = evaluate(bundle('exports.apply = function () {};', 'workmate'))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /does not match package name/)
})

test('rejects a factory that exports no apply', () => {
  const result = evaluate(bundle('exports.inject = [];'))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /exports\.apply is undefined/)
})

test('rejects a non-array inject', () => {
  const result = evaluate(bundle("exports.apply = function () {};\nexports.inject = 'slots';"))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /inject must be an array of strings/)
})

test('denies externals outside the allow-list by default', () => {
  const result = evaluate(bundle("require('lodash');\nexports.apply = function () {};"))

  assert.equal(result.ok, false)
  assert.deepEqual(result.deniedRequires, ['lodash'])
  assert.match(result.problems.join('\n'), /external not in the allow-list: lodash/)
})

test('accepts every allowed external', () => {
  const body = ALLOWED_EXTERNALS.map((name) => `require(${JSON.stringify(name)});`).join('\n')
  const result = evaluate(bundle(`${body}\nexports.apply = function () {};`))

  assert.equal(result.ok, true, result.problems.join('; '))
})

test('reports two load calls instead of silently taking the first', () => {
  const result = evaluate(`${GOOD}\n${bundle('exports.apply = function () {};')}`)

  assert.equal(result.ok, false)
  assert.equal(result.loadCount, 2)
  assert.match(result.problems.join('\n'), /exactly once, saw 2/)
})

test('lets the module touch DOM globals without failing the gate', () => {
  const result = evaluate(
    bundle(`
var style = document.createElement('style');
document.head.appendChild(style);
window.addEventListener('resize', function () {});
var media = globalThis.matchMedia('(min-width: 1px)');
exports.apply = function () {};
`),
  )

  assert.equal(result.ok, true, result.problems.join('; '))
})

test('surfaces a thrown factory readably', () => {
  const result = evaluate(bundle("throw new Error('boom at module scope');"))

  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /factory threw: boom at module scope/)
})

test('surfaces a syntax error readably', () => {
  const result = evaluate('this is not javascript')

  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /evaluating the bundle threw/)
})

test('stops a synchronously spinning bundle with the vm timeout', () => {
  const started = Date.now()
  const result = evaluateClientFactory(bundle('while (true) {}\nexports.apply = function () {};'), {
    expectedId: CLIENT_ID,
    timeoutMs: 200,
  })

  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /timed out/)
  assert.ok(Date.now() - started < 5000, 'the gate must not hang on a spinning bundle')
})

test('a missing expected id skips the id assertion but keeps the rest', () => {
  const result = evaluateClientFactory(bundle('exports.apply = function () {};'), {})

  assert.equal(result.ok, true, result.problems.join('; '))
})
