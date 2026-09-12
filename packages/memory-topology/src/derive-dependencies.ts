/**
 * Dependency derivation — turns outbound *clues* (see `scan-outbound.ts`) into
 * **candidates** a human confirms.
 *
 * Boundaries (design D1/D2/D5):
 *  - purely static and offline: it reads local files plus the stored topology,
 *    calls nothing, and writes nothing;
 *  - every candidate carries at least one verifiable evidence entry — a clue
 *    without evidence never becomes a candidate ("no evidence, no guess");
 *  - candidates are merged by (from, to) (evidence/endpoint union, confidence
 *    takes the higher tier), self-edges are dropped, and candidates that would
 *    close a cycle against the existing graph are flagged rather than dropped;
 *  - undeclared targets are KEPT (`targetDeclared: false`) — in the real repo 6
 *    of 7 Feign targets are unregistered, so filtering them would gut the
 *    feature (design D3).
 *
 * Confirmation is a separate, explicit step owned by the service surface
 * (`applyCandidates`), which reuses the (from, to) merge semantics of
 * `service-dependency-graph` so confirming can never create a duplicate row.
 */
import {
  HTTP_VERBS,
  isAbsoluteUrl,
  normalizePath,
  pathSegments,
  scanOutboundCalls,
  type OutboundCall,
  type OutboundScanOptions,
} from './scan-outbound.ts'
import { SERVICE_LEVEL_METHOD, type ApiEndpoint, type ProjectTopology, type RestDependencyEdge } from './types.ts'

export type ConfidenceTier = 'high' | 'medium'

/** One verifiable piece of evidence behind a candidate. */
export interface CandidateEvidence {
  /** `endpoint` = a path matched against the target's declared endpoints. */
  kind: 'config' | 'feign' | 'call' | 'endpoint'
  /** File the clue came from (path relative to the scanned service root). */
  file: string
  line?: number
  /** The concrete thing to look at: config key + value, annotation, path match. */
  detail: string
  /** Degradation marker (`值未解析` / `前缀未解析` / `按路径后缀匹配`). */
  note?: string
}

export interface DependencyCandidate {
  /** Declaring (calling) service id. */
  from: string
  /**
   * Target service id when declared, otherwise the name the clue produced
   * (`targetDeclared: false`).
   */
  to: string
  /** Name-tier matches are `high`, path-tier matches `medium`. */
  confidence: ConfidenceTier
  /** Never empty — a candidate without evidence is not emitted (design D2). */
  evidence: CandidateEvidence[]
  /** Matched endpoint paths (detail); empty for a service-level candidate. */
  endpoints: string[]
  /** HTTP method shared by `endpoints`; absent when there is no detail. */
  method?: string
  /** False when `to` is not a registered service (see 「目标未登记」 grouping). */
  targetDeclared: boolean
  /** True when this pair already has a declared edge (confirming just merges detail). */
  alreadyDeclared: boolean
  /** True when confirming would close a cycle against the existing graph. */
  wouldCreateCycle: boolean
}

/** Spec name for `DependencyCandidate` (`tasks.md` 2.1). */
export type Candidate = DependencyCandidate

export interface DeriveOptions {
  /** Restrict the scan to these service ids (default: every service with a localPath). */
  serviceIds?: string[]
  /** Source-scan limits, forwarded to the outbound scanner. */
  scan?: OutboundScanOptions
  /** Injection point for tests / future caching (default: `scanOutboundCalls`). */
  scanOutbound?: (localPath: string, opts?: OutboundScanOptions) => Promise<OutboundCall[]>
  /** Clock injection so `scannedAt` is deterministic in tests. */
  now?: () => number
}

export interface DeriveResult {
  candidates: DependencyCandidate[]
  scannedAt: number
  /** Service ids whose tree was actually scanned. */
  scanned: string[]
  /** Services that could not be scanned (no localPath / unreadable tree). */
  skipped: Array<{ serviceId: string; reason: string }>
}

/** Mutable working shape while clues are folded into candidates. */
interface Working {
  from: string
  to: string
  confidence: ConfidenceTier
  evidence: CandidateEvidence[]
  details: Array<{ method: string; path: string }>
}

