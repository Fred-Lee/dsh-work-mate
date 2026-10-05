#!/usr/bin/env node
/**
 * Deterministic control-band trigger (change `add-bands-watch`).
 *
 * The playbook's Maintain stage wants detection that is unit tested and
 * model-free, with the model invoked only once a band is breached. DSH's own
 * `schedule` service is session-bound reminder delivery (it needs a sessionId and
 * delivers a prompt), so the schedulable unit here is a plain script any cron,
 * launchd job, CI pipeline or the DSH Schedule UI can invoke.
 *
 * Exit codes are the contract (design D3):
 *   0 = nothing reached the --fail-on tier
 *   1 = a breach reached --fail-on
 *   2 = the call failed (unreachable host, malformed response, bad arguments)
 *
 * Usage:
 *   node scripts/bands-watch.mjs [--url http://127.0.0.1:3080/workmate/api/bands]
 *                                [--fail-on propose|diagnose|log|none]
 *                                [--window-days 30] [--apply] [--json]
 */
const TIER_ORDER = ['normal', 'log', 'diagnose', 'propose']

/** Format one evaluation row for humans. */
export function formatEvaluation(evaluation) {
  const status = evaluation.status === 'insufficient-data' ? '数据不足' : evaluation.tier
  const numbers =
    evaluation.status === 'ok'
      ? `当前 ${evaluation.current.toFixed(2)} / 基线 ${evaluation.baseline.toFixed(2)} / σ ${evaluation.sigma.toFixed(2)}`
      : (evaluation.note ?? '基线样本不足，不判越界')
  return `${evaluation.metric.padEnd(12)} ${String(status).padEnd(10)} ${numbers}`
}

/** Does any evaluation reach the requested tier? `none` never fails the run. */
export function reachedTier(evaluations, failOn) {
  if (failOn === 'none') return []
  const threshold = TIER_ORDER.indexOf(failOn)
  if (threshold < 0) throw new Error(`unknown --fail-on '${failOn}' (propose|diagnose|log|none)`)
  return evaluations.filter((evaluation) => evaluation.status === 'ok' && TIER_ORDER.indexOf(evaluation.tier) >= threshold)
}

export function summarize(evaluations) {
  return evaluations.map((evaluation) => formatEvaluation(evaluation)).join('\n')
}

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:3080/workmate/api/bands', failOn: 'propose', apply: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--url' && value !== undefined) options.url = value
    else if (flag === '--fail-on' && value !== undefined) options.failOn = value
    else if (flag === '--window-days' && value !== undefined) options.windowDays = Number(value)
    else if (flag === '--apply') options.apply = true
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Error(`unknown argument '${flag}' — see --help`)
    if (flag.startsWith('--') && flag !== '--apply' && flag !== '--json' && flag !== '--help' && flag !== '-h') index += 1
  }
  return options
}

const HELP = `usage: node scripts/bands-watch.mjs [options]

  --url <u>          bands endpoint (default http://127.0.0.1:3080/workmate/api/bands)
  --fail-on <tier>   exit 1 when a breach reaches this tier (propose|diagnose|log|none; default propose)
  --window-days <n>  override the band window
  --apply            POST the same endpoint so propose-tier breaches open draft proposals
  --json             print the raw payload instead of the table

exit codes: 0 ok / 1 breach at --fail-on / 2 call failed`

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[bands-watch] ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (options.help === true) {
    console.log(HELP)
    return 0
  }

  const url = new URL(options.url)
  if (options.windowDays !== undefined) url.searchParams.set('windowDays', String(options.windowDays))

  let payload
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    payload = await response.json()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`)
  } catch (error) {
    console.error(`[bands-watch] cannot read ${url.toString()}: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  const evaluations = Array.isArray(payload?.evaluations) ? payload.evaluations : undefined
  if (evaluations === undefined) {
    console.error('[bands-watch] unexpected payload: no evaluations array')
    return 2
  }

  let reached
  try {
    reached = reachedTier(evaluations, options.failOn)
  } catch (error) {
    console.error(`[bands-watch] ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  if (options.apply === true) {
    try {
      const applied = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: true, ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}) }),
      })
      const result = await applied.json()
      if (!applied.ok) throw new Error(`HTTP ${applied.status}`)
      const created = Array.isArray(result?.created) ? result.created : []
      console.log(`[bands-watch] apply: ${created.length} draft proposal(s) created${created.length > 0 ? ` (${created.join(', ')})` : ''}`)
    } catch (error) {
      console.error(`[bands-watch] apply failed: ${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
  }

  if (options.json === true) console.log(JSON.stringify(payload, null, 2))
  else {
    console.log(summarize(evaluations))
    console.log(
      reached.length === 0
        ? `[bands-watch] ok — 没有达到 ${options.failOn} 档的越界`
        : `[bands-watch] ${reached.length} 项达到 ${options.failOn} 档：${reached.map((entry) => entry.metric).join(', ')}`,
    )
  }
  return reached.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('bands-watch.mjs')) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
