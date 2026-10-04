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
/**
 * Keyed central-panel slot ("Central panel selected by sidebar entry id"); the
 * reserved key `conversation` hosts the chat, every other key is ours.
 */
export const MAIN_PANEL = 'main'
/**
 * Left-rail icon list ("Each list id addresses the matching main panel"): the id
 * we register here is what selects our `main` key.
 */
export const SIDEBAR_PANELLIST = 'sidebar.panellist'
/** Panel id shared by the two registrations above. */
export const WORKMATE_PANEL_ID = 'workmate'

/** Icon share the sidebar hands a panel-row glyph. */
export interface PanelIconProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is selected in the main column. */
  active: boolean
}

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
      /** Keyed slots (`main`) address their cell by `key` instead of `id`. */
      key?: string
      /** Host face: a thunk is re-read on every projection (locale follows). */
      label?: string | (() => string)
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
