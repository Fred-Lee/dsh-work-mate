/**
 * Minimal YAML support:
 *  - `parseYamlSubset`: indentation-based maps/sequences + scalars + inline
 *    lists — enough for docker-compose files, K8s manifests, and Helmsman's
 *    own topology export format. Block scalars (|, >) are not supported.
 *  - `toYaml`: emitter for topology export.
 *
 * Written in-house on purpose: pulling a full YAML library into a DSH plugin
 * adds supply-chain surface for little gain (see docs/SECURITY-AUDIT.md).
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

export function parseYamlSubset(text: string): YamlValue {
  const lines = text.split('\n')
  let pos = 0

  function parseBlock(minIndent: number): YamlValue {
    skipBlank()
    if (pos >= lines.length) return null
    const indent = indentOf(lines[pos]!)
    if (indent < minIndent) return null

    if (lines[pos]!.trimStart().startsWith('- ')) {
      const list: YamlValue[] = []
      const listIndent = indent
      while (pos < lines.length) {
        skipBlank()
        if (pos >= lines.length) break
        const line = lines[pos]!
        const cur = indentOf(line)
        if (cur < listIndent || !line.trimStart().startsWith('- ')) break
        if (cur > listIndent) break
        const itemText = line.trimStart().slice(2).trim()
        pos += 1
        if (itemText === '') {
          list.push(parseBlock(listIndent + 1))
        } else if (itemText.includes(': ') || itemText.endsWith(':')) {
          // inline map start: re-parse this item as a map whose first key is on this line
          const obj: { [key: string]: YamlValue } = {}
          const kv = splitKv(itemText)
          if (kv) {
            const nestedIndent = cur + 2 + 0
            if (kv.value === '') {
              obj[kv.key] = parseNestedAfterKey(nestedIndent)
            } else {
              obj[kv.key] = parseScalar(kv.value)
            }
          }
          // continuation keys at deeper-or-equal indent
          while (pos < lines.length) {
            skipBlank()
            if (pos >= lines.length) break
            const l2 = lines[pos]!
            const i2 = indentOf(l2)
            if (i2 <= cur) break
            const t2 = l2.trim()
            if (t2.startsWith('- ')) break
            const kv2 = splitKv(t2)
            pos += 1
            if (!kv2) continue
            if (kv2.value === '') {
              obj[kv2.key] = parseNestedAfterKey(i2)
            } else {
              obj[kv2.key] = parseScalar(kv2.value)
            }
          }
          list.push(obj)
        } else {
          list.push(parseScalar(itemText))
        }
      }
      return list
    }

    // mapping
    const map: { [key: string]: YamlValue } = {}
    const mapIndent = indent
    while (pos < lines.length) {
      skipBlank()
      if (pos >= lines.length) break
      const line = lines[pos]!
      const cur = indentOf(line)
      if (cur < mapIndent) break
      if (cur > mapIndent) {
        pos += 1 // stray deeper line — skip defensively
        continue
      }
      const t = line.trim()
      if (t.startsWith('- ')) break
      const kv = splitKv(t)
      pos += 1
      if (!kv) continue
      if (kv.value === '') {
        map[kv.key] = parseNestedAfterKey(cur)
      } else {
        map[kv.key] = parseScalar(kv.value)
      }
    }
    return map
  }

  /** After `key:` with empty value, parse the nested block if any, else null. */
  function parseNestedAfterKey(parentIndent: number): YamlValue {
    const probe = peekNextMeaningful()
    if (probe === null) return null
    if (indentOf(lines[probe]!) > parentIndent) return parseBlock(parentIndent + 1)
    return null
  }

  function peekNextMeaningful(): number | null {
    let p = pos
    while (p < lines.length) {
      const t = lines[p]!.trim()
      if (t !== '' && !t.startsWith('#')) return p
      p += 1
    }
    return null
  }

  function skipBlank(): void {
    while (pos < lines.length) {
      const t = lines[pos]!.trim()
      if (t === '' || t.startsWith('#')) pos += 1
      else break
    }
  }

  return parseBlock(0)
}

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 2 // treat tabs as 2 spaces (non-standard, lenient)
    else break
  }
  return n
}

function splitKv(text: string): { key: string; value: string } | null {
  const m = text.match(/^([^:]+):(?:\s+(.*))?$/)
  if (!m) return null
  return { key: unquote(m[1]!.trim()), value: (m[2] ?? '').trim() }
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

export function parseScalar(raw: string): YamlValue {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineList(inner).map((item) => parseScalar(item))
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    const obj: { [key: string]: YamlValue } = {}
    if (!inner) return obj
    for (const pair of splitTopLevel(inner, ',')) {
      const kv = splitKv(pair.trim())
      if (kv) obj[kv.key] = parseScalar(kv.value)
    }
    return obj
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return unquote(s)
  if (s === 'true' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === 'no' || s === 'off') return false
  if (/^[-+]?\d+$/.test(s)) return Number(s)
  if (/^[-+]?\d*\.\d+$/.test(s)) return Number(s)
  return s
}

function splitInlineList(inner: string): string[] {
  return splitTopLevel(inner, ',').map((s) => s.trim()).filter(Boolean)
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === sep && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') out.push(current)
  return out
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

export function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return quoteIfNeeded(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map((item) => {
      if (isScalar(item)) return `${pad}- ${toYaml(item)}`
      const nested = toYaml(item, indent + 1)
      return `${pad}-\n${nested}`
    }).join('\n')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return entries.map(([key, val]) => {
    if (isScalar(val) || (Array.isArray(val) && val.every(isScalar) && val.length > 0) || (Array.isArray(val) && val.length === 0)) {
      return `${pad}${quoteIfNeeded(key)}: ${toYaml(val)}`
    }
    const nested = toYaml(val, indent + 1)
    if (nested === 'null' || nested === '{}' || nested === '[]') return `${pad}${quoteIfNeeded(key)}: ${nested}`
    return `${pad}${quoteIfNeeded(key)}:\n${nested}`
  }).join('\n')
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function quoteIfNeeded(s: string): string {
  const plain = /^[A-Za-z0-9_./\- ]+$/.test(s) && !/^[\s]|[\s]$/.test(s)
  const ambiguous = /^(\d|true$|false$|null$|yes$|no$|on$|off$)/.test(s)
  if (plain && !ambiguous) return s
  return `'${s.replace(/'/g, "''")}'`
}
