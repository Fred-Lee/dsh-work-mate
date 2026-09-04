/**
 * Zero-dependency YAML-frontmatter codec for the Helmsman vault.
 *
 * We only need a scalar/array subset (keys we ourselves write: kind, title,
 * createdAt, archivedAt, linkedProjects, keywords). Full YAML (nested objects,
 * anchors) is deliberately out of scope — this is Helmsman's own vault, and we
 * are the only writer. Tolaria notes opened in other tools remain plain
 * markdown with a frontmatter block they can ignore.
 */
const FM_START = '---\n'

/** Parse leading `--- ... ---` into frontmatter + body. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith(FM_START)) return { frontmatter: {}, body: text }
  const close = text.indexOf('\n---', FM_START.length)
  if (close === -1) return { frontmatter: {}, body: text }
  const fmText = text.slice(FM_START.length, close)
  const body = text.slice(close + '\n---'.length).replace(/^\n+/, '')
  return { frontmatter: parseKeyValues(fmText), body }
}

/** Serialize a scalar/array frontmatter block. */
export function serializeFrontmatter(meta: Record<string, unknown>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue
    lines.push(`${key}: ${formatValue(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/** Compose a full note file (frontmatter + blank line + body). */
export function composeNote(meta: Record<string, unknown>, body: string): string {
  return `${serializeFrontmatter(meta)}\n\n${body.trim()}`
}

function parseKeyValues(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const rawLine of fm.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf(':')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1).trim())
  }
  return out
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => parseScalar(s.trim()))
      .filter((s) => s !== '')
  }
  return parseScalar(raw)
}

function parseScalar(s: string): string | boolean | number {
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s.replace(/^['"]|['"]$/g, '')
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => formatValue(v)).join(', ')}]`
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return String(value)
}
