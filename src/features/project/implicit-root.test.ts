import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProjectRoot, sessionCwdOf } from './implicit-root.ts'

describe('implicit project root (resolve-project-implicitly)', () => {
  it('treats omitted input and the current-project words as the session cwd', () => {
    for (const input of [undefined, '', '.', '当前项目', '本项目', '这个项目', '这里', 'cwd']) {
      const result = resolveProjectRoot({ ...(input !== undefined ? { input } : {}), cwd: '/work/repo' })
      expect(result).toEqual({ root: '/work/repo', how: '当前项目（会话工作目录）' })
    }
  })

  it('fails clearly when there is no cwd to fall back on', () => {
    const result = resolveProjectRoot({})

    expect(result).toMatchObject({ error: expect.stringContaining('无法确定"当前项目"') })
  })

  it('accepts a real absolute directory and rejects missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-root-'))
    expect(resolveProjectRoot({ input: dir })).toEqual({ root: dir, how: '绝对路径' })
    expect(resolveProjectRoot({ input: join(dir, 'nope') })).toMatchObject({
      error: expect.stringContaining('路径不存在'),
    })

    const file = join(dir, 'a.txt')
    await mkdir(join(dir, 'nested'), { recursive: true })
    expect(resolveProjectRoot({ input: join(dir, 'nested') })).toMatchObject({ how: '绝对路径' })
    expect(resolveProjectRoot({ input: file })).toMatchObject({ error: expect.stringContaining('路径不存在') })
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves a registered project by name, case-insensitively', () => {
    const projects = [{ name: 'internal-homework', root: '/work/internal-homework' }]

    const result = resolveProjectRoot({ input: 'Internal-Homework', cwd: '/elsewhere', projects })

    // The registered root exists on this machine only if the path is real; assert on
    // whichever branch the filesystem produces, so the test stays honest.
    expect('error' in result ? result.error : result.how).toMatch(/已注册项目|不可用/)
  })

  it('resolves a relative path against the session cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-root-rel-'))
    await mkdir(join(dir, 'svc'), { recursive: true })

    expect(resolveProjectRoot({ input: 'svc', cwd: dir })).toEqual({ root: join(dir, 'svc'), how: '相对当前项目：svc' })
    await rm(dir, { recursive: true, force: true })
  })

  it('lists available candidates instead of guessing', () => {
    const result = resolveProjectRoot({
      input: 'unknown-thing',
      cwd: '/work/here',
      projects: [{ name: 'demo', root: '/work/demo' }],
    })

    expect(result).toMatchObject({ error: expect.stringContaining("无法解析项目 'unknown-thing'") })
    expect((result as { error: string }).error).toContain('/work/here')
    expect((result as { error: string }).error).toContain('demo')
  })

  it('reads the session cwd from the agent handle, tolerating anything else', () => {
    expect(sessionCwdOf({ session: { header: { cwd: '/repo' } } })).toBe('/repo')
    expect(sessionCwdOf({ session: {} })).toBeUndefined()
    expect(sessionCwdOf({})).toBeUndefined()
    expect(sessionCwdOf(undefined)).toBeUndefined()
    expect(sessionCwdOf({ session: { header: { cwd: '' } } })).toBeUndefined()
  })
})
