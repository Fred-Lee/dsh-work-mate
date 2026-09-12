/**
 * Declaration drift (`detect-declaration-drift`).
 *
 * Locks the comparison semantics (three groups keyed by (from, to), the
 * declaration as the authority for "is it declared"), the confidence discipline
 * (design D1 — path-tier findings are listed separately and never counted as
 * `undeclared`), the honest wording (design D2 — "未在代码中找到证据", never a claim
 * about the dependency), the no-declaration guidance (design D4) and the
 * read-only boundary (design D3).
 */
import { describe, expect, it } from 'vitest'
import {
  MEDIUM_TIER_NOTE,
  STALE_ACTION,
  STALE_CAVEAT,
  STALE_REASON,
  checkDeclarationDrift,
  type DeclarationDriftResult,
} from './declaration-drift.ts'
import type { CandidateEvidence, DependencyCandidate } from './derive-dependencies.ts'
import { SERVICE_LEVEL_METHOD, type RestDependencyEdge } from './types.ts'

const SERVICE = 'homework-server'

/** A declaration edge as `readDeclaration` produces them. */
function declared(to: string, method = SERVICE_LEVEL_METHOD, endpoints: string[] = []): RestDependencyEdge {
  return { toServiceId: to, endpoints, method, source: 'declared' }
}

function evidence(detail: string, file = 'src/main/resources/application.yml', line = 8, kind: CandidateEvidence['kind'] = 'config'): CandidateEvidence {
  return { kind, file, line, detail }
}

function candidate(
  to: string,
  confidence: DependencyCandidate['confidence'],
  evidenceList: CandidateEvidence[] = [evidence(`${to}.base-url = http://${to}:8080`)],
  extra: Partial<DependencyCandidate> = {},
): DependencyCandidate {
  return {
    from: SERVICE,
    to,
    confidence,
    evidence: evidenceList,
    endpoints: confidence === 'medium' ? ['/qp/list'] : [],
    targetDeclared: true,
    alreadyDeclared: false,
    wouldCreateCycle: false,
    ...extra,
  }
}

/** Runs the comparison for `SERVICE` with a couple of convenient defaults. */
function run(opts: {
  edges?: RestDependencyEdge[]
  candidates?: DependencyCandidate[]
  status?: 'ok' | 'missing' | 'invalid'
  errors?: string[]
  registered?: string[]
}): DeclarationDriftResult {
  return checkDeclarationDrift({
    service: SERVICE,
    declaration: {
      status: opts.status ?? 'ok',
      file: `/repo/${SERVICE}/.helmsman/dependencies.yml`,
      edges: opts.edges ?? [],
      errors: opts.errors ?? [],
    },
    candidates: opts.candidates ?? [],
    registeredServices: opts.registered ?? [SERVICE, 'internal-homework', 'internal-qp'],
    scanned: [SERVICE],
    skipped: [],
    scannedAt: 1_700_000_000_000,
  })
}

