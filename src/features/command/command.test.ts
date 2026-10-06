import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseWorkmateInput, workmateUsage } from './parse.ts'
import { inspectWikiArtifacts, workmateCommandDefinition, type CommandDeps } from './definition.ts'

const deps = (overrides: Partial<CommandDeps> = {}): CommandDeps => ({
  ensureProxy: vi.fn(async () => ({ status: 'reused' })),
  projects: vi.fn(async () => []),
  status: vi.fn(async () => ({ stale: false, output: '' })),
  analyze: vi.fn(async () => ({})),
  wiki: vi.fn(async () => ({
    wikiDir: '/repo/.gitnexus/wiki',
    indexHtml: '/repo/.gitnexus/wiki/index.html',
    pages: 47,
    complete: true,
    output: 'wiki generated',
  })),
  configuredLang: 'chinese',
  ...overrides,
})

describe('/workmate parsing (add-workmate-command)', () => {
  it('treats empty and help tokens as help', () => {
    for (const input of ['', '   ', 'help', '--help', '-h']) {
      expect(parseWorkmateInput(input)).toEqual({ action: 'help', force: false, reanalyze: false })
    }
    expect(workmateUsage()).toContain('/workmate wiki')
  })

  it('parses wiki flags in any order', () => {
    expect(parseWorkmateInput('wiki /repo --force --reanalyze --lang english')).toEqual({
      action: 'wiki',
      projectRoot: '/repo',
      force: true,
      reanalyze: true,
      lang: 'english',
    })
    expect(parseWorkmateInput('wiki /repo')).toEqual({
      action: 'wiki',
      projectRoot: '/repo',
      force: false,
      reanalyze: false,
    })
  })

  it('rejects unknown subcommands, flags, extra paths and relative paths', () => {
    expect(parseWorkmateInput('deploy /repo')).toMatchObject({ error: expect.stringContaining('未知子命令') })
    expect(parseWorkmateInput('wiki /repo --verbose')).toMatchObject({ error: expect.stringContaining('未知旗标') })
    expect(parseWorkmateInput('wiki /a /b')).toMatchObject({ error: expect.stringContaining('多余参数') })
    // 路径可选：省略是合法输入（= 当前项目），相对路径也交给解析器
    expect(parseWorkmateInput('wiki')).toEqual({ action: 'wiki', force: false, reanalyze: false })
    expect(parseWorkmateInput('wiki repo')).toEqual({ action: 'wiki', projectRoot: 'repo', force: false, reanalyze: false })
    expect(parseWorkmateInput('wiki /repo --lang')).toMatchObject({ error: expect.stringContaining('--lang') })
  })
})

