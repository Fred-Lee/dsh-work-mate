// Library entry: exposes the dashboard React view as an importable component
// for the Helmsman workbench panel (Phase 4), reusing the exact App source.
// The IIFE shell (main.tsx) mounts the same <App/> separately.
export { App as DashboardView } from './App'
export { api, AGENTS, AGENT_LABELS, USAGE_QUOTA } from './api'
export type { AgentRunPayload, AgentRunState, StatePayload, TaskPayload, TopologyPayload, ImportPreviewPayload } from './api'
