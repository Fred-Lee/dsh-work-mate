# WorkMate × Super-agent 接入手册

> 适用变更：`adopt-superagent-openspec-source`（tasks 18 / 22 / 25）。
> 目标读者：要把 WorkMate 待办板接到 Super-agent 的部署者。

## 0. 定位

执行交给 **Super-agent**：待办 → Trigger → Eval → Ticket → worker；
WorkMate 保留**治理与知识**：提案、OpenSpec、审批门、写域机检、归档门、知识桥接。

所以两侧装的是两个东西：

| 侧 | 装什么 | 作用 |
| --- | --- | --- |
| DSH profile | `workmate4dsh`（本仓库根包） | 面板、工具、REST、治理链路 |
| Super-agent profile | `workmate-superagent-source`（`packages/superagent-source`） | 把待办文件读成 Source 事件，并把执行事实写回文件 |

**不要**把根包装进 Super-agent 的 profile：它会把整个面板一起插进去，且 Super-agent
并不需要它。两个包物理隔离正是为此（design D2 / D2c）。

## 1. 安装子包 bundle

子包不发布到 npm，用 profile 的 `link:` 安装：

```bash
DSH=/Users/fredlee/Documents/workspace/deepseek-harness/apps/cli/lib/bin.js
node $DSH plugin --profile superagent add /path/to/dsh-Helmsman/packages/superagent-source
```

或手工等价（profile 目录里）：

```jsonc
// package.json
"dependencies": { "workmate-superagent-source": "link:/path/to/dsh-Helmsman/packages/superagent-source" },
"dsh": { "profile": { "bundles": ["workmate-superagent-source"] } }
```

```bash
npx --yes pnpm@10 install      # pnpm 11 与本机 store 版本不一致时用这条
```

装完重启 Super-agent（bundle patch 不热加载）。宿主会把任何声明了 `dsh.bundle.patch`
的新依赖自动加入 `dsh.profile.bundles`（`profile-plugins.ts:101-125`），所以"装即启用"，
不需要手写 profile 行。

子包模块级 `inject = ['orchestrator']`：装进没有 orchestrator 的 profile 时它保持等待，
不会半死不活。`node scripts/verify-source-install.mjs --profile <dir>` 可做安装期自检
（见 §8）。

## 2. Source 实例配置

在 Super-agent 面板的 Source 页新建一个 `workmate` 实例。字段含义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `taskFile` | ✅ | `tasks.json` 的**绝对路径**，必须与 WorkMate 侧完全一致（见 §2.1） |
| `interactive` | | 关（默认）时只读任务、只写回执，不产生任何 Trigger；首跑建议先关 |
| `pollSeconds` | | 扫描间隔，默认 5 |
| `maxPerScan` | | 单轮最多投递，默认 5；人的回答不受此限 |
| `maxRowsPerTask` | | 单任务 `tasks.jsonl` 行数上限，默认 200，超出压缩为最近若干行 |
| `repoRoot` | | 填了才会读该仓库的 OpenSpec 工件作为评估上下文 |
| `openspecRoot` | | 相对 `repoRoot` 的 OpenSpec 目录，默认 `openspec` |
| `copyFiles` | | 从主检出复制进 worktree 的文件，默认 `['.env', '.env.local']` |

### 2.1 `taskFile` 只能有一个绝对路径

`tasks.json` 是三份文件的写者分离模型里"人的意图"那一份（见 §3）。WorkMate 的
`Config.taskFile` 与 Source 实例的 `taskFile` **必须指向同一个绝对文件**：

- 不填 WorkMate 侧时，默认是 `$DSH_HOME/workmate/tasks.json`；Source 侧也要填这个绝对路径；
- 从 `inputs.jsonl` / `tasks.jsonl` 就近派生（同目录同名），所以两侧一致时三份文件都对得上；
- 相对路径会被 `validateConfig` 拒绝（`taskFile 必须是绝对路径`），Source 保持沉默并报健康错误。

### 2.2 首跑用 `interactive=false`

第一次接入建议按这个顺序来：

1. `interactive=false`，在 WorkMate 面板建一条待办并指派；
2. 打开 Super-agent 的 Trigger / Thread 页，确认 Source 把它读成了一个 Thread；
3. 再打开 `interactive=true`，确认产生 Ticket、worker 起在 `<repo>/.workmates/` 下；
4. 最后才把 `explicit` 准入（§4）打开给同事用。

这一步的价值：Source 只读时能先验证"文件形状 + 投影"是对的，而不必一边排故障一边
承担"已经投递出去的请求"。

## 3. 三份文件、三个单写者

| 文件 | 唯一写者 | 内容 |
| --- | --- | --- |
| `tasks.json` | WorkMate 面板 | 人的意图与指派/放弃标记；tmp+rename 原子写，损坏 fail-closed |
| `inputs.jsonl` | WorkMate 面板 | 人后续的回答与补充；append-only |
| `tasks.jsonl` | Source | 经 Channel 送达的 ack / reply / notice / error；append-only |

