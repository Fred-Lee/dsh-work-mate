/**
 * @helmsman/adapter-claude — runs Anthropic's Claude Code CLI
 * (`claude -p <prompt> --output-format text`) inside an isolated worktree.
 *
 * Non-interactive by design: print mode, no shell, argv arrays only.
 * The orchestrator owns failure classification (rate-limit / auth / timeout)
 * from the raw stderr this adapter reports.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

export const name = '@helmsman/adapter-claude'
export const inject = ['helmsman.orchestrator'] as const

export interface Config {
  /** Binary to invoke. @default 'claude' */
  command?: string
  /** Argv template; `{prompt}` is replaced by the task prompt. */
  args?: string[]
  /** Extra env vars passed to the child process. */
  env?: Record<string, string>
}

interface OrchestratorLike {
  registerAdapter(adapter: {
    name: string
    checkInstalled(): Promise<{ installed: boolean; version?: string }>
    execute(req: AdapterRequest): Promise<AdapterResult>
  }): void
}

export interface AdapterRequest {
  prompt: string
  worktreePath: string
  timeoutSec: number
  signal: AbortSignal
  onOutput: (chunk: string) => void
}

export interface AdapterResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const DEFAULT_ARGS: string[] = ['-p', '{prompt}', '--output-format', 'text']

export function buildArgs(template: string[] | undefined, prompt: string): string[] {
  return (template ?? DEFAULT_ARGS).map((a) => a.replace('{prompt}', prompt))
}

export function makeAdapter(config: Config = {}) {
  const command = config.command ?? 'claude'
  const argsTemplate = config.args && config.args.length > 0 ? config.args : undefined

  return {
    name: 'claude',
    async checkInstalled() {
      const which = await new Promise<number>((resolve) => {
        execFile('which', [command], (error) => resolve(error ? 1 : 0))
      })
      if (which !== 0) return { installed: false }
      const version = await new Promise<string>((resolve) => {
        execFile(command, ['--version'], { timeout: 10_000 }, (error, out) => resolve(error ? '' : String(out).trim().split('\n')[0] ?? ''))
      })
      return { installed: true, ...(version ? { version } : {}) }
    },

    async execute(req: AdapterRequest): Promise<AdapterResult> {
      const args = buildArgs(argsTemplate, req.prompt)
      return await spawnAgent(command, args, req, config.env)
    },
  }
}

/** Shared spawn loop: streams output, honors timeout and abort, kills the tree. */
export function spawnAgent(command: string, args: string[], req: AdapterRequest, env?: Record<string, string>): Promise<AdapterResult> {
  return new Promise((resolve) => {
    let timedOut = false
    let settled = false
    let stdout = ''
    let stderr = ''

    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: req.worktreePath,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, req.timeoutSec * 1000)

    const onAbort = (): void => killTree(child)
    req.signal.addEventListener('abort', onAbort, { once: true })

    const forward = (buf: Buffer, sink: (c: string) => void, into: string): string => {
      const text = buf.toString('utf8')
      sink(text)
      return into + text
    }
    child.stdout?.on('data', (buf: Buffer) => {
      stdout = forward(buf, req.onOutput, stdout)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = forward(buf, req.onOutput, stderr)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.signal.removeEventListener('abort', onAbort)
      resolve({ exitCode: 1, stdout, stderr: stderr || String(err.message), timedOut })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.signal.removeEventListener('abort', onAbort)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 5_000).unref()
  } catch {
    // already dead
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const orchestrator = ctx.get('helmsman.orchestrator') as OrchestratorLike | undefined
  if (!orchestrator) {
    console.error(`[helmsman/adapter-claude] helmsman.orchestrator not available; adapter not registered`)
    return
  }
  orchestrator.registerAdapter(makeAdapter(config))
  console.log(`[helmsman/adapter-claude] adapter "claude" registered (command: ${config.command ?? 'claude'})`)
}
