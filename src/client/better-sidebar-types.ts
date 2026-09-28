/// <reference types="react" />
/** Ambient declarations for services provided by the DSH client shell. */
import type { ReactNode } from 'react'

export interface TabComponentProps {
  ctx: unknown
  store: unknown
  scope: { sessionId?: string }
  tab: { id: string; type: string; title?: string; path?: string }
  visible: boolean
}

export interface TabDescriptor {
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number
  hidden?: boolean
  single?: boolean
  component: (props: TabComponentProps) => ReactNode
}

export interface BetterSidebarFace {
  registerTab(descriptor: TabDescriptor): () => void
  getTabs(): readonly TabDescriptor[]
  getTab(id: string): TabDescriptor | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebar: BetterSidebarFace
    /**
     * Local faces of cordis' fiber methods. The real declarations live in
     * `@deepseek-ai/cordis/lib/types/{fiber,registry}` via relative module
     * augmentation, which a client tsconfig does not pull into the program
     * (same workaround as the Helmsman ui-workbench slot-types).
     */
    effect(fn: () => () => void): void
    inject(deps: readonly string[], callback: (scope: Context) => void): unknown
  }
}