describe('checkDeclarationDrift — the three groups', () => {
  it('a pair both sides agree on is consistent (declared + code evidence)', () => {
    const result = run({
      edges: [declared('internal-homework')],
      candidates: [candidate('internal-homework', 'high')],
    })

    expect(result.status).toBe('ok')
    expect(result.hasDrift).toBe(false)
    expect(result.consistent.map((e) => `${e.from} → ${e.to}`)).toEqual([`${SERVICE} → internal-homework`])
    expect(result.consistent[0]!.declared).toEqual({ method: SERVICE_LEVEL_METHOD, endpoints: [] })
    expect(result.consistent[0]!.confidence).toBe('high')
    expect(result.consistent[0]!.evidence[0]!.detail).toContain('internal-homework:8080')
    expect(result.staleDeclared).toEqual([])
    expect(result.undeclared).toEqual([])
    expect(result.mediumConfidence).toEqual([])
    expect(result.counts).toMatchObject({ declared: 1, codeEvidence: 1, consistent: 1, staleDeclared: 0, undeclared: 0, mediumConfidence: 0, drift: 0 })
  })

  it('a declared pair with no code evidence is staleDeclared, carrying the caveat and NO "does not exist" wording', () => {
    const result = run({ edges: [declared('internal-homework'), declared('internal-legacy')], candidates: [candidate('internal-homework', 'high')] })

    expect(result.staleDeclared).toHaveLength(1)
    const stale = result.staleDeclared[0]!
    expect(stale.to).toBe('internal-legacy')
    expect(stale.reason).toBe(STALE_REASON)
    expect(stale.caveat).toBe(STALE_CAVEAT)
    expect(stale.action).toBe(STALE_ACTION)
    expect(stale.declared).toEqual({ method: SERVICE_LEVEL_METHOD, endpoints: [] })
    expect(stale.evidence).toEqual([])
    expect(result.hasDrift).toBe(true)
    expect(result.counts.drift).toBe(1)

    // Design D2: 说的是「未在代码中找到证据」，不是「不存在」/「已失效」
    const text = JSON.stringify(result, null, 2)
    expect(text).toContain('未在代码中找到证据')
    expect(text).not.toContain('不存在')
    expect(text).not.toContain('已失效')
    // 静态扫描的局限必须如实声明（动态拼接的 URL 等可能未被识别）
    expect(stale.caveat).toContain('静态')
    expect(stale.caveat).toContain('动态拼接')
    expect(stale.caveat).toContain('人工确认')
    // 不提供「一键删除陈旧声明」
    expect(text).not.toContain('一键删除')
    expect(stale.action).toContain('不会代为修改声明文件')
  })

  it('a high-confidence code-only pair is undeclared and carries evidence + confidence', () => {
    const result = run({ edges: [], candidates: [candidate('internal-qp', 'high', [evidence('@FeignClient(name = "internal-qp")', 'src/main/java/QpClient.java', 3, 'feign')])] })

    expect(result.undeclared).toHaveLength(1)
    const entry = result.undeclared[0]!
    expect(entry.to).toBe('internal-qp')
    expect(entry.confidence).toBe('high')
    expect(entry.declared).toBeNull()
    expect(entry.evidence).toHaveLength(1)
    expect(entry.evidence[0]!.kind).toBe('feign')
    expect(result.counts).toMatchObject({ undeclared: 1, drift: 1, codeEvidence: 1 })
  })

  it('a medium-confidence code-only pair lands in the separate list and NOT in undeclared (D1)', () => {
    const result = run({ edges: [], candidates: [candidate('internal-qp', 'medium', [evidence('/qp/list ↔ GET /api/qp/list（internal-qp 已声明该端点）', 'src/main/java/QpCaller.java', 12, 'endpoint')])] })

    expect(result.undeclared).toEqual([])
    expect(result.mediumConfidence).toHaveLength(1)
    const entry = result.mediumConfidence[0]!
    expect(entry.to).toBe('internal-qp')
    expect(entry.confidence).toBe('medium')
    expect(entry.tierNote).toBe(MEDIUM_TIER_NOTE)
    expect(entry.tierNote).toContain('假阳性')
    expect(entry.evidence[0]!.kind).toBe('endpoint')
    // 中置信不计入判定：没有需要人工确认的漂移
    expect(result.counts).toMatchObject({ undeclared: 0, mediumConfidence: 1, drift: 0 })
    expect(result.hasDrift).toBe(false)
  })

  it('a declared pair corroborated only by a path-tier match stays consistent (NOT a stale claim)', () => {
    const result = run({ edges: [declared('internal-qp')], candidates: [candidate('internal-qp', 'medium')] })

    expect(result.consistent).toHaveLength(1)
    expect(result.consistent[0]!.confidence).toBe('medium')
    expect(result.staleDeclared).toEqual([])
    expect(result.hasDrift).toBe(false)
  })

  it('flags an undeclared entry whose target is not a registered service', () => {
    const result = run({
      edges: [],
      candidates: [candidate('internal-bc-es', 'high', [evidence('@FeignClient(name = "${…internal-bc-es.name}")', 'src/main/java/InternalBcEsClient.java', 3, 'feign')], { targetDeclared: false })],
    })

    expect(result.undeclared).toHaveLength(1)
    expect(result.undeclared[0]!.targetDeclared).toBe(false)
    // a registered target is flagged the other way round
    const registered = run({ edges: [], candidates: [candidate('internal-qp', 'high')] })
    expect(registered.undeclared[0]!.targetDeclared).toBe(true)
  })

  it('yields an empty drift for a service whose declaration and code fully agree', () => {
    const result = run({ edges: [declared('internal-homework')], candidates: [candidate('internal-homework', 'high')] })

    expect(result.consistent).toHaveLength(1)
    expect(result.staleDeclared).toEqual([])
    expect(result.undeclared).toEqual([])
    expect(result.mediumConfidence).toEqual([])
    expect(result.hasDrift).toBe(false)
    expect(result.counts.drift).toBe(0)
    expect(result.message).toContain('一致')
  })

  it('keeps a declared edge with endpoint detail and reports both sides of the pair', () => {
    const result = run({
      edges: [{ toServiceId: 'internal-qp', method: 'GET', endpoints: ['/qp/list'], source: 'declared' }],
      candidates: [candidate('internal-qp', 'high')],
    })

    expect(result.consistent[0]!.declared).toEqual({ method: 'GET', endpoints: ['/qp/list'] })
  })

  it('ignores candidates of other services and self pairs', () => {
    const result = run({
      edges: [declared('internal-homework')],
      candidates: [
        candidate('internal-homework', 'high'),
        { ...candidate('someone-else', 'high'), from: 'other-service' },
        candidate(SERVICE, 'high'),
      ],
    })

    expect(result.consistent.map((e) => e.to)).toEqual(['internal-homework'])
    expect(result.undeclared).toEqual([])
    expect(result.mediumConfidence).toEqual([])
    expect(result.counts.codeEvidence).toBe(1)
  })

  it('sorts every group by target id for a deterministic result', () => {
    const result = run({
      edges: [declared('zeta'), declared('alpha')],
      candidates: [candidate('mike', 'high'), candidate('bravo', 'medium')],
      registered: [SERVICE],
    })

    expect(result.staleDeclared.map((e) => e.to)).toEqual(['alpha', 'zeta'])
    expect(result.undeclared.map((e) => e.to)).toEqual(['mike'])
    expect(result.mediumConfidence.map((e) => e.to)).toEqual(['bravo'])
  })
})

