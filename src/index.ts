/**
 * workmate4dsh — DSH plugin entry (milestone M1: skeleton & profile assembly).
 *
 * Change-proposal-centric bundle: proposal management (M1/M2), knowledge
 * bridging via GitNexus MCP + WeKnora HTTP (M3), archive orchestration over
 * swarm + OpenSpec + GitNexus re-index (M4).
 *
 * M1 is a self-sufficient pure-service plugin: `inject` stays empty because a
 * declared-but-absent service would hold the fiber in PENDING forever
 * (Helmsman contract note). Tool registration introduces `tools` at M2 —
 * lazily probed first, only then declared.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config } from './config.ts'
import { ProposalStore } from './features/proposal/store.ts'
import { ProposalServiceImpl, type ProposalService } from './features/proposal/service.ts'

export const name = 'workmate'
export const inject = [] as const

export type { Config, ResolvedConfig } from './config.ts'
export { CONFIG_DEFAULTS, resolveConfig } from './config.ts'
export type { Proposal, ProposalStoreOptions } from './features/proposal/store.ts'
export { ProposalStore, resolveDshHome, StoreCorruptError } from './features/proposal/store.ts'
export type { ProposalService, UpsertProposalInput } from './features/proposal/service.ts'
export { ProposalServiceImpl } from './features/proposal/service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'workmate.proposal': ProposalService
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const store = new ProposalStore({ subdir: resolved.workmateHome })
  const service = new ProposalServiceImpl(store)

  // Eager best-effort read: a corrupt proposals.json must surface at boot,
  // but it must not take the whole profile down (board warmUp lesson).
  void service
    .list()
    .then(
      () => console.log(`[workmate] service ready (root: ${store.rootDir})`),
      (error: unknown) =>
        console.error(
          `[workmate] proposals store unreadable: ${error instanceof Error ? error.message : String(error)}`,
        ),
    )

  ctx.provide('workmate.proposal', service)
}
