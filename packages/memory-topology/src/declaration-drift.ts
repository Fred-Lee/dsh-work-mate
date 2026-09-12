/**
 * Declaration drift — does the repository's DECLARATION still agree with what
 * the code says? (`detect-declaration-drift`)
 *
 * Two inputs, one comparison, and no third source of truth:
 *  - **declaration side** (`readDeclaration`, `declare-dependencies-in-repo`): the
 *    repository's own outbound edges in `<repo>/.helmsman/dependencies.yml`. It is
 *    the AUTHORITY for "is this pair declared?";
 *  - **code side** (`deriveDependencies`, `derive-dependencies-from-calls`): the
 *    candidates the static outbound scanner found, with their evidence.
 *
 * Keyed by the (from, to) service pair, a pair lands in exactly one of four
 * places:
 *  - `consistent` — declared AND the code has evidence;
 *  - `staleDeclared` — declared, the code produced no evidence at all;
 *  - `undeclared` — the code has HIGH-confidence (name-tier) evidence and the
 *    pair is not declared;
 *  - `mediumConfidence` — the code has MEDIUM-confidence (path-tier) evidence and
 *    the pair is not declared. Listed SEPARATELY and NOT part of the verdict
 *    (design D1): path-tier matching normalises templates, which has already
 *    produced a false positive on real code, so letting it into `undeclared`
 *    would fill a list that must stay trustworthy with noise.
 *
 * Judgement calls worth knowing (see also the change's design.md):
 *  - A DECLARED pair corroborated only by a path-tier match is `consistent`, not
 *    `staleDeclared`. The verdict is name-tier-driven for the code-only side, but
 *    calling a pair "未在代码中找到证据" while a path match for it sits in this very
 *    result would be a false statement that invites deleting a real dependency —
 *    exactly what design D2 forbids. The entry carries `confidence: 'medium'` so
 *    the interface can show the weaker corroboration.
 *  - Wording is deliberately reserved (design D2): `staleDeclared` says
 *    「未在代码中找到证据」, never that the dependency does not exist / is no
 *    longer valid, and always carries the static-scan caveat. There is no
 *    one-click "delete the stale declaration".
 *  - Read-only by construction (design D3): nothing here writes — not the
 *    declaration file, not the topology, not an edge. Handling an `undeclared`
 *    item navigates into the EXISTING candidate-confirmation flow.
 *  - A missing declaration file is a starting point, not an error (design D4):
 *    `status: 'no-declaration'` explains that the service declares nothing yet and
 *    lists every code-evidence pair (`undeclared` + the separately listed
 *    `mediumConfidence`), guiding the user to write a baseline.
 *  - A declaration file that exists but cannot be parsed yields
 *    `status: 'invalid-declaration'` with NO verdict at all: silently announcing
 *    「全部未声明」 from a corrupt file would be a fabricated conclusion.
 */
import { DECLARATION_RELATIVE_PATH } from './declaration.ts'
import type { CandidateEvidence, ConfidenceTier, DependencyCandidate } from './derive-dependencies.ts'
import type { RestDependencyEdge } from './types.ts'

// ---------------------------------------------------------------------------
// Wording (design D2 — the honest-degradation contract)
// ---------------------------------------------------------------------------

/**
 * The `staleDeclared` reason. MUST stay a statement about the EVIDENCE ("未在
 * 代码中找到证据"), never a statement about the dependency itself.
 */
export const STALE_REASON = '未在代码中找到证据（可能确实已删除，也可能是动态构造的调用未被识别）'
/** Why "no evidence found" cannot be read as "这个依赖已经没了" (design D2). */
export const STALE_CAVEAT =
  '扫描为静态且启发式：动态拼接的 URL、配置驱动的路径、注册中心下发的地址、非 Feign 的私有 RPC 都可能未被识别，' +
  '因此这一条表示「需要人工确认」，不能据此断定该依赖已消失。'
/** What a human does about a stale declaration (the tool does NOT edit the file). */
export const STALE_ACTION =
  '请人工确认该调用是否还在（可在仓库里搜一下），再决定是否从声明文件里删除；Helmsman 不会代为修改声明文件。'
/** Why path-tier findings stay out of the verdict (design D1). */
export const MEDIUM_TIER_NOTE =
  '中置信（路径档）：调用路径经模板归一化后可能命中多个服务，本仓早期版本就因此产出过一条假阳性依赖，' +
  '故只作参考、不计入漂移判定。'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Declaration-side statuses this comparison understands — a superset of
 * `DeclarationReadResult['status']`: `no-repo-path` is produced by the service
 * surface when the service has no working copy to read from at all.
 */
