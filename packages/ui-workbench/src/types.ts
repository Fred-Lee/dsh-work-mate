/** @helmsman/ui-workbench shared types. */

export type PresetName = 'research' | 'prd' | 'decompose' | 'require-analyze'

/** A generation/submission record surfaced to the UI for polling. */
export interface GenerateRecord {
  taskId: string
  preset: PresetName
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt?: number
  error?: string
  /** Draft id produced on completion (markdown/JSON under ~/.helmsman/workbench). */
  draftId?: string
  result?: Record<string, unknown>
}
