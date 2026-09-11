// Library entry: exposes the board React view as an importable component so a
// host client bundle (workbench panel / DSH shell drawer) can render the SAME
// source the standalone page uses (task 1.3). The IIFE shell (main.tsx) mounts
// <App/> separately.
export { App, BoardView, CreateItemForm, readUrlState, buildSearch } from './App'
export { RunPanel, describeEvent, useRunTimeline, statusLabel } from './RunPanel'
export { api, apiBase, runStreamUrl, subscribeRunStream, STAGES, STAGE_LABELS, ASSOCIATION_LABELS } from './api'
export { injectBoardStyles } from './inject-styles'
export type {
  BoardCardPayload,
  CardRunPayload,
  ConfigPayload,
  GateGap,
  ItemDetailPayload,
  RunsPayload,
  Stage,
  WipPayload,
} from './api'
