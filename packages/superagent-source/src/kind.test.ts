import { describe, expect, it } from 'vitest'
import {
  DESCRIPTION,
  FIELDS,
  HEALTH_ENTRY,
  KIND,
  TITLE,
  factsOf,
  kindMetadataShape,
  validateConfig,
  workmateConfigSchema,
} from './kind.ts'

describe('workmateConfigSchema', () => {
  it('parse({}) 不抛（Super-agent 的 resolve 会在坏配置上回落到 parse({})）', () => {
    expect(() => workmateConfigSchema.parse({})).not.toThrow()
  })

  it('默认值符合规格', () => {
    const parsed = workmateConfigSchema.parse({ taskFile: '/tmp/tasks.json' })
    expect(parsed.pollSeconds).toBe(5)
    expect(parsed.maxPerScan).toBe(5)
    expect(parsed.maxRowsPerTask).toBe(200)
    expect(parsed.interactive).toBe(false)
    expect(parsed.copyFiles).toEqual(['.env', '.env.local'])
    expect(parsed.openspecRoot).toBe('openspec')
    expect(parsed.repoRoot).toBeUndefined()
  })

  it('未知键被拒绝（strict），避免配置漂移被静默吞掉', () => {
    const parsed = workmateConfigSchema.safeParse({ taskFile: '/tmp/a.json', unknownKey: 1 })
    expect(parsed.success).toBe(false)
  })

  it('taskFile 允许空默认值（parse({}) 不能抛），由 validateConfig 判为不可用', () => {
    expect(workmateConfigSchema.parse({}).taskFile).toBe('')
    expect(validateConfig({}).ok).toBe(false)
  })

  it('越界的数值被拒绝', () => {
    expect(workmateConfigSchema.safeParse({ taskFile: '/a', pollSeconds: 0 }).success).toBe(false)
    expect(workmateConfigSchema.safeParse({ taskFile: '/a', maxPerScan: -1 }).success).toBe(false)
  })
})

describe('validateConfig', () => {
  it('接受绝对路径', () => {
    const result = validateConfig({ taskFile: '/Users/x/.dsh/workmate/tasks.json' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.interactive).toBe(false)
  })

  it('拒绝相对路径并给出原因', () => {
    const result = validateConfig({ taskFile: 'workmate/tasks.json' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/绝对路径/)
  })

  it('缺 taskFile 时返回不可用而不是抛错', () => {
    const result = validateConfig({})
    expect(result.ok).toBe(false)
  })

  it('null/undefined 也走 fail 分支', () => {
    expect(validateConfig(null).ok).toBe(false)
    expect(validateConfig(undefined).ok).toBe(false)
  })
})

describe('kind 元数据', () => {
  it('六个必填字段齐全', () => {
    expect(kindMetadataShape.kind).toBe('workmate')
    expect(kindMetadataShape.title.zh).not.toBe('')
    expect(kindMetadataShape.title.en).not.toBe('')
    expect(kindMetadataShape.description.zh).not.toBe('')
    expect(kindMetadataShape.fields.length).toBeGreaterThan(0)
    expect(kindMetadataShape.health).toEqual(['workmate'])
  })

  it('字段声明覆盖所有可配置项', () => {
    const keys = FIELDS.map((field) => field.key)
    for (const key of ['taskFile', 'interactive', 'pollSeconds', 'maxPerScan', 'maxRowsPerTask', 'repoRoot', 'openspecRoot']) {
      expect(keys).toContain(key)
    }
  })

  it('不声明任何"接受规则"或授权开关', () => {
    const keys = FIELDS.map((field) => field.key)
    expect(keys).not.toContain('acceptedRule')
    expect(keys).not.toContain('rules')
    expect(keys).not.toContain('allowed')
  })

  it('常量与规格一致', () => {
    expect(KIND).toBe('workmate')
    expect(HEALTH_ENTRY).toBe('workmate')
    expect(TITLE.en).toBe('WorkMate tasks')
    expect(DESCRIPTION.en.length).toBeGreaterThan(0)
  })
})

describe('factsOf', () => {
  it('给出可读事实', () => {
    const facts = factsOf({ taskFile: '/a/b.json', pending: 3, waitingOnDependency: 1, lastScanAt: '2026-11-02T00:00:00.000Z' })
    expect(facts['taskFile']).toBe('/a/b.json')
    expect(facts['lastScan']).toBe('2026-11-02T00:00:00.000Z')
    expect(JSON.stringify(facts['pending'])).toContain('3')
  })

  it('未扫描时给中文占位', () => {
    const facts = factsOf({ taskFile: '/a', pending: 0, waitingOnDependency: 0 })
    expect(JSON.stringify(facts['lastScan'])).toContain('尚未扫描')
  })
})
