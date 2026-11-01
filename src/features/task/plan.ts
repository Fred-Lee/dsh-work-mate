/**
 * 任务级端口规划（change `adopt-superagent-openspec-source`, task 12）。
 *
 * 执行交给 Super-agent 后，端口不再是"提案级"的：一个提案的多条 Ticket 会同时在跑，
 * 所以键从 `${proposalId}--${project}` 改成 `${proposalId}--${project}--${taskId}`
 * （无提案时 `${repo}--${taskId}`）。`attempt` 复用同一段——重试不该换端口，
 * 否则 `.env` 与正在跑的服务会错位。
 *
 * 分配表仍是 WorkMate 的 `ports.json`（跨进程的全局资源），由这里写、由回收读。
 */
import type { PortAllocator } from '../worktree/port-allocator.ts'

export interface PortPlanInput {
  proposalId?: string
  /** 项目名（注册表里的名字），不是路径。 */
  project: string
  taskId: string
}

/** 端口键：优先提案维度，其次仓库维度。 */
export function portKeyOf(input: PortPlanInput): string {
  const project = input.project.trim()
  if (input.proposalId !== undefined && input.proposalId.trim() !== '') {
    return `${input.proposalId.trim()}--${project}--${input.taskId}`
  }
  return `${project}--${input.taskId}`
}

/** 为一任务分配端口段；已分配则原样复用（幂等，重试不换端口）。 */
export async function planTaskPorts(
  allocator: PortAllocator,
  input: PortPlanInput,
): Promise<number[]> {
  const key = portKeyOf(input)
  const allocation = await allocator.allocate(key)
  return allocation.ports
}

/** 释放一任务的端口段；返回是否真的移除了一条记录。 */
export async function releaseTaskPorts(
  allocator: PortAllocator,
  input: PortPlanInput,
): Promise<boolean> {
  return allocator.release(portKeyOf(input))
}

/** 回收时兼容旧键：旧提案级分配（`${proposalId}--${project}`）也一并释放。 */
export async function releaseLegacyPorts(
  allocator: PortAllocator,
  input: { proposalId: string; project: string },
): Promise<boolean> {
  return allocator.release(`${input.proposalId.trim()}--${input.project.trim()}`)
}
