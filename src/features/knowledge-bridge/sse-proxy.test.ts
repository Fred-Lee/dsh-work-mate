import { describe, expect, it } from 'vitest'
import { ensureSseProxy, probeSseProxy, resolveSseProxyScript } from './sse-proxy.ts'

/** Random-ish loopback port so parallel suites never collide on 8787. */
const port = 19_000 + (process.pid % 500)
const stopProxy = async (): Promise<void> => {
  const health = await probeSseProxy(port)
  if (health.running && health.pid !== undefined) {
    try {
      process.kill(health.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

describe('SSE normalize proxy lifecycle (manage-sse-proxy)', () => {
  it('does nothing while disabled', async () => {
    const status = await ensureSseProxy({ enabled: false, port, upstream: 'https://gw.example/ai/v1/chat/completions' })

    expect(status).toEqual({ status: 'disabled' })
    expect((await probeSseProxy(port, 300)).running).toBe(false)
  })

  it('refuses to start without an upstream and never spawns', async () => {
    const status = await ensureSseProxy({ enabled: true, port, upstream: '' })

    expect(status.status).toBe('failed')
    expect(status.note).toContain('gitnexusSseProxyUpstream')
    expect((await probeSseProxy(port, 300)).running).toBe(false)
  })

  it('starts the proxy on demand, then reuses the same instance', async () => {
    try {
      const started = await ensureSseProxy({
        enabled: true,
        port,
        upstream: 'https://gw.example/ai/v1/chat/completions',
      })

      expect(started.status).toBe('started')
      const health = await probeSseProxy(port)
      expect(health.running).toBe(true)
      expect(health.upstream).toBe('https://gw.example/ai/v1/chat/completions')

      const reused = await ensureSseProxy({
        enabled: true,
        port,
        upstream: 'https://gw.example/ai/v1/chat/completions',
      })
      expect(reused.status).toBe('reused')
      // Same process: reuse must not spawn a second listener (EADDRINUSE would be silent).
      expect((await probeSseProxy(port)).pid).toBe(health.pid)
    } finally {
      await stopProxy()
    }
  }, 20_000)

  it('refuses to reuse a proxy that forwards elsewhere', async () => {
    try {
      await ensureSseProxy({ enabled: true, port, upstream: 'https://gw.example/ai/v1/chat/completions' })

      const mismatched = await ensureSseProxy({
        enabled: true,
        port,
        upstream: 'https://other.example/ai/v1/chat/completions',
      })

      expect(mismatched.status).toBe('failed')
      expect(mismatched.note).toContain('不一致')
      expect(mismatched.upstream).toBe('https://gw.example/ai/v1/chat/completions')
    } finally {
      await stopProxy()
    }
  }, 20_000)

  it('resolves the shipped script path', () => {
    expect(resolveSseProxyScript()).toMatch(/scripts\/gitnexus-sse-proxy\.mjs$/)
  })
})