export type DeclarationDriftInputStatus = 'ok' | 'missing' | 'invalid' | 'no-repo-path'

/**
 * Outcome of a drift check. Only `'ok'` carries a verdict; the other three are
 * honest non-results (no comparison happened) with a `message` that says why.
 *  - `'no-declaration'` — no declaration file: the D4 starting point, NOT an error;
 *  - `'invalid-declaration'` — file present but unparseable: an error, no verdict;
 *  - `'no-repo-path'` — no working copy: nothing to read, nothing to scan.
 */
export type DeclarationDriftStatus = 'ok' | 'no-declaration' | 'invalid-declaration' | 'no-repo-path'

/** What the DECLARATION says about one pair (the authority side of the compare). */
export interface DriftDeclarationShape {
  /** HTTP method of the declared edge (`'*'` = service-level edge, no detail). */
  method: string
  /** Endpoint paths the declaration lists (empty = service-level edge). */
  endpoints: string[]
}

/** Fields every drift entry carries, whichever group it landed in. */
export interface DriftEntryBase {
  /** Declaring service — the service the check ran for. */
  from: string
  /** Target service id (or the name a clue produced when it is not registered). */
  to: string
  /**
   * Code evidence behind this pair. NEVER empty for `consistent` / `undeclared` /
   * `mediumConfidence` (a candidate without evidence is not emitted by the
   * derivation), and empty by definition for `staleDeclared`.
   */
  evidence: CandidateEvidence[]
  /** Endpoints matched on the code side (candidate detail); empty when none. */
  endpoints: string[]
  /** HTTP method shared by `endpoints`; absent when there is no endpoint detail. */
  method?: string
  /** Code-side confidence tier; absent when the code produced no evidence. */
  confidence?: ConfidenceTier
  /** False when `to` is not a registered service (「目标未登记」, spec scenario). */
  targetDeclared: boolean
  /** What the declaration says for this pair; null when the pair is not declared. */
  declared: DriftDeclarationShape | null
}

/** Declared AND evidenced by the code — no drift. */
export interface ConsistentEntry extends DriftEntryBase {
  confidence: ConfidenceTier
  declared: DriftDeclarationShape
}

/** Declared, but the code scan produced no evidence for the pair (needs a human look). */
export interface StaleDeclaredEntry extends DriftEntryBase {
  declared: DriftDeclarationShape
  /** Always `STALE_REASON` — 「未在代码中找到证据」, never「不存在」. */
  reason: string
  /** Always `STALE_CAVEAT` — the static-scan limitation, kept verbatim. */
  caveat: string
  /** Always `STALE_ACTION` — a human edits the declaration file; the tool does not. */
  action: string
}

/** High-confidence (name-tier) code evidence for a pair the declaration omits. */
export interface UndeclaredEntry extends DriftEntryBase {
  confidence: ConfidenceTier
  declared: null
}

/** Medium-confidence (path-tier) code evidence for a pair the declaration omits. */
export interface MediumConfidenceEntry extends DriftEntryBase {
  confidence: 'medium'
  declared: null
  /** Always `MEDIUM_TIER_NOTE` — why this is not part of the verdict (design D1). */
  tierNote: string
}

export interface DriftCounts {
  /** Pairs the service's declaration lists (the authority side). */
  declared: number
  /**
   * Pairs the code side produced evidence for, ANY tier — a fact about the scan
   * (`consistent + undeclared + mediumConfidence`). Reported whenever the scan
   * ran, including the no-declaration guidance state (where it is the total the
   * message refers to); 0 when the comparison was refused BEFORE scanning (an
   * unparseable declaration is deliberately not scanned at all).
   */
  codeEvidence: number
  consistent: number
  staleDeclared: number
  undeclared: number
  mediumConfidence: number
  /** `staleDeclared + undeclared` — the pairs where the two sides disagree. */
  drift: number
}