describe('/workmate handler', () => {
  const invocation = (rawInput: string, cwd?: string): { rawInput: string; agent?: { session: { header: { cwd: string } } } } => ({
    rawInput,
    ...(cwd !== undefined ? { agent: { session: { header: { cwd } } } } : {}),
  })

  it('reports usage for help and never touches the bridges', async () => {
    const d = deps()
    const result = await workmateCommandDefinition(d).handler(invocation(''))

    expect(result.kind).toBe('success')
    expect(result.text).toContain('status')
    expect(d.wiki).not.toHaveBeenCalled()
  })

  it('status is read-only and reports artifacts honestly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-command-'))
    await mkdir(join(dir, '.gitnexus', 'wiki'), { recursive: true })
    await writeFile(join(dir, '.gitnexus', 'wiki', 'module-a.md'), '# a', 'utf8')
    const d = deps({ status: vi.fn(async () => ({ stale: true, output: '' })) })

    const result = await workmateCommandDefinition(d).handler(invocation(`status ${dir}`))

    expect(result.kind).toBe('success')
    expect(result.text).toContain('stale')
    expect(result.text).toContain('complete=false')
    expect(result.text).toContain('pages=1')
    expect(d.wiki).not.toHaveBeenCalled()
    await rm(dir, { recursive: true, force: true })
  })

  it('wiki run reports complete/pages and the reader path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-command-wiki-'))
    const d = deps()

    const result = await workmateCommandDefinition(d).handler(invocation(`wiki ${dir} --force`))

    expect(result.kind).toBe('success')
    expect(result.text).toContain('✅ 成功')
    expect(result.text).toContain('页数：47')
    expect(result.text).toContain('index.html')
    expect(d.ensureProxy).toHaveBeenCalled()
    expect(d.wiki).toHaveBeenCalledWith(dir, { force: true, lang: 'chinese' })
    await rm(dir, { recursive: true, force: true })
  })

  it('a half-written wiki is an error, not a success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-command-half-'))
    const d = deps({
      wiki: vi.fn(async () => ({
        wikiDir: join(dir, '.gitnexus', 'wiki'),
        indexHtml: join(dir, '.gitnexus', 'wiki', 'index.html'),
        pages: 34,
        complete: false,
        output: '',
        note: '生成中断：缺 index.html',
      })),
    })

    const result = await workmateCommandDefinition(d).handler(invocation(`wiki ${dir}`))

    expect(result.kind).toBe('error')
    expect(result.text).toContain('❌ 未完成')
    expect(result.text).toContain('本次页数：34')
    expect(result.text).toContain('缺 index.html')
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to generate when the proxy cannot be ensured, and when re-indexing fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-command-proxy-'))
    const broken = deps({ ensureProxy: vi.fn(async () => ({ status: 'failed', note: '端口被别的实例占用' })) })
    const proxyResult = await workmateCommandDefinition(broken).handler(invocation(`wiki ${dir}`))
    expect(proxyResult.kind).toBe('error')
    expect(proxyResult.text).toContain('端口被别的实例占用')
    expect(broken.wiki).not.toHaveBeenCalled()

    const reindexFails = deps({ analyze: vi.fn(async () => ({ note: 'gitnexus analyze failed' })) })
    const reindexResult = await workmateCommandDefinition(reindexFails).handler(invocation(`wiki ${dir} --reanalyze`))
    expect(reindexResult.kind).toBe('error')
    expect(reindexResult.text).toContain('重索引失败')
    expect(reindexFails.wiki).not.toHaveBeenCalled()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects a missing path before doing any work', async () => {
    const d = deps()
    const result = await workmateCommandDefinition(d).handler(invocation('wiki /definitely/not/here'))

    expect(result.kind).toBe('error')
    expect(result.text).toContain('路径不存在')
    expect(d.ensureProxy).not.toHaveBeenCalled()
  })
})

describe('inspectWikiArtifacts', () => {
  it('counts pages, detects the reader and its size, and tolerates a missing dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-inspect-'))
    const wikiDir = join(dir, '.gitnexus', 'wiki')
    await mkdir(wikiDir, { recursive: true })
    await writeFile(join(wikiDir, 'a.md'), '# a', 'utf8')
    await writeFile(join(wikiDir, 'index.html'), '<html></html>', 'utf8')

    expect(await inspectWikiArtifacts(dir)).toEqual({ pages: 1, complete: true, indexBytes: 13 })
    expect(await inspectWikiArtifacts(join(dir, 'nope'))).toEqual({ pages: 0, complete: false, indexBytes: 0 })
    await rm(dir, { recursive: true, force: true })
  })
})
describe('implicit project resolution (resolve-project-implicitly)', () => {
  const invocation = (rawInput: string, cwd?: string) => ({
    rawInput,
    ...(cwd !== undefined ? { agent: { session: { header: { cwd } } } } : {}),
  })

  it('defaults to the session project when no path is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-command-cwd-'))
    const d = deps({
      wiki: vi.fn(async () => ({
        wikiDir: join(dir, '.gitnexus', 'wiki'),
        indexHtml: join(dir, '.gitnexus', 'wiki', 'index.html'),
        pages: 12,
        complete: true,
        output: '',
      })),
    })

    const result = await workmateCommandDefinition(d).handler(invocation('wiki', dir))

    expect(result.kind).toBe('success')
    expect(result.text).toContain('当前项目（会话工作目录）')
    expect(result.text).toContain(dir)
    expect(d.wiki).toHaveBeenCalledWith(dir, { force: false, lang: 'chinese' })
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves a registered project name and lists candidates when unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-command-named-'))
    const named = deps({ projects: vi.fn(async () => [{ name: 'demo', root: dir }]) })
    const okResult = await workmateCommandDefinition(named).handler(invocation('status demo', tmpdir()))
    expect(okResult.kind).toBe('success')
    expect(okResult.text).toContain('已注册项目 demo')

    const unknown = await workmateCommandDefinition(deps()).handler(invocation('status nowhere', tmpdir()))
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('无法解析项目')
    await rm(dir, { recursive: true, force: true })
  })
})
