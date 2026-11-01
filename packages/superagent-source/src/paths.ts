/**
 * 三份文件的位置约定（change `adopt-superagent-openspec-source`）。
 * `taskFile` 由安装方配置；另两份固定在同一目录，避免出现"面板写一个地方、
 * Source 读另一个地方"的静默错位。
 */
import { dirname, join } from 'node:path'

export interface TaskPaths {
  tasks: string
  inputs: string
  results: string
}

export function taskPaths(taskFile: string): TaskPaths {
  const dir = dirname(taskFile)
  return { tasks: taskFile, inputs: join(dir, 'inputs.jsonl'), results: join(dir, 'tasks.jsonl') }
}
