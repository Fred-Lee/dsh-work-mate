# Super-agent 接入的验收清单（真机）

> 适用变更：`adopt-superagent-openspec-source`（task 26，task 28 按此表执行）。
> 这里只列**只能真机验证**的项：jsdom 没有布局引擎，单测也造不出宿主里的
> SourceKind / Ticket / prepare。可以在仓库里跑的门禁见 `pnpm verify`。

执行方式：逐条勾选，证据（截图路径、命令输出、与 Super-agent 页面的对照）写入
`openspec/changes/adopt-superagent-openspec-source/evidence.md`。

**两档证据等级**：

- `[真机]`：需要真实的 Super-agent 进程 + DSH worker 会话 + GitHub 账号，只有这一档能证明
  "整条链路真的在跑"。
- `[引擎级]`：`node --experimental-transform-types scripts/verify-superagent-offline.mjs
  --superagent <path>` 跑的进程内演练。它用**真实**的 Super-agent `Engine`、**真实**的
  `settingsPolicy` 门禁、本仓库**真实**的 Source/Channel/prepare/reclaim 代码与真实 git，
  只有 worker 的执行与 PR 绑定是脚本扮演的。没有 GitHub 凭据时，这一档先把代码路径跑实。

## A. 安装与装载

- [x] [真机] 按 `docs/SUPERAGENT-INTEGRATION.md` §1 把 `workmate-superagent-source` 装进
      Super-agent 的 profile，宿主重启后：
      - [x] [真机] `node scripts/verify-source-install.mjs --profile <dir>` 四条全绿
      - [x] [真机] `--dump-config` 里出现 `- id: workmate-superagent-source`
      - [x] [真机] `--dump-config-schema` 里该条目 `status` 不是 `error` / `unsupported`
- [x] [真机] Source 页能看到来源 `workmate`，配置项含 `taskFile` / `interactive` /
      `pollSeconds` / `maxPerScan` / `maxRowsPerTask` / `repoRoot` / `openspecRoot`
- [x] [真机] Source 设置页能看到「能发起工作的创建者」`allowed` 表与准入行；非法策略被拒
      （`acceptedRule` → 400 Unrecognized key；`allowed` 写成字符串 → 400 expected array）
- [x] [真机] 把 `taskFile` 填成**与 WorkMate 配置相同的绝对路径**后，健康条目从错误变为
      `ready`（或 `starting` 后转 `ready`）

## B. `interactive=false` 首跑（只读）

- [x] [真机] 面板建一条待办 → Super-agent 的 Trigger / Thread 页出现对应 Thread
      （key `workmate:<taskId>`），内容与 `intent` 原文一致
- [x] [真机] 此时**没有** Ticket，面板卡片显示"已记录，等待执行器扫描 / 待扫描"一类文案，
      不是"已投递"、也不是"执行中"
- [x] [真机] 面板与 Super-agent 的 Thread 页对同一条待办的标题、时间、内容一致

## C. 打开 `interactive=true` 后的六阶段对照

逐阶段把面板卡片与 Super-agent 的 Ticket / Execution 页并排看，**文案与阶段必须对得上**：

| # | Super-agent 阶段 | 面板列 | 面板文案（`SUBSTATE_LABEL`） | 通过标准 |
| --- | --- | --- | --- | --- |
| 1 | 无 Ticket（未指派） | 待办 | `未指派` | 卡片只显示目标原文，没有编造的阶段 |
| 2 | 已投递、等待 Eval/路由 | 执行中 | `待接受` | 不显示"已开工"；被忽略时 notes 里有原因 |
| 3 | `working` / `queued` | 执行中 | `执行中` / `排队中` | 与 Execution 页的 worker 状态一致 |
| 4 | `person/answer` | 需要我 | `待回答` | 卡片显示提问原文；回答后回到执行中 |
| 5 | `person/review` | 需要我 | `待验收` | 与 Execution 页的验收动作对应 |
| 6 | `ended`（completed / merged / closed / dropped / stopped） | 已完成 | 五值各自对应 | 不漏判成执行中（ended 优先） |

- [ ] 六个阶段各截一张图（面板 + Super-agent 页对照）
- [ ] 中途 stop 一次：面板卡片回到"待办/已停止"，Super-agent 的 Ticket 以
      `stopped` 结束
