import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from './registry.ts'
import { StoreCorruptError } from '../proposal/store.ts'

let home: string
let registry: ProjectRegistry

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-registry-'))
  registry = new ProjectRegistry({ homeRoot: home, subdir: 'workmate' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('ProjectRegistry', () => {
  it('reads a missing file as an empty registry', async () => {
    await expect(registry.list()).resolves.toEqual([])
    await expect(registry.get('ghost')).resolves.toBeUndefined()
  })

  it('round-trips upsert / get / list / remove and re-roots by name', async () => {
    await registry.upsert('demo', home)
    await registry.upsert('demo', join(home, 'nested'))
    await registry.upsert('other', home)

    await expect(registry.list()).resolves.toEqual([
      { name: 'demo', root: join(home, 'nested') },
      { name: 'other', root: home },
    ])
    await expect(registry.remove('demo')).resolves.toBe(true)
    await expect(registry.remove('demo')).resolves.toBe(false)
    await expect(registry.list()).resolves.toHaveLength(1)
  })

  it('rejects a relative or traversing root', async () => {
    await expect(registry.upsert('bad', 'relative/path')).rejects.toThrow('absolute path')
    await expect(registry.upsert('bad', '/srv/../etc')).rejects.toThrow('traverse upward')
    await expect(registry.upsert('  ', home)).rejects.toThrow('non-empty')
  })

  it('fails closed on a corrupt registry and never overwrites it', async () => {
    const { file } = registry.paths()
    await mkdir(join(home, 'workmate'), { recursive: true })
    const corrupt = '[{"name":"demo","root":"/srv/demo"}'
    await writeFile(file, corrupt, 'utf8')

    await expect(registry.list()).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(registry.get('demo')).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(registry.upsert('fresh', home)).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(registry.remove('demo')).rejects.toBeInstanceOf(StoreCorruptError)

    // The damaged bytes are still there: fail-closed, never "reset to empty".
    await expect(readFile(file, 'utf8')).resolves.toBe(corrupt)
  })

  it('treats a non-array payload as corruption too', async () => {
    const { file } = registry.paths()
    await mkdir(join(home, 'workmate'), { recursive: true })
    await writeFile(file, '{"demo":"/srv/demo"}', 'utf8')
    await expect(registry.list()).rejects.toBeInstanceOf(StoreCorruptError)
  })
})
