/**
 * 执行环境变量（change `adopt-superagent-openspec-source`, task 13）。
 *
 * 值只能来自 `values({ deployment, config, trigger })` 里能拿到的三样东西：
 * `meta`（投递时写进去的）、实例配置、部署信息。**不读盘**——`values` 只在投递时
 * 按 Trigger 计算一次，读盘会得到与来时不同的状态（审查发现的坑）。
 */
import type { EnvironmentInput, Trigger, VariableSpec } from './contract.ts'
import type { WorkmateConfig } from './kind.ts'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export const VARIABLES: readonly VariableSpec[] = [
  {
    key: 'DSH_SUPERAGENT_WORKMATE_TASK',
    description: { zh: '待办 ID：与 tasks.json 里的 id 一致', en: 'Task id, matching tasks.json' },
  },
  {
    key: 'DSH_SUPERAGENT_WORKMATE_ACCEPTANCE',
    description: { zh: '验收标准原文（人写的，未改写）', en: 'The acceptance criteria as written' },
  },
  {
    key: 'DSH_SUPERAGENT_WORKMATE_PRIORITY',
    description: { zh: '优先级 P0/P1/P2', en: 'Priority: P0, P1 or P2' },
  },
  {
    key: 'DSH_SUPERAGENT_WORKMATE_BASE_BRANCH',
    description: { zh: '基线分支：worktree 应从它切出', en: 'Base branch the worktree is cut from' },
  },
  {
    key: 'DSH_SUPERAGENT_WORKMATE_PORTS',
    description: { zh: '逗号分隔的端口段，供 prepare 写入 .env', en: 'Comma-separated port segment for prepare to write into .env' },
  },
  {
    key: 'DSH_SUPERAGENT_WORKMATE_COPY',
    description: { zh: '空格分隔的待复制文件（从主检出到 worktree）', en: 'Space-separated files to copy from the main checkout' },
  },
  {
    key: 'DSH_SUPERAGENT_WORKMATE_PROPOSAL',
    description: { zh: '关联的 OpenSpec change id；无关联时为空', en: 'Linked OpenSpec change id; empty when none' },
  },
]

/** 从 Trigger meta 与实例配置算出这一轮的环境变量。 */
export function environmentValues(input: EnvironmentInput<WorkmateConfig>): Record<string, string> {
  const meta = input.trigger?.meta ?? {}
  const ports = Array.isArray(meta['ports'])
    ? (meta['ports'] as unknown[]).filter((entry): entry is number => typeof entry === 'number')
    : []
  return {
    DSH_SUPERAGENT_WORKMATE_TASK: str(meta['taskId']),
    DSH_SUPERAGENT_WORKMATE_ACCEPTANCE: str(meta['acceptance']),
    DSH_SUPERAGENT_WORKMATE_PRIORITY: str(meta['priority']),
    DSH_SUPERAGENT_WORKMATE_BASE_BRANCH: str(meta['baseBranch']),
    DSH_SUPERAGENT_WORKMATE_PORTS: ports.join(','),
    DSH_SUPERAGENT_WORKMATE_COPY: (input.config.copyFiles ?? []).join(' '),
    DSH_SUPERAGENT_WORKMATE_PROPOSAL: str(meta['proposalId']),
  }
}

/** 供 `prepare` 模板使用的最小可复制片段（文档与测试共用）。 */
export const PREPARE_SNIPPET = `set -eu
branch="workmate/$DSH_SUPERAGENT_NAME"
dir="$DSH_SUPERAGENT_DIR"
if [ -d "$dir" ]; then exit 0; fi
if git -C "$PWD" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$PWD" worktree add "$dir" "$branch"
else
  git -C "$PWD" worktree add -b "$branch" "$dir" "$DSH_SUPERAGENT_WORKMATE_BASE_BRANCH"
fi
if [ -n "\${DSH_SUPERAGENT_WORKMATE_PORTS:-}" ]; then
  {
    echo ""
    echo "# WorkMate — auto-generated, safe to delete with the worktree"
    echo "WORKMATE_PORTS=$DSH_SUPERAGENT_WORKMATE_PORTS"
    echo "WORKMATE_PORT=\${DSH_SUPERAGENT_WORKMATE_PORTS%%,*}"
  } >> "$dir/.env"
fi
for file in \${DSH_SUPERAGENT_WORKMATE_COPY:-}; do
  [ -f "$PWD/$file" ] && cp "$PWD/$file" "$dir/$file"
done
if [ -f "$dir/package.json" ]; then (cd "$dir" && pnpm install); fi`

/** 只给测试/文档用：确认 Trigger 里该有的 meta 都在。 */
export function hasTaskMeta(trigger: Trigger): boolean {
  return str(trigger.meta['taskId']) !== ''
}