export interface DeclarationDriftResult {
  /** Service the check ran for. */
  service: string
  status: DeclarationDriftStatus
  /** Absolute declaration path that was read (or would have been); null when unknown. */
  file: string | null
  consistent: ConsistentEntry[]
  staleDeclared: StaleDeclaredEntry[]
  undeclared: UndeclaredEntry[]
  /** Path-tier findings, listed separately and NOT counted as `undeclared` (D1). */
  mediumConfidence: MediumConfidenceEntry[]
  counts: DriftCounts
  /**
   * True when a verdict WAS issued (`status: 'ok'`) and it found drift
   * (`staleDeclared` or `undeclared` non-empty) — the warning-strip trigger.
   * False for the three non-result statuses: without a readable baseline there is
   * nothing the declaration can disagree with, so the guidance/error is shown
   * instead of a drift warning.
   */
  hasDrift: boolean
  /** Chinese summary of the outcome (mirrors `status`, carries the counts). */
  message: string
  /** Problems that prevented a comparison (`invalid-declaration`); empty otherwise. */
  errors: string[]
  /** Service ids whose tree the scanner actually read (coverage of the check). */
  scanned: string[]
  /** Services the scanner could not read, with the reason. */
  skipped: Array<{ serviceId: string; reason: string }>
  /** When the code side was scanned (epoch ms); 0 when unknown. */
  scannedAt: number
}

