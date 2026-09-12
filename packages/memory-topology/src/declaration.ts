/**
 * Repository-side dependency declaration (`declare-dependencies-in-repo`).
 *
 * A repository declares its OWN outbound dependencies in one small YAML file at
 * `<repo>/.helmsman/dependencies.yml`; Helmsman ingests it as an import source
 * and the human only VERIFIES. The file format (spec `dependency-declaration`):
 *
 * ```yaml
 * version: 1
 * service: homework-server       # REQUIRED — the `from` of every edge
 * dependencies:                  # outbound only, never an inbound list
 *   - to: internal-homework
 *   - to: internal-qp
 *     method: GET
 *     endpoints:
 *       - /qp/list
 * ```
 *
 * Boundaries:
 *  - every edge leaves here tagged `source: 'declared'` (design D3), so a
 *    re-ingest can reconcile declared edges without touching `derived` ones;
 *  - a missing `service` or a dependency without `to` is an ERROR and yields NO
 *    partial result (design D1 / spec「缺少 service 标识时拒绝」);
 *  - a MISSING file is not an error — it is the explicit "not declared" result;
 *  - `renderDeclaration` is the inverse operation and only ever emits `declared`
 *    edges (design D6) — derivation results are never frozen into a repository.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseYamlSubset, toYaml, type YamlValue } from './yaml.ts'
import { SERVICE_LEVEL_METHOD, edgeSource, isServiceLevelEdge, mergeDependencyEdge, type RestDependencyEdge } from './types.ts'

/** Directory inside the repository that holds Helmsman's own artifacts. */
export const DECLARATION_DIR = '.helmsman'
/** File name of the declaration, relative to the repository root. */
export const DECLARATION_FILE = 'dependencies.yml'
/** Repo-relative location of the declaration file (docs / UI copy). */
export const DECLARATION_RELATIVE_PATH = `${DECLARATION_DIR}/${DECLARATION_FILE}`
/** Only version this build understands. */
export const DECLARATION_VERSION = 1
/** Import-source name the declaration is ingested under (design D2). */
export const DECLARATION_IMPORT_SOURCE = 'helmsman-declaration'

export interface DeclarationParseSuccess {
  ok: true
  version: number
  /** Declaring service id — the `from` of every edge in `edges`. */
  service: string
  /** Every edge of the file, `source: 'declared'`. At most one edge per pair. */
  edges: RestDependencyEdge[]
  /** Non-fatal notes (e.g. `version` omitted → assumed v1). */
  warnings: string[]
}

export interface DeclarationParseFailure {
  ok: false
  /** Every problem found, in file order. NEVER accompanied by partial edges. */
  errors: string[]
}

export type DeclarationParseResult = DeclarationParseSuccess | DeclarationParseFailure

export interface DeclarationReadResult {
  /** Absolute path of the declaration file that was read (or would have been). */
  file: string
  /** False when the repository has no declaration file at all. */
  exists: boolean
  /**
   * `ok` — file read and parsed (edges may legitimately be empty: the repo
   * declares no outbound dependency); `missing` — no file, NOT an error (the
   * 「该项目未声明依赖」 result); `invalid` — file present but unparseable, in
   * which case `edges` is EMPTY (never a partial application).
   */
  status: 'ok' | 'missing' | 'invalid'
  service?: string
  edges: RestDependencyEdge[]
  errors: string[]
  warnings: string[]
}

/** `<repo>/.helmsman/dependencies.yml` for a repository working copy. */
export function declarationPathFor(repoPath: string): string {
  return join(resolve(repoPath), DECLARATION_DIR, DECLARATION_FILE)
}

function asRecord(v: YamlValue | undefined): Record<string, YamlValue> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, YamlValue>) : null
}

function asString(v: YamlValue | undefined): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

/**
 * Parses a declaration file. Purely textual — it never touches the filesystem
 * (that is `readDeclaration`), so it is also the validator behind the import
 * preview and the round-trip tests.
 *
 * All problems are collected; the caller MUST treat a failure as "apply
 * nothing" (the result carries no edges at all).
 */
