/**
 * Ambient types for the DSH client slot faces WorkMate attaches to. Local
 * minimal faces (Helmsman convention): the real declarations ship with the
 * host's `@deepseek-ai/dsh-client-ui-*` packages, which we deliberately do
 * not depend on.
 */

/** Slot key of the assistant-message action row (session-scoped). */
export const ASSISTANT_ACTIONS = 'conversation.chat.assistant-actions'
/** Slot key of the input-box tool area, right of the attach button. */
export const INPUT_LEFT = 'conversation.input.left'

/** The framework injects the resolved session into session-scoped slots. */
export interface AssistantActionInjected {
  sessionId: string
}

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
      order?: number
      priority?: number
      inject?: (...args: never[]) => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotRegistryFace
    /** Local faces of cordis fiber methods: the real declarations live in
     * cordis' relative augmentation, which a client tsconfig does not pull in. */
    effect(fn: () => () => void): void
    inject(deps: readonly string[], callback: (scope: Context) => void): unknown
  }
}