三份文件**不互相写**，也不出现第四个承载执行状态的文件。执行阶段一律从 Super-agent
的 Ticket 投影读取（Source 在进程内读），不从 `tasks.jsonl` 猜。

`tasks.jsonl` 只证明"这条消息经该信道送达过"，不是 Ticket 状态的副本——Channel 的
`kind` 只有 acknowledgement / reply / notice，progress 从不过 Channel。

## 4. 准入：explicit 的两步

待办的 Trigger 是 `human: true`、`addressed: 'mention'`、`actor = { source: 'workmate',
id: 'workmate:<createdBy>' }`。Super-agent 对 `strength === 'explicit'` 的候选**不走**
`assessmentOutcome`（`assessment.ts:113` 直接抛 `EXPLICIT`），而由主 Session 的
`orchestrator_route` 交给 `engine.decide(accept)` 建单；`evals.decide` 只在非 explicit
时校验规则（`evals.ts:152-154`）。所以只需要两步：

1. 在 Super-agent 的 policy 里，把来源 `workmate` 的 `allowed` 列表加上操作者身份
   `workmate:<createdBy>`（面板默认写 `workmate:panel`；自定义操作者按其实际值）；
2. **不需要写任何接受规则**——explicit 的语义就是"一个被允许的人明确要求"。

若坚持走 `inferred`（例如批量导入），才需要补一条规则文本让候选至少匹配一条；
这时面板会如实显示"已投递评估 / 已忽略 + 原因"，不假装开工。

## 5. `executor.prepare` 模板

执行根（`executor.directory`）必须配成 `<repo>/.workmates`，让 Ticket 目录落在
`<repo>/.workmates/<短名>`——沿用仓库已有的 `.workmates/` 排除规则。

```sh
set -eu
branch="workmate/$DSH_SUPERAGENT_NAME"
dir="$DSH_SUPERAGENT_DIR"
if [ -d "$dir" ]; then exit 0; fi
if git -C "$PWD" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$PWD" worktree add "$dir" "$branch"
else
  git -C "$PWD" worktree add -b "$branch" "$dir" "$DSH_SUPERAGENT_WORKMATE_BASE_BRANCH"
fi
if [ -n "${DSH_SUPERAGENT_WORKMATE_PORTS:-}" ]; then
  {
    echo ""
    echo "# WorkMate — auto-generated, safe to delete with the worktree"
    echo "WORKMATE_PORTS=$DSH_SUPERAGENT_WORKMATE_PORTS"
    echo "WORKMATE_PORT=${DSH_SUPERAGENT_WORKMATE_PORTS%%,*}"
  } >> "$dir/.env"
fi
for file in ${DSH_SUPERAGENT_WORKMATE_COPY:-}; do
  [ -f "$PWD/$file" ] && cp "$PWD/$file" "$dir/$file"
done
if [ -f "$dir/package.json" ]; then (cd "$dir" && pnpm install); fi
```

要点：

- **目录只能由 prepare 创建**。WorkMate 不在 `ready→implementing` 时抢先建目录——Super-agent
  把"目录已存在"当作"已准备好"，会跳过 prepare（连凭据检查一起跳过），worker 拿到的是
  没有初始化的空目录。
- 分支以 `workmate/$DSH_SUPERAGENT_NAME` 命名，末段等于 Ticket 短名，PR 归属规则才成立。
- 端口段由 Source 从任务记录的 `ports` 注册成 `DSH_SUPERAGENT_WORKMATE_PORTS`；同一任务
  的重试复用同一段（`.env` 不被重复覆盖）。
- WorkMate 规划的是"基线分支 / 分支名 / 端口 / 任务 ID"，目录与 worker 的 cwd 属于
  Super-agent，WorkMate 只从 Ticket 投影的顶层 `directory` 读取。

## 6. "指派"不等于"开工"

指派只做三件事：写 `tasks.json` 的 `assigned=true`、递增 `attempt`、把这条待办交给
Source 的下一次扫描。之后是 Super-agent 的领域流程：

- Eval / route 仍可能**不接**这条请求（例如 explicit 没打开、规则不匹配、模型判断超出范围）；
- 面板据此显示"已投递，等待接受"，而不是"已开工"；
- 执行器离线时，面板显示"执行器离线"，待办仍可记录（文件不依赖它）。

## 7. 回滚：三件事，缺一泄漏

从 `superagent` 退回 `team`（或彻底拆掉 Super-agent）时，必须同时做三件事，缺一件就会
留下"目录还在、端口没放、执行器还在投递"的中间态：

1. **`taskExecutor=team`**（WorkMate 的 `cordis.patch.yml`）：否则面板仍把新待办标成
   "superagent 模式"，Source 仍会扫描投递；