export function parseDeclaration(text: string): DeclarationParseResult {
  const errors: string[] = []
  const warnings: string[] = []

  let doc: Record<string, YamlValue> | null
  try {
    doc = asRecord(parseYamlSubset(text))
  } catch (err) {
    return { ok: false, errors: [`声明文件无法解析：${err instanceof Error ? err.message : String(err)}`] }
  }
  if (!doc) {
    return { ok: false, errors: ['声明文件为空或不是 YAML 映射（需要 version / service / dependencies 三个键）'] }
  }

  // ---- version: checked when present; absent is assumed v1 -----------------
  let version = DECLARATION_VERSION
  const rawVersion = doc.version
  if (rawVersion !== undefined && rawVersion !== null) {
    const parsed = typeof rawVersion === 'number' ? rawVersion : Number(asString(rawVersion))
    if (parsed !== DECLARATION_VERSION) {
      errors.push(`不支持的声明文件版本：${String(rawVersion)}（当前仅支持 version: ${DECLARATION_VERSION}）`)
    } else {
      version = parsed
    }
  } else {
    warnings.push(`未写明 version，按 version: ${DECLARATION_VERSION} 处理`)
  }

  // ---- service: REQUIRED (it is the `from` of every edge) ------------------
  const service = asString(doc.service)
  if (!service) {
    errors.push('缺少必填字段 service（本服务在项目群中的 id，是每条依赖边的调用方）')
  }

  // ---- dependencies: REQUIRED list (empty list = "no outbound dependency") -
  const edges: RestDependencyEdge[] = []
  const rawDeps = doc.dependencies
  if (rawDeps === undefined || rawDeps === null) {
    // A typo here (`dependencis:`) would silently wipe every declared edge of a
    // service, so an absent list is rejected instead of read as "no dependency".
    errors.push('缺少必填字段 dependencies（出站依赖列表；没有任何依赖时写 dependencies: []）')
  } else if (!Array.isArray(rawDeps)) {
    errors.push('dependencies 必须是列表（每项含必填 to，可选 method / endpoints / critical）')
  } else {
    rawDeps.forEach((raw, i) => {
      const dep = asRecord(raw)
      if (!dep) {
        errors.push(`dependencies[${i}] 必须是映射（含必填 to）`)
        return
      }
      const to = asString(dep.to)
      if (!to) {
        errors.push(`dependencies[${i}] 缺少必填字段 to（被调用的服务 id）`)
        return
      }
      if (dep.method !== undefined && dep.method !== null && asString(dep.method) === '') {
        errors.push(`dependencies[${i}]（to: ${to}）的 method 必须是字符串`)
      }
      let endpoints: string[] = []
      if (dep.endpoints !== undefined && dep.endpoints !== null) {
        if (!Array.isArray(dep.endpoints)) {
          errors.push(`dependencies[${i}]（to: ${to}）的 endpoints 必须是列表`)
        } else {
          const malformed = dep.endpoints.some((e) => typeof e !== 'string' && typeof e !== 'number')
          if (malformed) errors.push(`dependencies[${i}]（to: ${to}）的 endpoints 只能包含字符串`)
          endpoints = dep.endpoints.map((e) => String(e).trim()).filter((e) => e !== '')
        }
      }
      if (dep.critical !== undefined && dep.critical !== null && typeof dep.critical !== 'boolean') {
        errors.push(`dependencies[${i}]（to: ${to}）的 critical 必须是布尔值`)
      }
      const method = asString(dep.method).toUpperCase()
      edges.push({
        toServiceId: to,
        endpoints,
        method: method !== '' ? method : endpoints.length > 0 ? 'GET' : SERVICE_LEVEL_METHOD,
        ...(dep.critical === true ? { critical: true } : {}),
        source: 'declared',
      })
    })
  }

  if (errors.length > 0 || !service) return { ok: false, errors }
  return { ok: true, version, service, edges: dedupePairs(edges), warnings }
}

