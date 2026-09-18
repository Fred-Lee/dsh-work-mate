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
    options: {
      name: string
      id?: string
      label?: string
      /** List ordering (ascending). */
      order?: number
      priority?: number
      /**
       * Business-face factory. For a `session`-scoped slot the framework calls
       * it with the resolved `sessionId`; the returned members are merged into
       * the component's props (callbacks and plain data pass through as-is).
       */
      inject?: (...args: never[]) => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

/**
 * The injected business face of the 「保存为任务」 chat-message action
 * (`conversation.chat.assistant-actions`, list / session).
 *
 * `sessionId` is definite: the slot is session-scoped, so it only renders under
 * a resolved session — there is no undefined branch to handle here.
 */
export interface AssistantActionInjected {
  sessionId: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotRegistryFace
    /** Client-side effect scope (disposer registration); provided by the client runtime. */
    effect(fn: () => () => void): void
    /**
     * Local face of cordis' `ctx.inject(deps, callback)` scope helper — "start
     * this callback once these services are available, unload it when they
     * go". Mirrored here for the same reason as `effect`: the real declaration
     * lives in `@deepseek-ai/cordis/lib/types/registry`, which this package's
     * client tsconfig does not pull into the program.
     *
     * It is the documented way to depend on a service OPTIONALLY: putting the
     * name in the module-level `inject` array instead would park the whole
     * client half in PENDING whenever that service is absent.
     */
    inject(deps: readonly string[], callback: (scope: Context) => void): unknown
  }
}

// Reference the imported type so the file contributes the augmentation.
export type RegisteredContext = ClientContext & { slots: SlotRegistryFace }
