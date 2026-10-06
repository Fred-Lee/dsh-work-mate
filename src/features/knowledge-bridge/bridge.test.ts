import { mkdtemp, rm, chmod, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitnexusRun, gitnexusAnalyze, gitnexusStatus, gitnexusWiki } from './gitnexus.ts'
import { createWeknoraClient, extractFragments } from './weknora.ts'

let home: string
let binDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-kb-'))
  binDir = join(home, 'bin')
  await import('node:fs/promises').then((fs) => fs.mkdir(binDir, { recursive: true }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Fake `gitnexus` on PATH: asserts argv shape, prints canned output. */
async function installFakeGitnexus(script: string): Promise<void> {
  const path = join(binDir, 'gitnexus')
  await writeFile(path, `#!/bin/sh\necho "$@" > ${join(home, 'argv.txt')}\n${script}\n`, 'utf8')
  await chmod(path, 0o755)
}

describe('gitnexus bridge (fake CLI)', () => {
  it('query passes argv array and returns text output', async () => {
    await installFakeGitnexus('echo "flows: 2"')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusRun('query', home, { target: '评分流程' })

    expect(result.output).toBe('flows: 2')
    const argv = await (await import('node:fs/promises')).readFile(join(home, 'argv.txt'), 'utf8')
    expect(argv.trim()).toBe(`query 评分流程 -l 5 -r ${home.split('/').pop()}`)
  })

  it('impact forwards the direction flag', async () => {
    await installFakeGitnexus('echo impact-ok')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusRun('impact', home, { target: 'Foo.bar', direction: 'downstream' })
    const argv = await (await import('node:fs/promises')).readFile(join(home, 'argv.txt'), 'utf8')

    expect(result.output).toBe('impact-ok')
    expect(argv.trim()).toBe(`impact Foo.bar --direction downstream -r ${home.split('/').pop()}`)
  })

  it('passes -r <repo> so multi-repo global indexes resolve', async () => {
    await installFakeGitnexus('echo multi-ok')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusRun('query', home, { target: 'x' })
    const argv = await (await import('node:fs/promises')).readFile(join(home, 'argv.txt'), 'utf8')

    expect(result.output).toBe('multi-ok')
    expect(argv.trim()).toBe(`query x -l 5 -r ${join(home).split('/').pop()}`)
  })

  it('degrades a missing CLI to a note', async () => {
    const saved = process.env['PATH']
    process.env['PATH'] = binDir // empty dir — gitnexus not found
    try {
      const result = await gitnexusRun('query', home, { target: 'x' })
      expect(result.output).toBe('')
      expect(result.note).toContain('gitnexus query failed')
    } finally {
      if (saved !== undefined) process.env['PATH'] = saved
    }
  })

  it('analyze passes --force/--embeddings and long timeout', async () => {
    await installFakeGitnexus('echo indexed')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusAnalyze(home, { force: true, embeddings: true })
    const argv = await (await import('node:fs/promises')).readFile(join(home, 'argv.txt'), 'utf8')

    expect(result.output).toBe('indexed')
    expect(argv.trim()).toBe(`analyze --force ${home} --embeddings`)
  })
})

const okFetch = (payload: unknown) => async () => ({ ok: true, status: 200, json: async () => payload })

describe('weknora client', () => {
  it('extracts top-k content fragments from a {data: []} payload', async () => {
    const client = createWeknoraClient('http://weknora.test', okFetch({
      data: [
        { content: '片段一' },
        { content: '片段二' },
        { content: '片段三' },
        { content: '片段四' },
      ],
    }) as never)

    const result = await client.search(home, '评分流程', 3)
    expect(result.fragments).toEqual(['片段一', '片段二', '片段三'])
  })

  it('degrades on non-2xx and on unreadable shapes', async () => {
    const bad = createWeknoraClient('http://weknora.test', (async () => ({ ok: false, status: 502, json: async () => ({}) })) as never)
    expect((await bad.search(home, 'q')).note).toContain('502')

    const empty = createWeknoraClient('http://weknora.test', okFetch({ data: 'not-an-array' }) as never)
    expect((await empty.search(home, 'q')).note).toContain('no readable fragments')
  })

  it('extractFragments falls back to array payloads and text fields', () => {
    expect(extractFragments([{ text: 'a' }, { unrelated: 1 }, 'str', null], 5)).toEqual(['a'])
  })
})

describe('gitnexus wiki bridge (fake CLI)', () => {
  it('reports staleness from `status` without re-indexing', async () => {
    await installFakeGitnexus('echo "Status: stale (re-run gitnexus analyze)"')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusStatus(home)

    expect(result.stale).toBe(true)
    expect(result.output).toContain('stale')
  })

  it('treats a failing probe as stale, never as fresh', async () => {
    const saved = process.env['PATH']
    process.env['PATH'] = binDir
    try {
      const result = await gitnexusStatus(home)
      expect(result.stale).toBe(true)
      expect(result.note).toContain('gitnexus status failed')
    } finally {
      if (saved !== undefined) process.env['PATH'] = saved
    }
  })

  it('passes force/lang and returns the fixed wiki paths', async () => {
    await installFakeGitnexus('echo "wiki written"')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusWiki(home, { force: true, lang: 'chinese' })

    expect(result.wikiDir).toBe(join(home, '.gitnexus', 'wiki'))
    expect(result.indexHtml).toBe(join(home, '.gitnexus', 'wiki', 'index.html'))
    expect(result.output).toContain('wiki written')
    const argv = await readFile(join(home, 'argv.txt'), 'utf8')
    expect(argv).toContain('wiki')
    expect(argv).toContain('--force')
    expect(argv).toContain('--lang chinese')
  })

  it('surfaces an actionable note when generation fails', async () => {
    await installFakeGitnexus('echo "no LLM provider configured" >&2; exit 1')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusWiki(home)

    expect(result.output).toBe('')
    expect(result.note).toContain('gitnexus wiki failed')
    expect(result.note).toContain('~/.gitnexus/config.json')
  })
})
