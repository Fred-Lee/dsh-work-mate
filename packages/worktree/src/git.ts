/**
 * Git invocation helpers — execFile with argv arrays only (never a shell), so
 * paths and prompts can never inject shell metacharacters.
 */
import { execFile } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  maxBuffer?: number
  env?: Record<string, string>
}

export type CommandRunner = (bin: string, args: string[], options?: RunOptions) => Promise<RunResult>

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * Runs a binary and always resolves with { code, stdout, stderr }.
 * No shell is involved anywhere; every argument is passed verbatim to execv.
 */
export const runCommand: CommandRunner = (bin, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      },
      (error, out, err) => {
        if (!error) {
          resolve({ code: 0, stdout: String(out ?? ''), stderr: String(err ?? '') })
          return
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: String(out ?? ''),
          stderr: String(err ?? '') || String(error.message ?? ''),
        })
      },
    )
  })

export function createGitRunner(run: CommandRunner = runCommand): CommandRunner {
  return (bin, args, options) => run(bin, args, options)
}

/** Throws a descriptive Error when the command failed. */
export async function expectOk(result: Promise<RunResult>, what: string): Promise<RunResult> {
  const r = await result
  if (r.code !== 0) {
    throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || 'no output'}`)
  }
  return r
}
