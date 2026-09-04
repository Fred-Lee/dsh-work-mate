// Library entry: exposes the diff React view as an importable component for
// the Helmsman workbench panel (Phase 4), reusing the exact App source.
// The IIFE shell (main.tsx) mounts the same <App/> separately.
export { App as DiffView } from './App'
export { api, parseHunks, AGENT_LABELS } from './api'
export type { DiffLine, DiffTaskPayload, FileDiff } from './api'