/**
 * Derives dependency candidates for every scannable service in `topology`.
 * Read-only: no file is written and no network request is made.
 */
export async function deriveDependencies(topology: ProjectTopology, options: DeriveOptions = {}): Promise<DeriveResult> {
  const services = topology.services
  const scan = options.scanOutbound ?? scanOutboundCalls
  const wanted = options.serviceIds ? new Set(options.serviceIds) : null
  const nameToId = new Map<string, string>()
  for (const [id, svc] of Object.entries(services)) {
    nameToId.set(id.toLowerCase(), id)
    if (svc.name) nameToId.set(svc.name.toLowerCase(), id)
  }

  const scanned: string[] = []
  const skipped: DeriveResult['skipped'] = []
  const working = new Map<string, Working>()
  const upsert = (from: string, to: string, confidence: ConfidenceTier, evidence: CandidateEvidence, detail?: { method: string; path: string }): void => {
    if (!to || to === from) return
    const key = `${from}\u0000${to}`
    const entry = working.get(key) ?? { from, to, confidence, evidence: [], details: [] }
    if (confidence === 'high') entry.confidence = 'high'
    if (!entry.evidence.some((e) => sameEvidence(e, evidence))) entry.evidence.push(evidence)
    if (detail && !entry.details.some((d) => d.method === detail.method && d.path === detail.path)) entry.details.push(detail)
    working.set(key, entry)
  }

  for (const [from, svc] of Object.entries(services)) {
    if (wanted && !wanted.has(from)) continue
    const localPath = typeof svc.localPath === 'string' ? svc.localPath.trim() : ''
    if (!localPath) {
      skipped.push({ serviceId: from, reason: '未配置本地路径（localPath）' })
      continue
    }
    let clues: OutboundCall[]
    try {
      clues = await scan(localPath, options.scan)
    } catch (err) {
      skipped.push({ serviceId: from, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    scanned.push(from)

    for (const clue of clues) {
      // ---- Name tier (high): a clue names the callee -----------------------
      const names = [clue.target, ...(clue.targetAliases ?? [])].filter((n): n is string => typeof n === 'string' && n.length > 0)
      const declaredName = names.map((n) => nameToId.get(n.toLowerCase())).find((id): id is string => typeof id === 'string')
      const target = declaredName ?? names[0]
      if (target) {
        upsert(from, target, 'high', {
          kind: clue.evidence.kind,
          file: clue.evidence.file,
          ...(clue.evidence.line !== undefined ? { line: clue.evidence.line } : {}),
          detail: clue.detail ?? (clue.path || clue.target || ''),
          ...(clue.note ? { note: clue.note } : {}),
        })
      }

      // ---- Path tier (medium): the call path matches a declared endpoint ----
      const cluePath = clue.path
      if (!cluePath || isAbsoluteUrl(cluePath)) continue
      for (const [toId, toSvc] of Object.entries(services)) {
        if (toId === from) continue
        const match = matchEndpoint(cluePath, toSvc.apiEndpoints, clue.method)
        if (!match) continue
        const notes = [clue.note, match.note].filter((n): n is string => typeof n === 'string' && n.length > 0)
        upsert(
          from,
          toId,
          'medium',
          {
            kind: 'endpoint',
            file: clue.evidence.file,
            ...(clue.evidence.line !== undefined ? { line: clue.evidence.line } : {}),
            detail: `${normalizePath(cluePath)} ↔ ${match.endpoint.method.toUpperCase()} ${match.endpoint.path}（${toId} 已声明该端点）`,
            ...(notes.length > 0 ? { note: notes.join('；') } : {}),
          },
          { method: match.endpoint.method.toUpperCase(), path: normalizePath(match.endpoint.path) },
        )
      }
    }
  }

  const candidates: DependencyCandidate[] = []
  for (const entry of working.values()) {
    if (entry.evidence.length === 0) continue // no evidence → no candidate (D2)
    const declared = Object.prototype.hasOwnProperty.call(services, entry.to)
    const dominant = dominantMethod(entry.details)
    candidates.push({
      from: entry.from,
      to: entry.to,
      confidence: entry.confidence,
      evidence: [...entry.evidence].sort(compareEvidence),
      endpoints: dominant ? [...new Set(entry.details.filter((d) => d.method === dominant).map((d) => d.path))].sort() : [],
      ...(dominant ? { method: dominant } : {}),
      targetDeclared: declared,
      alreadyDeclared: isPairDeclared(topology, entry.from, entry.to),
      wouldCreateCycle: wouldCreateCycle(topology, entry.from, entry.to),
    })
  }
  candidates.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  return { candidates, scannedAt: options.now?.() ?? Date.now(), scanned, skipped }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface EndpointMatch {
  endpoint: ApiEndpoint
  /**
   * 1 = exact path, 2 = same segment shape (`/api/users/{id}` ↔ `/api/users/{userId}`),
   * 3 = the call path is a segment-shape suffix of the endpoint, 4 = same segment
   * count where a placeholder faces a literal (`/api/users/123/orders`).
   */
  rank: 1 | 2 | 3 | 4
  note?: string
}

const RANK_NOTE: Record<number, string | undefined> = {
  1: undefined,
  2: '按段形状归一化匹配',
  3: '按路径后缀匹配',
  4: '按占位段与字面段对应匹配',
}

interface Scored {
  endpoint: ApiEndpoint
  rank: 1 | 2 | 3 | 4
  /** Segments compared (1 for ranks 1/2/4, the suffix for rank 3). */
  compared: Comparison
  /** 1 when the clue's HTTP method equals the endpoint's. */
  methodMatch: number
}

/**
 * Matches a call path against a service's declared endpoints. Ordering (rank
 * first, then method agreement, then strictness of the segment comparison):
 *  1. exact normalized path;
 *  2. identical segment shape with at least one placeholder pair
 *     (`/api/users/{id}` ↔ `/api/users/{userId}`) — the spec's normalisation rule;
 *  3. the call path is a segment-shape suffix of the endpoint — a client that
 *     only knows the controller-relative path (or whose prefix is an unresolved
 *     placeholder) still finds its target (design D3);
 *  4. same segment count with a placeholder facing a concrete segment
 *     (`/api/users/123/orders` → `/api/users/{id}/orders`).
 *
 * A single-segment call path is only ever matched exactly: shape matching on one
 * segment is too loose to be evidence.
 */
export function matchEndpoint(cluePath: string, endpoints: ApiEndpoint[], clueMethod?: string): EndpointMatch | null {
  const clueSegments = pathSegments(cluePath)
  if (clueSegments.length === 0) return null
  const clueNormalized = normalizePath(cluePath)
  const wanted = clueMethod?.toUpperCase()
  let best: Scored | null = null

  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint.path !== 'string') continue
    const method = String(endpoint.method ?? '').toUpperCase()
    if (!HTTP_VERBS.has(method)) continue
    const segments = pathSegments(endpoint.path)
    if (segments.length === 0) continue

    const sameLength = segments.length === clueSegments.length
    const pair = sameLength ? compareSegments(segments, clueSegments) : null
    const tail =
      clueSegments.length >= 2 && segments.length > clueSegments.length
        ? compareSegments(segments.slice(segments.length - clueSegments.length), clueSegments)
        : null

    let rank: Scored['rank'] | undefined
    let compared: Comparison | undefined
    if (normalizePath(endpoint.path) === clueNormalized) {
      rank = 1
      compared = pair ?? compareSegments(segments, clueSegments)
    } else if (pair && pair.mismatch === 0 && pair.loose === 0 && pair.placeholderPairs > 0) {
      rank = 2
      compared = pair
    } else if (tail && tail.mismatch === 0 && tail.equal > 0) {
      rank = 3
      compared = tail
    } else if (pair && pair.mismatch === 0 && clueSegments.length >= 2) {
      rank = 4
      compared = pair
    }
    if (rank === undefined || compared === undefined) continue

    const scored: Scored = { endpoint, rank, compared, methodMatch: wanted && wanted === method ? 1 : 0 }
    if (!best || betterMatch(scored, best)) best = scored
  }

  if (!best) return null
  const note = RANK_NOTE[best.rank]
  return { endpoint: best.endpoint, rank: best.rank, ...(note ? { note } : {}) }
}

interface Comparison {
  /** Segments that differ with neither side being a placeholder. */
  mismatch: number
  /** Segments that are literally equal. */
  equal: number
  /** Segments where BOTH sides are placeholders (`{id}` ↔ `{userId}`). */
  placeholderPairs: number
  /** Segments where exactly ONE side is a placeholder. */
  loose: number
}

function compareSegments(a: string[], b: string[]): Comparison {
  const out: Comparison = { mismatch: 0, equal: 0, placeholderPairs: 0, loose: 0 }
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    if (left === right) out.equal += 1
    else if (isPlaceholderSegment(left) && isPlaceholderSegment(right)) out.placeholderPairs += 1
    else if (isPlaceholderSegment(left) || isPlaceholderSegment(right)) out.loose += 1
    else out.mismatch += 1
  }
  return out
}

function betterMatch(a: Scored, b: Scored): boolean {
  if (a.rank !== b.rank) return a.rank < b.rank
  if (a.methodMatch !== b.methodMatch) return a.methodMatch > b.methodMatch
  if (a.compared.equal !== b.compared.equal) return a.compared.equal > b.compared.equal
  return a.compared.placeholderPairs > b.compared.placeholderPairs
}

function isPlaceholderSegment(segment: string): boolean {
  return /^\{.*\}$/.test(segment) || segment.startsWith(':') || /^<.*>$/.test(segment)
}

// ---------------------------------------------------------------------------
// Graph semantics (must agree with `checkGraph`)
// ---------------------------------------------------------------------------

/**
 * True when adding `from → to` would close a cycle against the existing graph,
 * i.e. `from` is already reachable from `to`. Equivalent to what `checkGraph`
 * reports after such an edge is added (asserted by the unit tests).
 */
export function wouldCreateCycle(topology: ProjectTopology, from: string, to: string): boolean {
  if (!from || !to) return false
  if (from === to) return true
  const outgoing = outgoingMap(topology)
  const seen = new Set<string>([to])
  const stack = [to]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === from) return true
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return false
}

