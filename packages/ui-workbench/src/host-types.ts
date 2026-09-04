/** @helmsman/ui-workbench host-side types (mirrors client). */

export interface GenerateRecord {
  taskId: string
  preset: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt?: number
  error?: string
  draftId?: string
  result?: Record<string, unknown>
}
