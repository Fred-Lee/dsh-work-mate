/**
 * Control bands over WorkMate's own process metrics (change `add-feedback-loop`).
 *
 * The playbook recommends `baseline: rolling_30d` and a σ-tiered response
 * (`1σ log / 2σ diagnose / 3σ propose`), and the critique of that playbook is
 * precisely "control bands require baselines". This module supplies the baselines:
 * one sample per proposal, a mean/σ computed from the older samples, and a tier
 * for the recent ones. Detection is deterministic and pure — no model involved.
 *
 * Dialect note (design D3): the playbook's example is `bands.yaml`; this plugin
 * ships no YAML parser, so the file is `bands.json` with identical semantics.
 * A missing file means the built-in defaults; a corrupt file fails closed.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProposalStore } from '../proposal/store.ts'
import type { Proposal } from '../proposal/store.ts'
import { proposalMetrics } from '../proposal/metrics.ts'
import type { ProposalEvent } from '../proposal/events.ts'

/** Reserved pseudo-proposal id for metric-level events (they belong to no proposal). */
export const METRICS_SOURCE = '_metrics_'

export type BandMetric = 'cycleTime' | 'rework' | 'gateFailures' | 'firstPass'
/** `high` = bigger is worse (cycle time, rework, gate refusals); `low` = smaller is worse. */
export type BandDirection = 'high' | 'low'
export type BandTier = 'normal' | 'log' | 'diagnose' | 'propose'

export interface BandRule {
  metric: BandMetric
  direction?: BandDirection
  /** Overrides the default action per tier. */
  actions?: { sigma1?: BandTier; sigma2?: BandTier; sigma3?: BandTier }
}

export interface BandsConfig {
  version: 1
  /** Samples older than this (by proposal createdAt) are ignored. */
  windowDays: number
  /** How many of the newest samples count as "current". */
  recentSamples: number
  /** Below this many baseline samples the metric is `insufficient-data`, never a breach. */
  minBaselineSamples: number
  rules: BandRule[]
}

/** Built-in bands: the metrics this plugin can actually observe about itself. */
export const DEFAULT_BANDS: BandsConfig = {
  version: 1,
  windowDays: 30,
  recentSamples: 5,
  minBaselineSamples: 8,
  rules: [
    { metric: 'cycleTime', direction: 'high' },
    { metric: 'rework', direction: 'high' },
    { metric: 'gateFailures', direction: 'high' },
    { metric: 'firstPass', direction: 'low' },
  ],
}

const DIRECTIONS: Record<BandMetric, BandDirection> = {
  cycleTime: 'high',
  rework: 'high',
  gateFailures: 'high',
  firstPass: 'low',
}

const METRICS: BandMetric[] = ['cycleTime', 'rework', 'gateFailures', 'firstPass']

export class BandsConfigError extends Error {
  readonly code = 'BANDS_CONFIG_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'BandsConfigError'
  }
}

/** `<DSH home>/<workmateHome>/bands.json`. */
export function bandsPath(options: { homeRoot?: string; subdir: string }): string {
  return join(new ProposalStore(options).rootDir, 'bands.json')
}

/**
 * Read the bands file. Missing → defaults; unreadable or malformed → throw
 * (fail closed: silently using defaults would hide a typo'd band forever).
 */
