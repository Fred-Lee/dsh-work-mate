// Library entry: exposes the workbench React view (4 panels) for the DSH client
// slot/shell and for any standalone host. The DSH client inject path is in
// src/client/index.ts; this is the pure component + state layer.
export { App as WorkbenchView } from './App'
export type { PanelKind } from './App'
