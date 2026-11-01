/**
 * 任务服务（change `adopt-superagent-openspec-source`, task 9）。
 *
 * 面板只能做三件事：写意图、写人的回答、代理执行器的 retry/stop。
 * 它**不**投递 Trigger、不写 Ticket、不猜阶段——投递由 Super-agent 里的 Source 完成。
 */
import { join } from 'node:path'
import type { EventLog } from '../proposal/events.ts'
import type { TaskFileStore, TaskRecord } from './files.ts'
import { projectTask, type PanelLane, type PanelSubstate, type Projection, type TicketView } from '../superagent/project.ts'
import type { SuperagentClient } from '../superagent/client.ts'
import type { PortAllocator } from '../worktree/port-allocator.ts'
import { planTaskPorts } from './plan.ts'

export interface TaskServiceDeps {
  store: TaskFileStore
  superagent: SuperagentClient
  events?: EventLog
  /** 该执行器接管的仓库名；与 task.repo 不一致时不可指派。 */
  executorRepo?: string
  /** 默认操作者。 */
  operator?: string
  /** 端口分配器；给了就在建实现待办时分配任务级端口段。 */
  ports?: PortAllocator
  now?: () => Date
}

export interface CreateTaskInput {
  intent: string
  repo: string
  baseBranch?: string
  acceptance?: string
  priority?: 'P0' | 'P1' | 'P2'
  mode?: 'superagent' | 'proposal' | 'record'
  proposalId?: string
  dependsOn?: string[]
  title?: string
}

export interface TaskCard extends Projection {
  task: TaskRecord
  ticket?: TicketView
  /** 该仓库是否被当前执行器接管。 */
  connectable: boolean
}

export interface TaskBoard {
  cards: TaskCard[]
  lanes: Record<PanelLane, TaskCard[]>
  health: { online: boolean; endpoint: string; reason?: string; paused?: boolean }
  /** 需要人的数量（侧栏徽标用）。 */
  attention: number
  /** 读不到资产/连接的原因汇总。 */
  notes: string[]
}

const idOf = (now: Date, index: number): string => `task-${now.getTime().toString(36)}-${index}`

export class TaskServiceImpl {
  private readonly now: () => Date