/**
 * Renders a service's declaration. Only `declared` edges are written (design D6):
 * a `derived` edge has no repository home and must not be silently frozen into
 * one. The output round-trips through `parseDeclaration` (asserted in tests), so
 * the file can be a generated artifact rather than a hand-written one.
 */
export function renderDeclaration(service: string, declaredEdges: readonly RestDependencyEdge[]): string {
  const declared = declaredEdges.filter((edge) => edgeSource(edge) === 'declared')
  const entries = dedupePairs(declared)
    .sort((a, b) => a.toServiceId.localeCompare(b.toServiceId))
    .map(toEntry)
  return `${toYaml({ version: DECLARATION_VERSION, service, dependencies: entries })}\n`
}

/** One declaration entry: `to` always, detail only when the edge carries it. */
function toEntry(edge: RestDependencyEdge): Record<string, YamlValue> {
  const entry: Record<string, YamlValue> = { to: edge.toServiceId }
  if (!isServiceLevelEdge(edge)) {
    entry.method = edge.method || 'GET'
    entry.endpoints = [...edge.endpoints]
  } else if (edge.method && edge.method !== SERVICE_LEVEL_METHOD) {
    // A non-HTTP marker with no detail (e.g. the compose importer's DEPENDS_ON)
    // is still meaningful — keep it so the round trip is lossless.
    entry.method = edge.method
  }
  if (edge.critical === true) entry.critical = true
  return entry
}

/** Collapses duplicate pairs (a file may list the same target twice). */
function dedupePairs(edges: readonly RestDependencyEdge[]): RestDependencyEdge[] {
  const out: RestDependencyEdge[] = []
  const at = new Map<string, number>()
  for (const edge of edges) {
    const index = at.get(edge.toServiceId)
    if (index === undefined) {
      at.set(edge.toServiceId, out.length)
      out.push({ ...edge, endpoints: [...edge.endpoints] })
    } else {
      out[index] = mergeDependencyEdge(out[index]!, edge)
    }
  }
  return out
}

/**
 * Fully explicit form of an edge (defaults applied, `source` always present).
 * Two declaration edge sets are equivalent iff their normalized forms agree —
 * which is exactly what parse → render → parse must preserve.
 */
export function normalizeDeclarationEdge(edge: RestDependencyEdge): RestDependencyEdge {
  const endpoints = Array.isArray(edge.endpoints) ? edge.endpoints.map(String) : []
  const method = typeof edge.method === 'string' && edge.method !== '' ? edge.method : endpoints.length > 0 ? 'GET' : SERVICE_LEVEL_METHOD
  return {
    toServiceId: String(edge.toServiceId ?? '').trim(),
    endpoints,
    method,
    ...(edge.critical === true ? { critical: true } : {}),
    source: edgeSource(edge),
  }
}

/**
 * Reads `<repo>/.helmsman/dependencies.yml`.
 *
 *  - no file → `status: 'missing'`, no error (「该项目未声明依赖」);
 *  - file present but unparseable → `status: 'invalid'` with the concrete
 *    problems and NO edges (spec: no partial application);
 *  - otherwise `status: 'ok'` with the parsed `declared` edges.
 */
export async function readDeclaration(repoPath: string): Promise<DeclarationReadResult> {
  const file = declarationPathFor(repoPath)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { file, exists: false, status: 'missing', edges: [], errors: [], warnings: [] }
    }
    return {
      file,
      exists: true,
      status: 'invalid',
      edges: [],
      errors: [`无法读取声明文件：${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    }
  }
  const parsed = parseDeclaration(text)
  if (!parsed.ok) {
    return { file, exists: true, status: 'invalid', edges: [], errors: parsed.errors, warnings: [] }
  }
  return {
    file,
    exists: true,
    status: 'ok',
    service: parsed.service,
    edges: parsed.edges,
    errors: [],
    warnings: parsed.warnings,
  }
}
