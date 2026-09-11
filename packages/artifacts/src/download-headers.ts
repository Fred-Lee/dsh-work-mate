/**
 * Download-header helpers for artifact delivery (design.md D4).
 *
 * Centralized here (in the artifacts package) so every host serves downloads
 * with the same Content-Disposition / Content-Type. Non-ASCII file names are
 * common (Helmsman drafts/notes are often Chinese-named), and a raw non-ASCII
 * `filename` would break clients, so RFC 5987 `filename*` is required rather
 * than optional: we always pair an ASCII-only quoted fallback with a
 * `filename*=UTF-8''<percent-encoded>` extension when the name is not
 * plain ASCII.
 */

export const DEFAULT_ARTIFACT_MIME = 'application/octet-stream'

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.patch': 'text/plain',
  '.diff': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.txt': 'text/plain',
}

/** MIME table lookup by file extension (.md → text/markdown, …). */
export function mimeForFileName(fileName: string): string {
  const ext = extensionOf(fileName)
  if (ext) {
    const mime = MIME_BY_EXT[ext]
    if (mime) return mime
  }
  return DEFAULT_ARTIFACT_MIME
}

/**
 * Builds a `Content-Disposition` header value, e.g.
 *   attachment; filename="report.md"
 *   attachment; filename="____.md"; filename*=UTF-8''%E7%A0%94...md
 *
 * The header is always ASCII-only; the RFC 5987 part carries the original
 * name for CJK-safe downloads.
 */
export function contentDispositionHeader(fileName: string): string {
  const original = sanitizeFileName(fileName)
  const asciiFallback = asciiFallbackFor(original)
  if (asciiFallback === original) {
    return `attachment; filename="${original}"`
  }
  const encoded = encodeRFC5987Value(original)
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

export interface DownloadHeaders {
  'content-disposition': string
  'content-type': string
}

/** Convenience for hosts that need both delivery headers at once. */
export function downloadHeaders(fileName: string): DownloadHeaders {
  return {
    'content-disposition': contentDispositionHeader(fileName),
    'content-type': mimeForFileName(fileName),
  }
}

function extensionOf(fileName: string): string | undefined {
  const base = sanitizeFileName(fileName)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return undefined
  return base.slice(dot).toLowerCase()
}

/** Strip path separators and header-injecting control characters. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\\/]/g, '_').replace(/[\r\n]/g, '')
}

/** Printable-ASCII view of the name; anything else becomes `_`. */
function asciiFallbackFor(name: string): string {
  let out = ''
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    out += code >= 0x20 && code <= 0x7e && ch !== '"' && ch !== '\\' ? ch : '_'
  }
  return out === '' ? 'download' : out
}

/** RFC 5987 attr-char percent-encoding (UTF-8). */
function encodeRFC5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