export interface DeclarationDriftInput {
  /** Service the check is for (the `from` of every compared pair). Required. */
  service: string
  /**
   * The repository declaration as read by `readDeclaration`. Its `status` drives
   * the three non-comparison outcomes; `edges` are only used for `'ok'`.
   */
  declaration: {
    status: DeclarationDriftInputStatus
    file?: string | null
    edges?: readonly RestDependencyEdge[]
    errors?: readonly string[]
  }
  /**
   * Candidates from `deriveDependencies`. Candidates of OTHER services are
   * ignored — the comparison is keyed by (from, to) and only the checked
   * service's declaration is compared. Candidates are expected to be already
   * merged per pair by the derivation (first one wins otherwise).
   */
  candidates?: readonly DependencyCandidate[]
  /** Registered service ids of the group — drives the 「目标未登记」 flag. */
  registeredServices?: Iterable<string>
  /** Services whose tree the scanner actually read (coverage evidence). */
  scanned?: readonly string[]
  /** Services the scanner could not read. */
  skipped?: readonly { serviceId: string; reason: string }[]
  /** Scan time of the code side (forwarded by the service surface). */
  scannedAt?: number
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** Compares a service's declaration against the code evidence (read-only). */
export function checkDeclarationDrift(input: DeclarationDriftInput): DeclarationDriftResult {
  const service = String(input.service ?? '').trim()
  if (!service) throw new Error('service is required')

  const file = input.declaration?.file ?? null
  const errors = [...(input.declaration?.errors ?? [])]
  const scanned = [...(input.scanned ?? [])]
  const skipped = (input.skipped ?? []).map((s) => ({ serviceId: s.serviceId, reason: s.reason }))
  const scannedAt = input.scannedAt ?? 0
  const declaredEdges = input.declaration?.status === 'ok' ? (input.declaration.edges ?? []) : []
  const candidates = (input.candidates ?? []).filter((c) => c != null && c.from === service)
  const registered = input.registeredServices ? new Set(input.registeredServices) : null

  const consistent: ConsistentEntry[] = []
  const staleDeclared: StaleDeclaredEntry[] = []
  const undeclared: UndeclaredEntry[] = []
  const mediumConfidence: MediumConfidenceEntry[] = []

  // Distinct targets on either side, sorted for a deterministic result.
  const declaredAt = new Map<string, RestDependencyEdge>()
  for (const edge of declaredEdges) {
    const to = String(edge?.toServiceId ?? '').trim()
    if (!to || to === service) continue // a self pair is never a dependency
    if (!declaredAt.has(to)) declaredAt.set(to, edge)
  }
  const candidateAt = new Map<string, DependencyCandidate>()
  for (const candidate of candidates) {
    const to = String(candidate?.to ?? '').trim()
    if (!to || to === service) continue
    if (!candidateAt.has(to)) candidateAt.set(to, candidate)
  }

  // The comparison itself. Whether a comparison is ALLOWED is the only thing the
  // status changes: a missing/invalid/nonexistent declaration cannot refute any
  // pair, so it only ever contributes the "not declared" side.
  const comparable = input.declaration?.status === 'ok' || input.declaration?.status === 'missing'
  if (comparable) {
    const targets = [...new Set([...declaredAt.keys(), ...candidateAt.keys()])].sort((a, b) => a.localeCompare(b))
    for (const to of targets) {
      const edge = declaredAt.get(to)
      const candidate = candidateAt.get(to)
      const shape = edge ? declaredShape(edge) : null
      const base: DriftEntryBase = {
        from: service,
        to,
        evidence: candidate ? candidate.evidence.map((e) => ({ ...e })) : [],
        endpoints: candidate ? [...candidate.endpoints] : [],
        ...(candidate?.method ? { method: candidate.method } : {}),
        ...(candidate ? { confidence: candidate.confidence } : {}),
        targetDeclared: registered ? registered.has(to) : candidate?.targetDeclared === true,
        declared: shape,
      }
      if (candidate && shape) {
        consistent.push({ ...base, confidence: candidate.confidence, declared: shape })
      } else if (shape) {
        // Declared, no code evidence: report it, never conclude about the dependency.
        staleDeclared.push({ ...base, declared: shape, reason: STALE_REASON, caveat: STALE_CAVEAT, action: STALE_ACTION })
      } else if (candidate && candidate.confidence === 'high') {
        undeclared.push({ ...base, confidence: 'high', declared: null })
      } else if (candidate) {
        mediumConfidence.push({ ...base, confidence: 'medium', declared: null, tierNote: MEDIUM_TIER_NOTE })
      }
    }
  }

  const counts: DriftCounts = {
    // The declaration side is only known once the file was read AND parsed; the
    // code side is a fact about the scan, so it is reported whenever the scan ran
    // (the unparseable-file path deliberately does not scan, so it reports 0).
    declared: comparable ? declaredAt.size : 0,
    codeEvidence: candidateAt.size,
    consistent: consistent.length,
    staleDeclared: staleDeclared.length,
    undeclared: undeclared.length,
    mediumConfidence: mediumConfidence.length,
    drift: staleDeclared.length + undeclared.length,
  }

  const status = statusOf(input.declaration?.status)
  return {
    service,
    status,
    file,
    consistent,
    staleDeclared,
    undeclared,
    mediumConfidence,
    counts,
    hasDrift: status === 'ok' && counts.drift > 0,
    message: summarize(status, service, counts),
    errors: status === 'invalid-declaration' ? errors : [],
    scanned,
    skipped,
    scannedAt,
  }
}

/** The declaration's shape for one pair (the authority side, copied not shared). */
function declaredShape(edge: RestDependencyEdge): DriftDeclarationShape {
  return { method: String(edge.method ?? ''), endpoints: Array.isArray(edge.endpoints) ? edge.endpoints.map(String) : [] }
}

function statusOf(status: DeclarationDriftInputStatus | undefined): DeclarationDriftStatus {
  switch (status) {
    case 'missing':
      return 'no-declaration'
    case 'invalid':
      return 'invalid-declaration'
    case 'no-repo-path':
      return 'no-repo-path'
    default:
      return 'ok'
  }
}

/**
 * The one-line summary shown above the groups. 必须如实：陈旧声明说的是「未在代码中找到
 * 证据」而不是「依赖不存在」，无声明文件时说的是「尚未声明、以下都是未声明」而不是报错。
 */
function summarize(status: DeclarationDriftStatus, service: string, counts: DriftCounts): string {
  const mediumNote =
    counts.mediumConfidence > 0
      ? `另有 ${counts.mediumConfidence} 对中置信（路径档）候选单列，只作参考、不计入判定。`
      : ''
  if (status === 'no-declaration') {
    return (
      `服务 ${service} 尚未声明依赖（未找到 ${DECLARATION_RELATIVE_PATH}）：以下 ${counts.codeEvidence} 条代码证据均未经声明` +
      `（高置信 ${counts.undeclared} 条、中置信 ${counts.mediumConfidence} 条单列）。` +
      '可先「💾 写回声明文件」把其中人工确认过的依赖写回仓库作为基线，之后持续核对。'
    )
  }
  if (status === 'invalid-declaration') {
    return `声明文件无法解析，未做任何比对、未产出部分结论；请先修正声明文件再核对。`
  }
  if (status === 'no-repo-path') {
    return `服务 ${service} 未配置本地路径（localPath）：既读不到声明也扫不到代码，未做任何比对。`
  }
  if (counts.drift === 0) {
    return `核对完成：声明与代码证据一致（一致 ${counts.consistent} 对，声明 ${counts.declared} 对 / 代码证据 ${counts.codeEvidence} 对）。${mediumNote}`
  }
  return (
    `核对完成：声明 ${counts.declared} 对 / 代码证据 ${counts.codeEvidence} 对 —— 一致 ${counts.consistent} 对，` +
    `需人工确认的陈旧声明 ${counts.staleDeclared} 对（未在代码中找到证据），未声明 ${counts.undeclared} 对。` +
    `${mediumNote}核对只读，未修改声明文件与依赖图。`
  )
}
