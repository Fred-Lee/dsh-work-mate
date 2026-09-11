import { describe, expect, it } from 'vitest'
import {
  contentDispositionHeader,
  downloadHeaders,
  mimeForFileName,
} from './download-headers.ts'

describe('mimeForFileName', () => {
  it('maps the delivery MIME table (md/json/patch/diff/yaml/yml/txt)', () => {
    expect(mimeForFileName('a.md')).toBe('text/markdown')
    expect(mimeForFileName('b.json')).toBe('application/json')
    expect(mimeForFileName('c.patch')).toBe('text/plain')
    expect(mimeForFileName('d.diff')).toBe('text/plain')
    expect(mimeForFileName('e.yaml')).toBe('application/yaml')
    expect(mimeForFileName('f.yml')).toBe('application/yaml')
    expect(mimeForFileName('g.txt')).toBe('text/plain')
  })

  it('matches case-insensitively', () => {
    expect(mimeForFileName('A.MD')).toBe('text/markdown')
    expect(mimeForFileName('TOPOLOGY.YAML')).toBe('application/yaml')
  })

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeForFileName('archive.tar.gz')).toBe('application/octet-stream')
    expect(mimeForFileName('no-extension')).toBe('application/octet-stream')
    expect(mimeForFileName('trailing.')).toBe('application/octet-stream')
  })
})

describe('contentDispositionHeader', () => {
  it('uses a plain ASCII filename without filename*', () => {
    expect(contentDispositionHeader('draft.md')).toBe('attachment; filename="draft.md"')
  })

  it('keeps spaces inside the quoted ASCII form', () => {
    expect(contentDispositionHeader('my draft notes.md')).toBe(
      'attachment; filename="my draft notes.md"',
    )
  })

  it('adds an RFC 5987 filename* for CJK filenames and stays ASCII-safe', () => {
    const header = contentDispositionHeader('研究笔记.md')

    expect(header.startsWith('attachment; filename="')).toBe(true)
    expect(header).toContain("filename*=UTF-8''")

    const starPart = header.slice(header.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length)
    expect(decodeURIComponent(starPart)).toBe('研究笔记.md')

    // No raw non-ASCII bytes leak into the header.
    for (const ch of header) {
      expect(ch.charCodeAt(0)).toBeLessThan(128)
    }
  })

  it('percent-encodes an emoji filename too', () => {
    const header = contentDispositionHeader('报告🚀.json')
    const starPart = header.slice(header.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length)
    expect(decodeURIComponent(starPart)).toBe('报告🚀.json')
    expect(mimeForFileName('报告🚀.json')).toBe('application/json')
  })

  it('sanitizes quotes, backslashes and control characters out of the header', () => {
    const hostile = contentDispositionHeader('a"b\\c\r\nd.txt')
    expect(hostile).not.toContain('\r')
    expect(hostile).not.toContain('\n')
    expect(hostile).not.toContain('a"b')

    const quoted = contentDispositionHeader('a"b.txt')
    expect(quoted).not.toContain('a"b')
    expect(quoted).toContain("filename*=UTF-8''")
  })
})

describe('downloadHeaders', () => {
  it('returns the two delivery headers a host needs', () => {
    const headers = downloadHeaders('归档笔记.md')
    expect(headers['content-type']).toBe('text/markdown')
    expect(headers['content-disposition']).toContain('attachment; filename=')
    expect(headers['content-disposition']).toContain("filename*=UTF-8''")
  })

  it('returns plain headers for an ASCII patch file', () => {
    const headers = downloadHeaders('task-42.bundle.patch')
    expect(headers).toEqual({
      'content-disposition': 'attachment; filename="task-42.bundle.patch"',
      'content-type': 'text/plain',
    })
  })
})
