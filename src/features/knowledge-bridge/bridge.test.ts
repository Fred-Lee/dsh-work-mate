import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  gitnexusAnalyze,
  gitnexusRun,
  gitnexusStatus,
  gitnexusWiki,
  parseWikiSummary,
  setGitnexusApiKeyEnv,
  setGitnexusKeychainService,
} from './gitnexus.ts'
import { createWeknoraClient, extractFragments } from './weknora.ts'

let home: string
let binDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-kb-'))
  binDir = join(home, 'bin')
  await import('node:fs/promises').then((fs) => fs.mkdir(binDir, { recursive: true }))
  // The wiki path now fails fast without a credential; give the fake CLI one.
  process.env['GITNEXUS_API_KEY'] = 'sk-test-key'
})

afterEach(async () => {
  delete process.env['GITNEXUS_API_KEY']
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
    const wikiDir = join(home, '.gitnexus', 'wiki')
    await installFakeGitnexus(
      `mkdir -p ${wikiDir} && echo '<html></html>' > ${wikiDir}/index.html && echo '# a' > ${wikiDir}/module-a.md && echo "wiki written"`,
    )
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusWiki(home, { force: true, lang: 'chinese' })

    expect(result.wikiDir).toBe(wikiDir)
    expect(result.indexHtml).toBe(join(wikiDir, 'index.html'))
    expect(result.pages).toBe(1)
    expect(result.complete).toBe(true)
    expect(result.note).toBeUndefined()
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

  it('flags a half-written wiki even when the CLI reports success', async () => {
    const wikiDir = join(home, '.gitnexus', 'wiki')
    await installFakeGitnexus(
      `mkdir -p ${wikiDir} && echo '# a' > ${wikiDir}/module-a.md && echo '# b' > ${wikiDir}/module-b.md && echo "done"`,
    )
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusWiki(home)

    expect(result.complete).toBe(false)
    expect(result.pages).toBe(2)
    expect(result.note).toContain('生成中断')
    expect(result.note).toContain('缺少 index.html')
  })

  it('keeps the artifact facts when generation fails outright', async () => {
    const wikiDir = join(home, '.gitnexus', 'wiki')
    await installFakeGitnexus(
      `mkdir -p ${wikiDir} && echo '# a' > ${wikiDir}/module-a.md && echo "circuit open" >&2; exit 1`,
    )
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusWiki(home)

    expect(result.complete).toBe(false)
    expect(result.pages).toBe(1)
    expect(result.note).toContain('gitnexus wiki failed')
    expect(result.note).toContain('complete=false')
  })
})

describe('wiki credential preflight and stale artifacts (fail-fast-wiki-credentials)', () => {
  it('fails fast without running the CLI when no credential is configured', async () => {
    const wikiDir = join(home, '.gitnexus', 'wiki')
    await mkdir(wikiDir, { recursive: true })
    await writeFile(join(wikiDir, 'old.md'), '# old', 'utf8')
    await writeFile(join(wikiDir, 'index.html'), '<html>old</html>', 'utf8')
    // Backdate: these belong to an EARLIER run, which is exactly what must not be
    // mistaken for this run's output.
    const old = new Date(Date.now() - 60_000)
    await utimes(join(wikiDir, 'old.md'), old, old)
    await utimes(join(wikiDir, 'index.html'), old, old)
    await installFakeGitnexus('echo "should not run"; exit 1')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`
    setGitnexusApiKeyEnv('')
    setGitnexusKeychainService('')

    const savedKey = process.env['GITNEXUS_API_KEY']
    delete process.env['GITNEXUS_API_KEY']
    delete process.env['OPENAI_API_KEY']
    try {
      const result = await gitnexusWiki(home)
      expect(result.complete).toBe(false)
      expect(result.note).toContain('缺少网关凭据')
      // The earlier run's wiki must never be reported as this run's output.
      expect(result.pages).toBe(0)
      expect(result.staleArtifacts).toBe(true)
      const argv = await readFile(join(home, 'argv.txt'), 'utf8').catch(() => '')
      expect(argv).toBe('')
    } finally {
      if (savedKey !== undefined) process.env['GITNEXUS_API_KEY'] = savedKey
    }
  })

  it('accepts a keychain-provided key for the child process', async () => {
    setGitnexusKeychainService('ESP_XKW_KEY')
    await installFakeGitnexus('echo "wiki written"; mkdir -p .gitnexus/wiki; echo x > .gitnexus/wiki/a.md; echo "<html></html>" > .gitnexus/wiki/index.html')
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

    const result = await gitnexusWiki(home)

    expect(result.complete).toBe(true)
    expect(result.pages).toBe(1)
    setGitnexusKeychainService('')
  })
})

describe('wiki CLI summary parsing (clarify-wiki-outcome)', () => {
  it('reads the CLI summary lines', () => {
    const summary = parseWikiSummary(
      'Wiki generated successfully (576.4s)\n  Mode: full\n  Pages: 49\n  Viewer: /x/index.html',
    )

    expect(summary).toEqual({ upToDate: false, mode: 'full', reportedPages: 49, cliElapsedSeconds: 576.4 })
  })

  it('recognizes the up-to-date answer', () => {
    const summary = parseWikiSummary('  Wiki is already up to date.\n  Viewer: /x/index.html')

    expect(summary.upToDate).toBe(true)
    expect(summary.mode).toBeUndefined()
  })

  it('treats an up-to-date run as success even when artifacts are older', async () => {
    const wikiDir = join(home, '.gitnexus', 'wiki')
    await installFakeGitnexus(
      `mkdir -p ${wikiDir} && echo '<html></html>' > ${wikiDir}/index.html && echo '# a' > ${wikiDir}/a.md && ` +
        'echo "  Wiki is already up to date." && echo "  Viewer: "',
    )
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`
    // Backdate the artifacts: an up-to-date answer legitimately leaves them alone.
    const old = new Date(Date.now() - 600_000)
    await mkdir(wikiDir, { recursive: true })
    await writeFile(join(wikiDir, 'a.md'), '# a', 'utf8')
    await writeFile(join(wikiDir, 'index.html'), '<html></html>', 'utf8')
    await utimes(join(wikiDir, 'a.md'), old, old)
    await utimes(join(wikiDir, 'index.html'), old, old)

    const result = await gitnexusWiki(home)

    expect(result.upToDate).toBe(true)
    expect(result.complete).toBe(true)
    expect(result.pages).toBe(1)
    expect(result.staleArtifacts).toBe(false)
  })
})