  constructor(private readonly deps: TaskServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** 列出全部键名，供测试与面板使用。 */
  async list(): Promise<TaskRecord[]> {
    return (await this.deps.store.load()).tasks
  }

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const intent = input.intent.trim()
    if (intent === '') throw new Error('目标不能为空')
    const now = this.now()
    const file = await this.deps.store.load()
    const id = idOf(now, file.tasks.length + 1)
    const task: TaskRecord = {
      id,
      title: (input.title ?? intent.split('\n')[0] ?? intent).slice(0, 200),
      intent,
      repo: input.repo.trim(),
      baseBranch: (input.baseBranch ?? 'main').trim() || 'main',
      acceptance: (input.acceptance ?? '').trim(),
      priority: input.priority ?? 'P2',
      mode: input.mode ?? 'record',
      dependsOn: input.dependsOn ?? [],
      assigned: (input.mode ?? 'record') === 'superagent',
      abandoned: false,
      attempt: (input.mode ?? 'record') === 'superagent' ? 1 : 0,
      createdBy: this.deps.operator ?? 'workmate:panel',
      ...(input.proposalId !== undefined && input.proposalId.trim() !== '' ? { proposalId: input.proposalId.trim() } : {}),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    file.tasks.push(task)
    await this.deps.store.save(file)
    await this.event(task, 'task-create', `mode=${task.mode}`)
    return task
  }

  /** 指派 / 重试：置 assigned 并递增 attempt；不改 Ticket。 */
  async assign(taskId: string, options: { retry?: boolean } = {}): Promise<TaskRecord> {
    const file = await this.deps.store.load()
    const task = this.require(file.tasks, taskId)
    this.assertConnectable(task)
    task.assigned = true
    task.abandoned = false
    task.attempt = Math.max(1, task.attempt + (options.retry === true ? 1 : task.attempt === 0 ? 1 : 1))
    task.updatedAt = this.now().toISOString()
    await this.deps.store.save(file)
    await this.event(task, options.retry === true ? 'task-retry' : 'task-assign', `attempt=${task.attempt}`)
    return task
  }

  /** 停止：既在本地标记放弃（Source 不再投递），也代理执行器的 stop。 */
  async stop(taskId: string): Promise<{ task: TaskRecord; stopped?: string }> {
    const file = await this.deps.store.load()
    const task = this.require(file.tasks, taskId)
    task.abandoned = true
    task.assigned = false
    task.updatedAt = this.now().toISOString()
    await this.deps.store.save(file)
    await this.event(task, 'task-stop', '')
    const tickets = await this.deps.superagent.tickets()
    const ticket = tickets.tickets.find((entry) => entry.title === task.title && entry.ended === undefined)
    if (ticket === undefined) return { task }
    const result = await this.deps.superagent.action(ticket.id, 'stop')
    return { task, ...(result.ok ? { stopped: ticket.id } : { stopped: undefined }) }
  }

  /** 重新打开：清 abandoned，不递增 attempt（下一个扫描周期重投同一 attempt）。 */
  async reopen(taskId: string): Promise<TaskRecord> {
    const file = await this.deps.store.load()
    const task = this.require(file.tasks, taskId)
    task.abandoned = false
    task.assigned = true
    task.updatedAt = this.now().toISOString()
    await this.deps.store.save(file)
    await this.event(task, 'task-reopen', `attempt=${task.attempt}`)
    return task
  }

  /** 回答：只追加到 inputs.jsonl，不重走 Eval。 */
  async reply(taskId: string, text: string, options: { by?: string; replyTo?: string } = {}): Promise<{ seq: number }> {
    const value = text.trim()
    if (value === '') throw new Error('回答不能为空')
    const file = await this.deps.store.load()
    const task = this.require(file.tasks, taskId)
    const seq = (await this.deps.store.maxInputSeq()) + 1
    await this.deps.store.appendInput({
      seq,
      taskId: task.id,
      text: value,
      by: options.by ?? this.deps.operator ?? 'workmate:panel',
      at: this.now().toISOString(),
      ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
    })
    await this.event(task, 'task-reply', `seq=${seq}`)
    return { seq }
  }

  /**
   * G2 交接：为一个提案的每个 target 建一条实现待办（幂等）。
   *
   * 同一提案 + 同一项目已存在未放弃的待办时不重复创建；这样 G2 重复确认、
   * 或提案回退再前进，都不会在任务表里堆出一串重复项。
   */
  async ensureImplementationTasks(input: {
    proposalId: string
    title: string
    targets: ReadonlyArray<{ project: string; baseBranch: string }>
    acceptance?: string
  }): Promise<{ created: TaskRecord[]; existing: TaskRecord[] }> {
    const file = await this.deps.store.load()
    const created: TaskRecord[] = []
    const existing: TaskRecord[] = []
    for (const target of input.targets) {
      const found = file.tasks.find(
        (task) => task.proposalId === input.proposalId && task.repo === target.project && !task.abandoned,
      )
      if (found !== undefined) {
        existing.push(found)
        continue
      }
      const now = this.now()
      const id = idOf(now, file.tasks.length + created.length + 1)
      const task: TaskRecord = {
        id,
        title: `${input.title}（${target.project}）`.slice(0, 200),
        intent: `实现提案 ${input.title} 的 ${target.project} 部分（OpenSpec: ${input.proposalId}）`,
        repo: target.project,
        baseBranch: target.baseBranch,
        acceptance: input.acceptance ?? '',
        priority: 'P1',
        mode: 'superagent',
        dependsOn: [],
        assigned: true,
        abandoned: false,
        attempt: 1,
        createdBy: this.deps.operator ?? 'workmate:panel',
        proposalId: input.proposalId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }
      if (this.deps.ports !== undefined) {
        const ports = await planTaskPorts(this.deps.ports, {
          proposalId: input.proposalId,
          project: target.project,
          taskId: id,
        })
        task.ports = ports
      }
      file.tasks.push(task)
      created.push(task)
    }
    if (created.length > 0) await this.deps.store.save(file)
    return { created, existing }
  }

  /** 面板视图：任务表 + Ticket 投影 + 连接状态。 */
  async board(): Promise<TaskBoard> {
    const notes: string[] = []
    const health = await this.deps.superagent.health()
    if (!health.online) notes.push(`执行器离线：${health.reason ?? '未知原因'}`)
    const tickets = health.online ? await this.deps.superagent.tickets() : { online: false, tickets: [], reason: health.reason }
    if (health.online && tickets.online === false) notes.push(`读取 Ticket 失败：${tickets.reason ?? '未知原因'}`)

    const file = await this.deps.store.load()
    const byTitle = new Map(tickets.tickets.map((ticket) => [ticket.title, ticket]))
    const cards: TaskCard[] = file.tasks.map((task) => {
      const ticket = byTitle.get(task.title)
      const submitted = task.attempt > 0 && task.assigned
      const projection = projectTask({
        task,
        ...(ticket !== undefined ? { ticket } : {}),
        submitted,
        ...(tickets.online === false && submitted ? { failure: tickets.reason ?? '执行器离线' } : {}),
      })
      return {
        ...projection,
        task,
        ...(ticket !== undefined ? { ticket } : {}),
        connectable: this.connectable(task),
      }
    })

    const lanes: Record<PanelLane, TaskCard[]> = { todo: [], working: [], attention: [], done: [] }
    for (const card of cards) lanes[card.lane].push(card)
    return {
      cards,
      lanes,
      health: {
        online: health.online,
        endpoint: health.endpoint,
        ...(health.reason !== undefined ? { reason: health.reason } : {}),
        ...(health.paused === true ? { paused: true } : {}),
      },
      attention: lanes.attention.length,
      notes,
    }
  }

  /** 某仓库是否可指派：未配置执行器仓库时一律允许（单仓默认）。 */
  private connectable(task: TaskRecord): boolean {
    const repo = this.deps.executorRepo
    if (repo === undefined || repo === '') return true
    return task.repo === repo
  }

  private assertConnectable(task: TaskRecord): void {
    if (!this.connectable(task)) {
      throw new Error(`仓库 ${task.repo} 还没有接入执行器（当前执行器服务 ${this.deps.executorRepo}），不能指派`)
    }
  }

  private require(tasks: TaskRecord[], taskId: string): TaskRecord {
    const task = tasks.find((entry) => entry.id === taskId)
    if (task === undefined) throw new Error(`任务不存在：${taskId}`)
    return task
  }

  private async event(task: TaskRecord, kind: string, detail: string): Promise<void> {
    await this.deps.events
      ?.append({
        at: this.now().toISOString(),
        proposalId: task.proposalId ?? task.id,
        kind: 'team-settled',
        actor: 'human',
        taskId: task.id,
        status: kind,
        ...(detail !== '' ? { detail } : {}),
      })
      .catch(() => undefined)
  }
}

/** 默认的任务文件路径：`<rootDir>/tasks.json`（Config.taskFile 为空时）。 */
export const defaultTaskFile = (rootDir: string): string => join(rootDir, 'tasks.json')