describe('checkDeclarationDrift — no declaration file (D4)', () => {
  it('returns the guidance status and lists every code-evidence pair', () => {
    const result = run({
      status: 'missing',
      candidates: [candidate('internal-homework', 'high'), candidate('internal-qp', 'medium')],
    })

    expect(result.status).toBe('no-declaration')
    expect(result.hasDrift).toBe(false) // no verdict was issued, so there is no drift to warn about
    expect(result.consistent).toEqual([])
    expect(result.staleDeclared).toEqual([])
    // all code evidence is listed as undeclared: high tier in `undeclared`, medium tier separately
    expect(result.undeclared.map((e) => e.to)).toEqual(['internal-homework'])
    expect(result.mediumConfidence.map((e) => e.to)).toEqual(['internal-qp'])
    expect(result.counts.codeEvidence).toBe(2)
    expect(result.counts.declared).toBe(0)
    expect(result.message).toContain('尚未声明依赖')
    expect(result.message).toContain('2 条代码证据均未经声明')
    expect(result.message).toContain('写回声明文件')
    expect(result.message).toContain('基线')
    // 不是错误
    expect(result.errors).toEqual([])
  })

  it('still explains the state when the code has no evidence either', () => {
    const result = run({ status: 'missing', candidates: [] })
    expect(result.status).toBe('no-declaration')
    expect(result.counts.codeEvidence).toBe(0)
    expect(result.message).toContain('尚未声明依赖')
  })
})

describe('checkDeclarationDrift — honest non-results', () => {
  it('an unparseable declaration file yields an explicit error and NO verdict (never a fabricated "all undeclared")', () => {
    const result = run({
      status: 'invalid',
      errors: ['缺少必填字段 service（本服务在项目群中的 id，是每条依赖边的调用方）'],
      candidates: [candidate('internal-homework', 'high')],
    })

    expect(result.status).toBe('invalid-declaration')
    expect(result.errors).toEqual(['缺少必填字段 service（本服务在项目群中的 id，是每条依赖边的调用方）'])
    expect(result.undeclared).toEqual([])
    expect(result.consistent).toEqual([])
    expect(result.staleDeclared).toEqual([])
    expect(result.mediumConfidence).toEqual([])
    expect(result.counts.declared).toBe(0)
    expect(result.counts.codeEvidence).toBe(1)
    expect(result.hasDrift).toBe(false)
    expect(result.message).toContain('无法解析')
    expect(result.message).toContain('未做任何比对')
  })

  it('a service without a working copy yields no-repo-path instead of guessing', () => {
    const result = checkDeclarationDrift({ service: SERVICE, declaration: { status: 'no-repo-path', file: null, edges: [], errors: ['未配置本地路径'] }, candidates: [] })
    expect(result.status).toBe('no-repo-path')
    expect(result.file).toBeNull()
    expect(result.message).toContain('localPath')
    expect(result.hasDrift).toBe(false)
  })

  it('requires a service id', () => {
    expect(() => checkDeclarationDrift({ service: '  ', declaration: { status: 'ok' } })).toThrow(/service is required/)
  })

  it('an explicitly empty declaration is "ok" with everything undeclared (the file exists and says so)', () => {
    const result = run({ edges: [], candidates: [candidate('internal-homework', 'high')] })
    expect(result.status).toBe('ok')
    expect(result.counts).toMatchObject({ declared: 0, undeclared: 1, drift: 1 })
    expect(result.message).toContain('未声明 1 对')
  })
})
