/**
 * Minimal ambient augmentation for the DSH client slot surface used by this
 * client half. The real types live in the DeepSeek Harness repo
 * (`@deepseek-ai/dsh-client-ui-renderer/client` provides the `slots` service,
 * `@deepseek-ai/dsh-client-ui-layout/client` declares the `shell.overlay`
 * slot). The host supplies them at runtime; this local face lets the client
 * entry typecheck in this workspace without a workspace dep on those packages.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

export interface SlotRegistryFace {
  inject(
    key: string,
    effect: () => (() => void) | Generator<() => void, void, void>,
  ): () => void
  register(
    options: { name: string; id?: string; label?: string; priority?: number },
    component: unknown,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotRegistryFace
  }
}

// Reference the imported type so the file contributes the augmentation.
export type RegisteredContext = ClientContext & { slots: SlotRegistryFace }
