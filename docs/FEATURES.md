# Helmsman 功能清单

## 技术底座

DSH Cordis 第三方插件集,10 包 / 具名导出 / 零运行时第三方依赖。

## @helmsman/worktree

- git worktree 创建 / 清理 / 收集 diff(含未跟踪文件)
- patch 经 stdin 合并回主仓库,冲突时主仓库原状返回 conflictFiles
- 无 shell、路径 / 字符校验、根目录越界检查;惰性集成 dsh-virtual-workspace

## @helmsman/memory-topology

- 项目群拓扑 JSON 存储(CJK 安全、形状清洗)
- Maven(`${property}` / dependencyManagement / modules / parent)与 REST API(Spring / NestJS / Express)自动扫描
- docker-compose / K8s / OpenAPI 导入;YAML 导出;下游依赖图与拓扑序
- 3 个 agent 工具;镜像到 dsh-memory-manager

## @helmsman/orchestrator

- 多 Agent 并行调度引擎 + 状态机(创建→执行→聚合→完成 / 部分失败 / 全败,可取消)
- 限流指数退避(2s/8s/32s,默认 3 次)、401 不重试、30s 断路器
- 4 个 agent 工具(run_parallel / task_status / cancel_task / merge_task)

## 4 个 Adapter(Claude / Codex / Pi / oh-my-pi)

非交互 CLI 执行,argv 数组无 shell、超时 / 取消杀进程树、流式日志、命令参数可配置。

## @helmsman/ui-dashboard(主控面板)

- useReducer 单向数据流;项目群 / 服务 / 依赖配置面板(含 dirty 未保存确认、已修复轮询覆盖 bug)
- Agent 卡片七状态机(待命 / 执行 / 完成 / 失败 / 超时 / 限流 / 认证失效)+ 计时日志
- 拓扑导入导出、任务派发 / 取消 / 重试 / 合并、深链 `?panel=config&theme=dark`
- 边缘状态全量(骨架屏 / 空态 / 错误重试 / 离线横幅 / 降级 / 断路器)+ 7 色双主题 + 响应式

## @helmsman/ui-diff(对比合并)

- split / unified / side-by-side 三视图;行内评论、行号复制
- 冲突方案选择(采纳某 agent / 手动);合并单 agent / 合并所选文件 / 全部放弃

## @helmsman/bundle

一条命令聚合装入全部插件。

## 跨包

59 个测试 / 11 文件、typecheck + build 通过、4 种分发方式、安全审计(无 shell / 无 eval / 无外发 / 扫描上限)。