2. **停用 `workmate-superagent-source` bundle**（Super-agent 的 profile）：否则它继续
   读任务文件、继续产生 Trigger；
3. **清理 worktree、分支与端口**：执行
   ```bash
   node scripts/rollback-superagent.mjs --dry-run     # 先看计划
   node scripts/rollback-superagent.mjs               # 再执行
   ```

第 3 步**不依赖 Super-agent 在线**：

- 定位分三级——① 任务记录缓存的 `directory`（面板观察到 Ticket 时回写）；
  ② `<repo>/.workmates/` 里以 Ticket 前 12 位结尾的名字；③ 目录名里带任务 ID 的目录；
- 分支名优先取提案 target 已回写的 `featureBranch`，其次才按目录末段推导；
- 端口按 `ports.json` 的新键、仓库键、旧提案键依次释放；
- 一个端口键都没命中时输出"**端口可能泄漏**"，不静默通过；
- 每个任务输出目录、分支、端口与处理结果——不打印一句"完成"了事。

未合并的分支默认**拒绝删除**（`git worktree remove --force` 只删目录，分支保留）；
确认丢得起时加 `--force`。

`tasks.json` 损坏时脚本以退出码 2 结束且**什么都不动**：坏表下继续删目录等于拿猜测去动
别人的磁盘。

## 8. 安装期自检

```bash
node scripts/verify-source-install.mjs --profile /path/to/superagent/profile
node scripts/verify-source-install.mjs --profile <dir> --name <profile 名> --dsh <宿主 bin.js>
node scripts/verify-source-install.mjs --profile <dir> --dsh none   # 离线：跳过运行时那条
```

断言四件事：① 包已安装且版本可读；② `dsh.profile.bundles` 含
`workmate-superagent-source`；③ 该 bundle 的 patch 只有一条 entry；④ `workmate` 来源
出现在 `--dump-config-schema` 且 `status: schema`。

三种安装状态的期望结论：

| 状态 | ① | ② | ③ | ④ | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 正常安装 | ok | ok | ok | ok（找不到宿主时标 skip） | 0 |
| 已装未启用（不在 bundles） | ok | FAIL | ok | FAIL（条目不出现） | 1 |
| 未安装 | FAIL | FAIL | FAIL | FAIL | 1 |

`FAIL` 的项不修好，这个来源不会工作；排查见 §9。

## 8.1 没有 GitHub 时的引擎级演练

真机验收的最后一段（Ticket 生命周期、worktree、Channel 回写、回收）需要
`gh auth login` 与一个可写仓库。没有这些时可以先跑进程内演练——它用的都是真代码：

```bash
node --experimental-transform-types scripts/verify-superagent-offline.mjs \
     --superagent /path/to/dsh-superagent-prototype    # 或 pnpm verify:drill
```

覆盖：真实 `Engine` 的 accept/assignmentStarted/report/bindThread/threadClosed、
真实 `settingsPolicy` 门禁（explicit）、真实 `scanOnce`/`Channel`/`PREPARE_SNIPPET`/
`reclaimOne`，以及在真实 git 仓库上建出的 worktree、分支与 `.env` 端口。
**不含**：DSH worker 会话真的执行工作、GitHub PR 归属与合并、面板 ↔ Execution 页对照。

结果与逐项证据见 `openspec/changes/adopt-superagent-openspec-source/evidence.md`。

## 9. 故障排查

| 现象 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 面板显示"执行器离线" | WorkMate 的 `superagentEndpoint` 不通 | 确认 Super-agent 的 Web 端口，`curl -H 'x-orchestrator-request: 1' <endpoint>/orchestrator/api/tickets` |
| Source 健康报"配置不可用" | `taskFile` 未填/是相对路径 | 填成与 WorkMate 一致的绝对路径 |
| 待办一直是"待扫描" | `interactive=false` | 打开 Source 的"投递待办"开关 |
| 投递了但一直"待接受" | 准入没打开（不是 explicit） | 把 `workmate:<createdBy>` 加入来源 `workmate` 的 `allowed` |
| worker 的目录是空的 | WorkMate 抢先建过目录，prepare 被跳过 | 删掉该目录后让 Ticket 重试；后续不要预建 |
| `git worktree remove` 失败 | 目录不是本仓的 worktree（prepare 半成品） | 脚本会标"拒绝"并给出路径，人工确认后处理 |
| 回滚报告"端口可能泄漏" | `ports.json` 里没有对应键（旧提案级分配） | 人工核对 `ports.json`；脚本会列出未归属的键 |
| 分支未合并被拒删 | 正常保护 | 合并后重跑，或确认后 `--force` |
| 装完 Source 没生效 | bundle patch 不热加载 | 重启 Super-agent，再跑 §8 自检 |
| `--dump-config` 没有 `workmate` 条目 | bundle 未进 `dsh.profile.bundles` | 重装子包，或手工把包名加进 `bundles` 后 `pnpm install` |
