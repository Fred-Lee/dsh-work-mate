/**
 * Shared control-band runner (change `add-bands-watch`): one implementation behind
 * both the `workmate_bands` tool and `POST /workmate/api/bands`, so a script and
 * the agent can never disagree about what is breached.
 *
 * Detection is deterministic and model-free; `apply` is the only side effect that
 * touches the workspace (it opens a draft proposal per propose-tier breach), and
 * it must be requested explicitly (design D2).
 */
import { evaluateBands, loadBands, METRICS_SOURCE, type BandEvaluation, type BandsConfig } from './bands.ts'
import type { EventLog } from '../proposal/events.ts'
import type { ProposalService } from '../proposal/service.ts'
import type { Provenance } from '../proposal/store.ts'

/** Creates the draft proposal (the caller owns OpenSpec seeding and project roots). */
export type CreateProposalFn = (input: {
  id: string
  title: string
  source: 'metric-regression'
  sourceRef: string
  provenance: Provenance
  notes: string
}) => Promise<{ id?: string }>

export interface BandsCheckDeps {
  proposals: ProposalService
  events: EventLog
  /** Band file path; missing file means the built-in defaults. */
  bandsFile: string
  /** Reviewer-side creation path; omitted means `apply` only records breaches. */
  createProposal?: CreateProposalFn
  now?: () => Date
}

export interface BandsCheckResult {
  bandsFile: string
  windowDays: number
  evaluations: BandEvaluation[]
  breachCount: number
  /** Ids of the draft proposals created by `apply`. */
  created: string[]
  skippedLines: number
  note?: string
}

export interface BandsCheckOptions {
  apply?: boolean
  windowDays?: number
}

const formatNumber = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : String(value))

/** Evaluate the bands, record breaches, and (only with `apply`) open proposals. */
export async function runBandsCheck(deps: BandsCheckDeps, options: BandsCheckOptions = {}): Promise<BandsCheckResult> {
  const config: BandsConfig = await loadBands(deps.bandsFile)
  const proposals = await deps.proposals.list()
  const { events, skippedLines } = await deps.events.read()
  const evaluations = evaluateBands(proposals, events, {
    config,
    ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  const breaches = evaluations.filter((entry) => entry.tier !== 'normal')
  const stamp = (deps.now?.() ?? new Date()).toISOString()

  for (const breach of breaches) {
    await deps.events.append({
      at: stamp,
      proposalId: METRICS_SOURCE,
      kind: 'band-breach',
      actor: 'system',
      metric: breach.metric,
      tier: breach.tier === 'normal' ? 'log' : breach.tier,
      current: breach.current,
      baseline: breach.baseline,
      sigma: breach.sigma,
      reason: `deviation ${formatNumber(breach.deviation)}σ`,
      ...(breach.note !== undefined ? { detail: breach.note } : {}),
    })
  }

  const created: string[] = []
  let note: string | undefined
  if (options.apply === true) {
    if (deps.createProposal === undefined) {
      note = 'apply requested but no proposal-creation path is wired: breaches were recorded only'
    } else {
      for (const breach of breaches.filter((entry) => entry.tier === 'propose')) {
        const id = `band-${breach.metric.toLowerCase()}-${stamp.slice(0, 10)}`
        if (proposals.some((proposal) => proposal.id === id) || created.includes(id)) continue
        await deps.createProposal({
          id,
          title: `指标越界：${breach.metric} 偏离基线 ${formatNumber(breach.deviation)}σ`,
          source: 'metric-regression',
          sourceRef: `bands:${breach.metric}`,
          provenance: { capturedAt: stamp },
          notes: [
            `控制带越界（${breach.tier}）：metric=${breach.metric} direction=${breach.direction}`,
            `current=${breach.current} baseline=${breach.baseline} sigma=${breach.sigma} samples=${breach.samples}`,
            breach.note ?? '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        })
        created.push(id)
      }
    }
  }

  return {
    bandsFile: deps.bandsFile,
    windowDays: config.windowDays,
    evaluations,
    breachCount: breaches.length,
    created,
    skippedLines,
    ...(note !== undefined ? { note } : {}),
  }
}
