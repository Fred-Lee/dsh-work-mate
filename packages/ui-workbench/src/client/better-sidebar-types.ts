/**
 * Minimal ambient types for the dsh-better-sidebar client service face used by
 * this plugin. The real declarations ship inside the dsh-better-sidebar
 * package (lib/types/client/service.d.ts); the host supplies the service at
 * runtime — we only need the registerTab surface, typed locally so the client
 * half compiles without a workspace dependency on that package.
 */
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
  }
}
