import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatEvaluation, reachedTier, summarize } from './bands-watch.mjs'

const evaluation = (overrides = {}) => ({
  metric: 'cycleTime',
  direction: 'high',
  status: 'ok',
  tier: 'normal',
  action: 'normal',
  current: 3,
  baseline: 2,
  sigma: 0.5,
  deviation: 2,
  samples: 13,
  baselineSamples: 8,
  ...overrides,
})

test('reachedTier returns every evaluation at or above the threshold', () => {
  const evaluations = [
    evaluation({ metric: 'cycleTime', tier: 'propose' }),
    evaluation({ metric: 'rework', tier: 'diagnose' }),
    evaluation({ metric: 'firstPass', tier: 'log' }),
    evaluation({ metric: 'gateFailures', tier: 'normal' }),
  ]

  assert.deepEqual(reachedTier(evaluations, 'propose').map((entry) => entry.metric), ['cycleTime'])
  assert.deepEqual(reachedTier(evaluations, 'diagnose').map((entry) => entry.metric), ['cycleTime', 'rework'])
  assert.deepEqual(reachedTier(evaluations, 'log').map((entry) => entry.metric), ['cycleTime', 'rework', 'firstPass'])
  assert.deepEqual(reachedTier(evaluations, 'none'), [])
})

test('insufficient-data never counts as a breach', () => {
  const evaluations = [evaluation({ status: 'insufficient-data', tier: 'normal', note: 'baseline needs 8 samples, has 2' })]

  assert.deepEqual(reachedTier(evaluations, 'log'), [])
})

test('reachedTier rejects an unknown tier instead of silently passing', () => {
  assert.throws(() => reachedTier([], 'critical'), /unknown --fail-on/)
})

test('the table renders numbers for ok rows and the honest note otherwise', () => {
  const ok = formatEvaluation(evaluation())
  assert.match(ok, /cycleTime/)
  assert.match(ok, /当前 3\.00 \/ 基线 2\.00 \/ σ 0\.50/)

  const thin = formatEvaluation(evaluation({ status: 'insufficient-data', tier: 'normal', note: 'baseline needs 8 samples, has 2' }))
  assert.match(thin, /数据不足/)
  assert.match(thin, /baseline needs 8 samples/)
})

test('summarize joins one line per metric', () => {
  const text = summarize([evaluation({ metric: 'cycleTime' }), evaluation({ metric: 'rework', tier: 'diagnose' })])

  assert.equal(text.split('\n').length, 2)
  assert.match(text, /rework/)
})
