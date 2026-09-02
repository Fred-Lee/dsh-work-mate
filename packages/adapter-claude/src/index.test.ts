import { describe, expect, it } from 'vitest'
import { spawnAgent } from './index.ts'

const req = (over: Partial<Parameters<typeof spawnAgent>[2]> = {}) => ({
  prompt: 'test prompt',
  worktreePath: process.cwd(),
  timeoutSec: 10,
  signal: new AbortController().signal,
  onOutput: () => undefined,
  ...over,
})

describe('adapter-claude buildArgs', () => {
  it('substitutes {prompt} and falls back to print-mode defaults', async () => {
    const { buildArgs } = await import('./index.ts')
    expect(buildArgs(undefined, 'hello world')).toEqual(['-p', 'hello world', '--output-format', 'text'])
    expect(buildArgs(['--cd', '{prompt}'], 'a b')).toEqual(['--cd', 'a b'])
  })
})

describe('spawnAgent', () => {
  it('captures exit code 0 and streams output', async () => {
    const chunks: string[] = []
    const result = await spawnAgent(
      'node',
      ['-e', 'process.stdout.write("streamed-ok")'],
      req({ onOutput: (c) => chunks.push(c) }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(chunks.join('')).toBe('streamed-ok')
  })

  it('captures non-zero exit codes and stderr', async () => {
    const result = await spawnAgent('node', ['-e', 'process.stderr.write("boom"); process.exit(2)'], req())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('boom')
  })

  it('enforces the timeout and reports timedOut', async () => {
    const result = await spawnAgent('node', ['-e', 'setTimeout(() => {}, 30000)'], req({ timeoutSec: 1 }))
    expect(result.timedOut).toBe(true)
  }, 15_000)

  it('resolves on abort', async () => {
    const controller = new AbortController()
    const pending = spawnAgent('node', ['-e', 'setTimeout(() => {}, 30000)'], req({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.exitCode).not.toBe(0)
  }, 15_000)

  it('handles missing binaries gracefully', async () => {
    const result = await spawnAgent('definitely-not-a-real-binary-xyz', ['--version'], req())
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
