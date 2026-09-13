/**
 * Persisted derive-ignore list ("忽略并记住", change `persist-derive-ignores`).
 *
 * Derivation candidates include external-infrastructure targets (an `oss.url`
 * config key genuinely names something the service calls, but it is not a
 * microservice to register). Per-row "ignore" used to be front-end-only state,
 * so the same rows came back on every derive. This store remembers ignored
 * pairs per project group, at `~/.helmsman/derive-ignores.json` (atomic
 * tmp+rename, HELMSMAN_HOME-aware) — the same durability rules as the rest of
 * the state under ~/.helmsman.
 *
 * The list only shapes DERIVATION RESULTS: it never touches stored dependency
 * edges, declaration files or the topology (derivation itself is read-only).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SCHEMA_VERSION = 1

export interface DeriveIgnoreEntry {
  /** `from→to` pair key (see `derivePairKey`). */
  key: string
  /** When the ignore was recorded (epoch ms). */
  at: number
  /** Why it was ignored — the candidate's target at ignore time (display only). */
  note?: string
}

interface IgnoreFile {
  schemaVersion: number
  /** group id → ignored pairs. */
  groups: Record<string, DeriveIgnoreEntry[]>
}

function ignoreFile(): string {
  const home = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(home, 'derive-ignores.json')
}

function emptyFile(): IgnoreFile {
  return { schemaVersion: SCHEMA_VERSION, groups: {} }
}

function normalize(raw: unknown): IgnoreFile {
  if (typeof raw !== 'object' || raw === null) return emptyFile()
  const r = raw as Record<string, unknown>
  if (r.schemaVersion !== SCHEMA_VERSION) return emptyFile()
  const groups: Record<string, DeriveIgnoreEntry[]> = {}
  const rawGroups = typeof r.groups === 'object' && r.groups !== null ? (r.groups as Record<string, unknown>) : {}
  for (const [group, list] of Object.entries(rawGroups)) {
    if (!Array.isArray(list)) continue
    groups[group] = list
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && typeof (e as { key?: unknown }).key === 'string')
      .map((e) => ({
        key: String(e.key),
        at: typeof e.at === 'number' ? e.at : 0,
        ...(typeof e.note === 'string' && e.note !== '' ? { note: e.note } : {}),
      }))
  }
  return { schemaVersion: SCHEMA_VERSION, groups }
}

function load(): IgnoreFile {
  const file = ignoreFile()
  if (!existsSync(file)) return emptyFile()
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // Corrupt: fail closed the same way the board store does — surface the
    // problem instead of silently resetting the user's ignore list.
    throw new Error(`derive-ignore 文件损坏，无法解析：${file}（请手工修复或删除该文件）`)
  }
}

function save(file: IgnoreFile): void {
  const target = ignoreFile()
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

/** Pair keys currently ignored for `group`. */
export function listIgnored(group: string): DeriveIgnoreEntry[] {
  return load().groups[group] ?? []
}

/** True when `key` is ignored for `group`. */
export function isIgnored(group: string, key: string): boolean {
  return load().groups[group]?.some((e) => e.key === key) ?? false
}

/** Records ignores (idempotent per key); returns the group's full list after. */
export function ignoreCandidates(group: string, keys: readonly string[], note?: string): DeriveIgnoreEntry[] {
  const file = load()
  const list = file.groups[group] ?? []
  const at = Date.now()
  for (const key of keys) {
    if (!key || list.some((e) => e.key === key)) continue
    list.push({ key, at, ...(note ? { note } : {}) })
  }
  file.groups[group] = list
  save(file)
  return list
}

/** Restores ignores: the given keys, or ALL for the group when omitted. */
export function restoreIgnoredCandidates(group: string, keys?: readonly string[]): DeriveIgnoreEntry[] {
  const file = load()
  if (!keys || keys.length === 0) {
    delete file.groups[group]
  } else {
    const drop = new Set(keys)
    file.groups[group] = (file.groups[group] ?? []).filter((e) => !drop.has(e.key))
    if (file.groups[group]!.length === 0) delete file.groups[group]
  }
  save(file)
  return file.groups[group] ?? []
}

/** Test seam: point the store at a temp directory. Returns the previous env value. */
export function setIgnoreHomeForTests(home: string | undefined): string | undefined {
  const prev = process.env.HELMSMAN_HOME
  if (home === undefined) delete process.env.HELMSMAN_HOME
  else process.env.HELMSMAN_HOME = home
  return prev
}
