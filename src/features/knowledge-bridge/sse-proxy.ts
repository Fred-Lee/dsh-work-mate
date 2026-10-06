/**
 * SSE normalize proxy lifecycle (change `manage-sse-proxy`).
 *
 * Some self-hosted OpenAI-compatible gateways stream `data:{…}` without the space
 * after the colon, while GitNexus's SSE parser requires `data: ` — so every chunk is
 * skipped and the CLI fails with "LLM returned empty streaming response".
 * `scripts/gitnexus-sse-proxy.mjs` rewrites that prefix in flight.
 *
 * This module gives the proxy a lifecycle instead of leaving a stray process behind:
 * probe `/healthz`, reuse a matching instance, start one only when needed, and refuse
 * to reuse a proxy that forwards somewhere else.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SseProxyOptions {
  enabled: boolean
  port: number
  /** Real gateway chat-completions URL the proxy forwards to. */
  upstream: string
  scriptPath?: string
  /** How long to wait for a freshly started proxy to answer /healthz. */
  readyTimeoutMs?: number
}

export interface SseProxyStatus {
  status: 'disabled' | 'reused' | 'started' | 'failed'
  port?: number
  upstream?: string
  note?: string
}

/**
 * `<package root>/scripts/gitnexus-sse-proxy.mjs`, resolved from either layout:
 * bundled `dist/index.js` (one level up) or the TypeScript sources under vitest
 * (`src/features/knowledge-bridge/…`, three levels up).
 */
export function resolveSseProxyScript(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'scripts', 'gitnexus-sse-proxy.mjs'),
    join(here, '..', '..', '..', 'scripts', 'gitnexus-sse-proxy.mjs'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] as string
}

interface HealthBody {
  service?: string
  pid?: number
  upstream?: string
}

/** Loopback health probe; anything unreachable/foreign counts as "not running". */
export async function probeSseProxy(
  port: number,
  timeoutMs = 800,
): Promise<{ running: boolean; upstream?: string; pid?: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })
    if (!response.ok) return { running: false }
    const body = (await response.json()) as HealthBody
    if (body.service !== 'workmate-gitnexus-sse-proxy') return { running: false }
    return {
      running: true,
      ...(body.upstream !== undefined ? { upstream: body.upstream } : {}),
      ...(body.pid !== undefined ? { pid: body.pid } : {}),
    }
  } catch {
    return { running: false }
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/**
 * Guarantee the proxy is available when enabled. Reuse beats restart: an instance
 * already forwarding to the configured upstream is left untouched.
 */
export async function ensureSseProxy(options: SseProxyOptions): Promise<SseProxyStatus> {
  if (!options.enabled) return { status: 'disabled' }
  if (options.upstream === '') {
    return { status: 'failed', note: 'gitnexusSseProxyUpstream 未配置（需要真实的 …/chat/completions 地址）' }
  }

  const existing = await probeSseProxy(options.port)
  if (existing.running) {
    if (existing.upstream !== undefined && existing.upstream !== options.upstream) {
      return {
        status: 'failed',
        port: options.port,
        upstream: existing.upstream,
        note: `端口 ${options.port} 上的代理转发到 ${existing.upstream}，与配置的 ${options.upstream} 不一致——请改端口或停掉它`,
      }
    }
    return { status: 'reused', port: options.port, upstream: options.upstream }
  }

  const script = options.scriptPath ?? resolveSseProxyScript()
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(options.port), UPSTREAM: options.upstream },
    })
    child.unref()
  } catch (error) {
    return {
      status: 'failed',
      port: options.port,
      note: `代理启动失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const deadline = Date.now() + (options.readyTimeoutMs ?? 4_000)
  while (Date.now() < deadline) {
    await sleep(150)
    const health = await probeSseProxy(options.port, 500)
    if (health.running) return { status: 'started', port: options.port, upstream: options.upstream }
  }
  return { status: 'failed', port: options.port, note: `代理启动后 ${script} 未在超时内响应 /healthz` }
}