- [ ] retry 一次：同一任务 `attempt` 递增，端口段不变（worktree 的 `.env` 未出现第二组）

## D. worktree 与执行环境

- [x] [引擎级] `executor.directory` 配成 `<repo>/.workmates`；Ticket 首次 launch 后磁盘上
      只有**一个** worktree，位于 `<repo>/.workmates/<Ticket 短名>`
- [x] [引擎级] `git worktree list` 里该目录的分支是 `workmate/<Ticket 短名>`
- [x] [引擎级] WorkMate **没有**在 `ready→implementing` 时预建目录（prepare 前目录不存在已验证）
- [ ] [真机] worker 环境里可见：`DSH_SUPERAGENT_WORKMATE_TASK` / `_ACCEPTANCE` /
      `_PRIORITY` / `_BASE_BRANCH` / `_PORTS` / `_PROPOSAL`（在 worker 终端里 `env | grep`）
- [x] [引擎级] `.env` 里有 `WORKMATE_PORT` 与 `WORKMATE_PORTS`（未验证重复追加）
- [ ] [真机] `prepare` 故意写错基线分支 → Ticket 失败，面板显示失败原因（不是无限重试）

## E. Channel 端到端回写

- [x] [引擎级] worker 结束并回答后，`tasks.jsonl` 追加了至少一条带 `ticketId` 的送达记录
      （`ack` / `reply` / `notice` / `error` 之一），且同一 `messageId` 不重复
- [x] [引擎级] 人在面板"回答"一条 → `inputs.jsonl` 追加一行，Super-agent 的 Thread 上出现
      `human: true` 的 Trigger；**不**重新走 Eval
- [x] [引擎级] 把待办从 `tasks.json` 删掉后，Channel 的送达返回 `gone`，不写幽灵行
- [x] [引擎级] `tasks.jsonl` 超过 `maxRowsPerTask` 后压缩为最近若干行，仍保留至少一条 `ack`
      与最后一条结果

## F. 面板布局（四档宽度）

宿主 `main` 槽是确定高度列，面板根自带高度与滚动契约。四档宽度下：

- [ ] 320：任务四列改为纵向堆叠，卡片不溢出，抽屉可滚动且能关闭
- [ ] 760：四列可见，卡片标题两行截断，操作按钮不换行到第二屏
- [ ] 1180：四列 + 详情抽屉并排不挤压，图例/健康条可见
- [ ] 1440：列宽铺满，无横向滚动条
- [ ] 每档截一张图；`wm-task-view` 的滚动只应发生在唯一滚动子层

## G. 回退演练

- [ ] [真机] `taskExecutor=team` 后，团队 Run 派发可用（`workmate_team_run` 不再返回 disabled），
      面板团队视图出现"回退执行器"徽标
- [ ] [真机] 停用子包 bundle 后，Super-agent 不再产生该来源的 Trigger
- [x] [引擎级] `node scripts/rollback-superagent.mjs --dry-run` 列出目录/分支/端口计划
- [x] [引擎级] 实跑一次：worktree 移除、已合并分支删除、端口键释放；`git worktree list` 干净
- [x] [引擎级] 人为制造"端口键不存在"的任务 → 脚本输出"端口可能泄漏"，不静默通过

## H. 失败与离线

- [ ] 停掉 Super-agent：面板卡片显示"执行器离线"，待办仍可新建与编辑，
      不出现"已投递"
- [ ] 卸掉子包（但 WorkMate 仍在）：任务列表仍可读，执行列显示 `unknown`，
      不崩、不空白
- [ ] `tasks.json` 手工写坏 → 面板报错且**不覆盖**文件；回滚脚本退出码 2 且不动磁盘

## 记录模板

```
## <日期> 真机验收
- 环境：Super-agent 版本 / DSH 版本 / profile 名
- A. 安装：<verify-source-install 输出摘要>
- B/C. 六阶段：<截图路径 1..6>，对照结论：一致 / 差异（说明）
- D. worktree：<git worktree list 输出>，env 证据：<命令输出>
- E. Channel：<tasks.jsonl 尾 3 行>、<inputs.jsonl 尾 1 行>
- F. 布局：<四档截图路径>
- G. 回退：<rollback 输出摘要>
- H. 失败：<截图或输出>
```
