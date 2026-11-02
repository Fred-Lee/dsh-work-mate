/**
 * Worktree 回收与端口分配（change `remove-swarm-parallel` 之后的存留部分）。
 *
 * 创建已不在这里：目录由 Super-agent 的 `executor.prepare` 建（`adopt-superagent-openspec-source`
 * design D10b），swarm 与团队执行器的 `create` 调用方都已删除。剩下两件事：
 *   - `ports()`：任务级端口规划（`task/plan.ts`）与回收（`task/reclaim.ts`）用；
 *   - `remove()`：归档时清理**团队时代遗留**的 `targets[].worktreePath`
 *     （新提案不再写该字段，这条路径只对旧数据有效）。
 */
import { join } from 'node:path'
import { gitExec, isMergedInto } from './git.ts'
import { PortAllocator } from './port-allocator.ts'

export interface ManagerOptions {
  homeRoot?: string
  subdir: string
  basePort: number
  portStep: number
}

const WORKMATES_DIR = '.workmates'

export class WorktreeManager {
  private readonly allocator: PortAllocator
  constructor(private readonly options: ManagerOptions) {
    this.allocator = new PortAllocator(options, options.basePort, options.portStep)
  }

  ports(): PortAllocator {
    return this.allocator
  }

  worktreePath(projectRoot: string, proposalId: string): string {
    return join(projectRoot, WORKMATES_DIR, proposalId)
  }

  private portKey(proposalId: string, project?: string): string {
    return project === undefined ? proposalId : `${proposalId}--${project}`
  }

  /**
   * Remove the worktree after confirming the feature branch content is merged
   * into main (unless forced). Releases the port segment first so a failed
   * removal never leaks a held range.
   */
  async remove(input: {
    projectRoot: string
    proposalId: string
    project?: string
    mainBranch?: string
    baseBranch?: string
    force?: boolean
    /** Rollback path: delete the feature branch this creation made (unmerged ok). */
    deleteBranch?: boolean
    signal?: AbortSignal
  }): Promise<{ removed: boolean; summary: string }> {
    const { projectRoot, proposalId } = input
    const mainBranch = input.baseBranch ?? input.mainBranch ?? 'main'
    const featureBranch = `feature/${proposalId}`
    const worktreePath = this.worktreePath(projectRoot, proposalId)

    if (input.force !== true) {
      const merged = await isMergedInto(projectRoot, featureBranch, mainBranch)
      if (!merged) {
        return { removed: false, summary: `feature/${proposalId} is not merged into ${mainBranch} — refusing removal (force to override)` }
      }
    }

    try {
      await gitExec(['worktree', 'remove', '--force', worktreePath], projectRoot, 15_000, input.signal)
    } catch (error) {
      // Keep the allocation: the worktree still exists and may still hold a port.
      try {
        await gitExec(['worktree', 'list'], projectRoot)
      } catch {
        // ignore
      }
      return { removed: false, summary: `git worktree remove failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (input.deleteBranch === true) {
      await gitExec(['branch', '-D', featureBranch], projectRoot, 10_000, input.signal).catch(() => undefined)
    }
    await this.allocator.release(this.portKey(proposalId, input.project))
    return {
      removed: true,
      summary: `worktree ${worktreePath} removed${input.deleteBranch === true ? ` and branch ${featureBranch}` : ''} and ports released`,
    }
  }

  /** Read back the allocation for panel display. */
  async allocationFor(proposalId: string, project?: string): Promise<number[] | undefined> {
    return (await this.allocator.get(this.portKey(proposalId, project)))?.ports
  }
}

