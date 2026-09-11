/**
 * @helmsman/artifacts — DSH plugin entry.
 *
 * Pure-Service cordis plugin (design.md D1) owning Helmsman's content-addressed
 * artifact registry under `~/.helmsman/artifacts` (HELMSMAN_HOME-aware).
 * Exposes `helmsman.artifacts` via `ctx.provide`:
 *   register({ type, fileName, bytes, meta }) → { id, duplicate }
 *   resolve(id) → { meta, bytes } | null
 *   list() → ArtifactMeta[]
 *
 * No `webServer`, no tools, no runtime deps. Hosts (ui-dashboard /
 * ui-workbench) `ctx.get('helmsman.artifacts')` lazily and degrade gracefully
 * when this plugin is absent, so `inject` stays empty.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ArtifactStore,
  HelmsmanArtifactError,
  MAX_ARTIFACT_BYTES,
  type ArtifactErrorCode,
  type ArtifactMeta,
  type RegisterInput,
  type RegisterResult,
  type ResolveResult,
} from './store.ts'
export {
  ArtifactStore,
  HelmsmanArtifactError,
  MAX_ARTIFACT_BYTES,
  type ArtifactErrorCode,
  type ArtifactMeta,
  type RegisterInput,
  type RegisterResult,
  type ResolveResult,
} from './store.ts'
export {
  DEFAULT_ARTIFACT_MIME,
  contentDispositionHeader,
  downloadHeaders,
  mimeForFileName,
  type DownloadHeaders,
} from './download-headers.ts'

export const name = '@helmsman/artifacts'
export const inject = [] as const

export interface Config {
  /** Registry root. @default $HELMSMAN_HOME/artifacts, else ~/.helmsman/artifacts */
  rootDir?: string
}

export interface ArtifactService {
  /** Content-addressed store of bytes; duplicate registrations dedupe. */
  register(input: RegisterInput): Promise<RegisterResult>
  /** Returns registered delivery metadata + bytes, or null for unknown id. */
  resolve(id: string): Promise<ResolveResult | null>
  /** Lists stored artifacts (metadata only), oldest registration first. */
  list(): Promise<ArtifactMeta[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.artifacts': ArtifactService
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new ArtifactStore({ rootDir: config.rootDir })

  const service: ArtifactService = {
    register: (input) => store.register(input),
    resolve: (id) => store.resolve(id),
    list: () => store.list(),
  }

  ctx.provide('helmsman.artifacts', service)
  console.log(`[helmsman/artifacts] service ready (root: ${store.rootDir})`)
}