export async function loadBands(file: string): Promise<BandsConfig> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'ENOENT') return DEFAULT_BANDS
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new BandsConfigError(`bands.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  return normalizeBands(parsed)
}

/** Validate the file shape, filling the defaults for omitted fields. */
export function normalizeBands(value: unknown): BandsConfig {
  if (value === null || typeof value !== 'object') throw new BandsConfigError('bands.json must be an object')
  const record = value as Record<string, unknown>
  const number = (key: string, fallback: number): number => {
    const found = record[key]
    if (found === undefined) return fallback
    if (typeof found !== 'number' || !Number.isFinite(found) || found < 0) {
      throw new BandsConfigError(`bands.json: ${key} must be a non-negative number`)
    }
    return found
  }
  if (record['version'] !== undefined && record['version'] !== 1) {
    throw new BandsConfigError(`bands.json: unsupported version ${String(record['version'])}`)
  }
  const rulesValue = record['rules']
  if (rulesValue !== undefined && !Array.isArray(rulesValue)) throw new BandsConfigError('bands.json: rules must be an array')
  const rules: BandRule[] = []
  for (const entry of (rulesValue as unknown[] | undefined) ?? DEFAULT_BANDS.rules) {
    if (entry === null || typeof entry !== 'object') throw new BandsConfigError('bands.json: each rule must be an object')
    const rule = entry as Record<string, unknown>
    const metric = rule['metric']
    if (typeof metric !== 'string' || !METRICS.includes(metric as BandMetric)) {
      throw new BandsConfigError(`bands.json: unknown metric ${String(metric)} (known: ${METRICS.join(', ')})`)
    }
    const direction = rule['direction']
    if (direction !== undefined && direction !== 'high' && direction !== 'low') {
      throw new BandsConfigError(`bands.json: direction must be "high" or "low"`)
    }
    const actions = rule['actions']
    if (actions !== undefined && (actions === null || typeof actions !== 'object')) {
      throw new BandsConfigError('bands.json: actions must be an object')
    }
    rules.push({
      metric: metric as BandMetric,
      ...(direction !== undefined ? { direction: direction as BandDirection } : {}),
      ...(actions !== undefined ? { actions: actions as BandRule['actions'] } : {}),
    })
  }
  if (rules.length === 0) throw new BandsConfigError('bands.json: rules must not be empty')
  return {
    version: 1,
    windowDays: number('windowDays', DEFAULT_BANDS.windowDays),
    recentSamples: number('recentSamples', DEFAULT_BANDS.recentSamples),
    minBaselineSamples: number('minBaselineSamples', DEFAULT_BANDS.minBaselineSamples),
    rules,
  }
}

export type BandStatus = 'ok' | 'insufficient-data'

export interface BandEvaluation {
  metric: BandMetric
  direction: BandDirection
  status: BandStatus
  tier: BandTier
  /** Tier action after applying the rule's overrides. */
  action: BandTier
  /** Mean of the newest `recentSamples` samples. */
  current: number
  baseline: number
  sigma: number
  /** Signed deviation in σ (positive = worse than baseline). */
  deviation: number
  samples: number
  baselineSamples: number
  note?: string
}

const tierOf = (deviation: number, actions: BandRule['actions']): BandTier => {
  const at3 = actions?.sigma3 ?? 'propose'
  const at2 = actions?.sigma2 ?? 'diagnose'
  const at1 = actions?.sigma1 ?? 'log'
  if (deviation >= 3) return at3
  if (deviation >= 2) return at2
  if (deviation >= 1) return at1
  return 'normal'
}

/**
 * Per-proposal samples, oldest first. One value per proposal (not per event):
 * weighting by proposal keeps a chatty session from skewing the distribution.
 */
export function bandSamples(
  metric: BandMetric,
  proposals: readonly Proposal[],
  events: readonly ProposalEvent[],
  now: () => Date,
): number[] {
  const ordered = [...proposals].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const samples: number[] = []
  for (const proposal of ordered) {
    if (metric === 'firstPass') {
      // A proposal still short of merging is not evidence either way.
      const metrics = proposalMetrics(proposal, events, now)
      if (metrics.reworkCount === 0 && metrics.transitions === 0) continue
      const index = ['draft', 'proposing', 'reviewing', 'ready', 'implementing', 'merging', 'archiving', 'archived'].indexOf(
        proposal.status,
      )
      if (index < 5) continue
      samples.push(metrics.firstPass ? 1 : 0)
      continue
    }
    const metrics = proposalMetrics(proposal, events, now)
    if (metric === 'cycleTime') {
      if (metrics.cycleTimeMs !== undefined) samples.push(metrics.cycleTimeMs)
      continue
    }
    if (metric === 'rework') {
      samples.push(metrics.reworkCount)
      continue
    }
    samples.push(metrics.gateFailureCount)
  }
  return samples
}

export interface EvaluateBandsOptions {
  config?: BandsConfig
  windowDays?: number
  now?: () => Date
}

/** Evaluate every rule against the sample distribution (see design D4). */
export function evaluateBands(
  proposals: readonly Proposal[],
  events: readonly ProposalEvent[],
  options: EvaluateBandsOptions = {},
): BandEvaluation[] {
  const config = options.config ?? DEFAULT_BANDS
  const now = options.now ?? ((): Date => new Date())
  const windowDays = options.windowDays ?? config.windowDays
  const cutoff = now().getTime() - windowDays * 24 * 60 * 60 * 1000
  const inWindow = proposals.filter((proposal) => Date.parse(proposal.createdAt) >= cutoff)
  const recent = Math.max(1, Math.floor(config.recentSamples))

  return config.rules.map((rule) => {
    const direction = rule.direction ?? DIRECTIONS[rule.metric]
    const samples = bandSamples(rule.metric, inWindow, events, now)
    const base: Omit<BandEvaluation, 'status' | 'tier' | 'action' | 'current' | 'baseline' | 'sigma' | 'deviation' | 'baselineSamples'> = {
      metric: rule.metric,
      direction,
      samples: samples.length,
    }
    const baselineSamples = samples.length - recent
    if (baselineSamples < config.minBaselineSamples) {
      return {
        ...base,
        status: 'insufficient-data',
        tier: 'normal',
        action: 'normal',
        current: 0,
        baseline: 0,
        sigma: 0,
        deviation: 0,
        baselineSamples: Math.max(0, baselineSamples),
        // 面板要把它原样展示给操作者（polish-workbench-delivery T9）：
        // 「样本 12（基线 7）」配「数据不足」曾让人以为 12 已经够——写清门槛与差距。
        note: `基线样本不足：至少 ${config.minBaselineSamples} 条，当前 ${Math.max(0, baselineSamples)} 条`,
      }
    }
    const baselineSlice = samples.slice(0, baselineSamples)
    const mean = baselineSlice.reduce((sum, value) => sum + value, 0) / baselineSlice.length
    const variance = baselineSlice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / baselineSlice.length
    const sigma = Math.sqrt(variance)
    const recentSlice = samples.slice(baselineSamples)
    const current = recentSlice.reduce((sum, value) => sum + value, 0) / recentSlice.length
    // σ = 0 is a real possibility (uniform samples): treat any movement as a
    // 3σ departure and say so, rather than dividing by zero or silently passing.
    const raw = direction === 'high' ? current - mean : mean - current
    const deviation = sigma === 0 ? (raw === 0 ? 0 : 3) : raw / sigma
    return {
      ...base,
      status: 'ok',
      tier: tierOf(deviation, rule.actions),
      action: tierOf(deviation, rule.actions),
      current,
      baseline: mean,
      sigma,
      deviation,
      baselineSamples,
      ...(sigma === 0 && raw !== 0 ? { note: 'sigma: 0 — samples were uniform, any movement is treated as 3σ' } : {}),
    }
  })
}
