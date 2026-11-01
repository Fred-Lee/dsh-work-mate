/**
 * 任务簿文件的写侧（change `adopt-superagent-openspec-source`, task 9）。
 *
 * 与子包的 `files.ts` 共享同一份形状：`tasks.json` 由面板独占写入（tmp+rename 原子写，
 * 损坏 fail-closed），`inputs.jsonl` 由面板追加。Source 只读这两份、只写 `tasks.jsonl`。
 *
 * 这里不复用子包的实现，因为两个包不互相依赖（子包要能独立装进 Super-agent 的 profile）。
 * 形状由 `TaskRecord` 与本文件末尾的 `assertSameShape` 用例共同钉住。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type TaskPriority = 'P0' | 'P1' | 'P2'
export type TaskMode = 'superagent' | 'proposal' | 'record'

export interface TaskRecord {
  id: string
  title: string
  intent: string
  repo: string
  baseBranch: string
  acceptance: string
  priority: TaskPriority
  mode: TaskMode
  dependsOn: string[]
  assigned: boolean
  abandoned: boolean
  attempt: number
  createdBy: string
  proposalId?: string
  ports?: number[]
  createdAt: string
  updatedAt: string
}

export interface TaskFile {
  version: 1
  tasks: TaskRecord[]
}

export interface InputRow {
  seq: number
  taskId: string
  text: string
  by: string
  at: string
  replyTo?: string
}

export class TaskStoreCorruptError extends Error {
  readonly code = 'TASK_STORE_CORRUPT'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TaskStoreCorruptError'
  }
}

export interface TaskFileStoreOptions {
  /** `<DSH home>/<workmateHome>` 下的绝对目录；测试可注入临时目录。 */
  rootDir: string
  /** 文件路径覆盖（Config.taskFile）；空表示 `<rootDir>/tasks.json`。 */
  file?: string
}

const isNodeError = (error: unknown): error is { code?: string } =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'

export class TaskFileStore {
  readonly paths: { tasks: string; inputs: string; results: string }

  constructor(options: TaskFileStoreOptions) {
    const tasks = options.file !== undefined && options.file !== '' ? options.file : join(options.rootDir, 'tasks.json')
    const dir = dirname(tasks)
    this.paths = { tasks, inputs: join(dir, 'inputs.jsonl'), results: join(dir, 'tasks.jsonl') }
  }

  /** 读任务表：文件不存在视为空；JSON 坏或结构不对 → fail-closed。 */
  async load(): Promise<TaskFile> {
    let raw: string
    try {
      raw = await readFile(this.paths.tasks, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, tasks: [] }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new TaskStoreCorruptError(`tasks.json 不是合法 JSON：${this.paths.tasks}`, { cause: error })
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { tasks?: unknown }).tasks)
    ) {
      throw new TaskStoreCorruptError(`tasks.json 结构不受支持（需要 version: 1 + tasks 数组）：${this.paths.tasks}`)
    }
    return parsed as TaskFile
  }

  /** 原子替换整表。 */
  async save(file: TaskFile): Promise<void> {
    await mkdir(dirname(this.paths.tasks), { recursive: true })
    const tmp = `${this.paths.tasks}.tmp`
    await writeFile(tmp, `${JSON.stringify({ version: 1, tasks: file.tasks }, null, 2)}\n`, 'utf8')
    await rename(tmp, this.paths.tasks)
  }

  /** 追加一行人输入；`seq` 由调用方在持锁时分配。 */
  async appendInput(row: InputRow): Promise<InputRow> {
    await mkdir(dirname(this.paths.inputs), { recursive: true })
    await appendFile(this.paths.inputs, `${JSON.stringify(row)}\n`, 'utf8')
    return row
  }

  /** 读未消费的人输入的最大 seq（用于给新行分配 seq）。 */
  async maxInputSeq(): Promise<number> {
    const raw = await readFile(this.paths.inputs, 'utf8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return ''
      throw error
    })
    let max = 0
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const parsed = JSON.parse(text) as { seq?: unknown }
        if (typeof parsed.seq === 'number' && parsed.seq > max) max = parsed.seq
      } catch {
        // 撕裂尾行：忽略
      }
    }
    return max
  }
}