function outgoingMap(topology: ProjectTopology): Map<string, string[]> {
  const outgoing = new Map<string, string[]>()
  for (const [from, edges] of Object.entries(topology.restDependencies ?? {})) {
    if (!Array.isArray(edges)) continue
    const list = outgoing.get(from) ?? []
    for (const edge of edges as RestDependencyEdge[]) {
      if (typeof edge !== 'object' || edge === null) continue
      list.push(edge.toServiceId)
    }
    outgoing.set(from, list)
  }
  return outgoing
}

/** True when the pair already has a declared edge (confirming merges detail only). */
export function isPairDeclared(topology: ProjectTopology, from: string, to: string): boolean {
  const edges = topology.restDependencies?.[from]
  return Array.isArray(edges) && edges.some((edge) => edge?.toServiceId === to)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The HTTP method shared by most matched endpoints (ties resolved alphabetically). */
function dominantMethod(details: Array<{ method: string; path: string }>): string | undefined {
  if (details.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const detail of details) counts.set(detail.method, (counts.get(detail.method) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
}

function sameEvidence(a: CandidateEvidence, b: CandidateEvidence): boolean {
  return a.kind === b.kind && a.file === b.file && a.line === b.line && a.detail === b.detail
}

function compareEvidence(a: CandidateEvidence, b: CandidateEvidence): number {
  return (
    a.file.localeCompare(b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.kind.localeCompare(b.kind) ||
    a.detail.localeCompare(b.detail)
  )
}

/** Candidate → the incoming edge shape used by the confirm entry point. */
export function candidateToEdge(candidate: Pick<DependencyCandidate, 'to' | 'endpoints' | 'method'>): RestDependencyEdge {
  const endpoints = candidate.endpoints ?? []
  if (endpoints.length === 0) return { toServiceId: candidate.to, endpoints: [], method: SERVICE_LEVEL_METHOD }
  return { toServiceId: candidate.to, endpoints, method: candidate.method ?? 'GET' }
}
