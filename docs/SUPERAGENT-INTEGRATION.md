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

## 7. 回滚：两件事，缺一泄漏

团队执行器已在 `remove-team-executor` 中删除，`taskExecutor=team` 不再可用。要拆掉
Super-agent 时，必须同时做两件事，缺一件就会留下"目录还在、端口没放、执行器还在投递"
的中间态：

1. **停用 `workmate-superagent-source` bundle**（Super-agent 的 profile）：否则它继续
   读任务文件、继续产生 Trigger；
2. **清理 worktree、分支与端口**：执行
   ```bash
   node scripts/rollback-superagent.mjs --dry-run     # 先看计划
   node scripts/rollback-superagent.mjs               # 再执行
   ```

第 2 步**不依赖 Super-agent 在线**：

- 定位分三级——① 任务记录缓存的 `directory`（面板观察到 Ticket 时回写）；
  ② `<repo>/.workmates/` 里以 Ticket 前 12 位结尾的名字；③ 目录名里带任务 ID 的目录；
- 分支名优先取提案 target 已回写的 `featureBranch`，其次才按目录末段推导；
- 端口按 `ports.json` 的新键、仓库键、旧提案键依次释放（键里的项目名先按
  `projects.json` 归一：实现待办的 `repo` 是绝对路径，按真实路径匹配 `root` 后再取项目名）；
- 一个端口键都没命中时输出"**端口可能泄漏**"，不静默通过；
- 每个任务输出目录、分支、端口与处理结果——不打印一句"完成"了事。

结论只在**没有**未解析仓库 / 端口泄漏 / 拒删 / 删除失败时才是"已按预期处理"；
有任何一项时打印"N 条需要人工跟进"并以退出码 1 结束——端口可能泄漏也算在内，
没人会去复查一串被绿色结论掩盖的备注。

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
| 回滚报告"端口可能泄漏" | `ports.json` 里没有对应键（旧提案级分配，或 `repo` 与注册表项目名对不上） | 人工核对 `ports.json`；脚本会列出未归属的键。项目名对不上时先确认 `projects.json` 里有该仓库（脚本按 `root` 真实路径、项目名、目录名末段三级匹配） |
| 分支未合并被拒删 | 正常保护 | 合并后重跑，或确认后 `--force` |
| 装完 Source 没生效 | bundle patch 不热加载 | 重启 Super-agent，再跑 §8 自检 |
| `--dump-config` 没有 `workmate` 条目 | bundle 未进 `dsh.profile.bundles` | 重装子包，或手工把包名加进 `bundles` 后 `pnpm install` |

## 10. 多仓库部署（多实例）

> 适用变更：`support-multi-repo-executors`。一个执行器仍只服务一个仓库
> （`deployment.repository` / `executor.directory` 是单值，这是 Super-agent 的既有语义），
> 多仓库靠**多个执行器**承担；本变更让 Source 实例按仓库过滤、让面板按"已接入仓库集合"
> 如实显示可指派性，并允许同一进程注册多个本来源实例。

### 10.1 两种部署形态

| 形态 | 用途 | 实例 id |
| --- | --- | --- |
| 每仓一个执行器（标准） | 真正的多仓执行：每个仓库一个 Super-agent 部署（独立 profile/进程、独立 `stateDir`、`deployment.repository`、`executor.directory`） | 各自进程内用默认 `workmate` 即可——kind 注册表是**进程内**的，不同进程不会互撞 |
| 同一进程多实例 | 一个进程里注册多个本来源实例（同一 `taskFile` 按 `repos` 分流读取，或 profile 内多条 entry 装载）。它们共享同一执行器，**不能**用来跨仓干活 | 必须显式给唯一 `kind`（`workmate` / `workmate-b`），重复 kind 会被宿主直接拒绝 |

WorkMate 的任务文件只有一份（`tasks.json`，面板独占写），所有仓库的待办都在里面。
所以每个执行器的 Source 实例都要读同一份文件、各自按 `repos` 过滤：不归本实例的待办
**不投递**、不推进任何游标，并在健康摘要里记「跳过 N 条（非本实例仓库）」——这样人能区分
"没活干"与"这条是别的仓库的活"。

### 10.2 实例 id（kind）从哪来

注册发生在插件 `apply` 阶段，而 Source 设置**按已注册的 kind 存**（`settings.sources[kind]`）：
第二个实例必须先有 `workmate-b` 这个 kind，才有地方填它的 `taskFile` / `repos`。因此实例 id
只能由装载它的**插件条目**给：

```yaml
# Super-agent profile 的 cordis patch（与 bundle 自带的那条并列）
- insert:
    - id: workmate-superagent-source-b
      name: workmate-superagent-source
      config:
        kind: workmate-b
```

- 默认实例（旧部署）**什么都不用改**：不写 `config.kind` 就是 `workmate`；
- 同一个包可以在 profile 里出现多条 entry（宿主按 entry **id** 实例化，`name` 可重复）；
  本包自己的 `cordis.patch.yml` 仍只有一条，`pnpm verify:source` 不受影响；
- 非法的 id（大写 / 下划线 / 数字开头等，必须匹配 `^[a-z][a-z0-9-]*$`）会让**装载失败**：
  注册表用 kind 作键，不能静默歪写。装在没有 Super-agent 的 profile 时仍然安静跳过；
- 来源设置页里的「实例 ID」是**只读事实**（`facts`）：它不是注册来源，改它不会换实例；
  换 id 必须改 profile 条目的 `config.kind` 并重启宿主。设置里若显式写了不同的 `kind`，
  健康条目会报"不一致"错误，而不是静默忽略；
- 所有按实例派生的标识都随 id 走：注册键、健康条目名、state 键
  （`workmate-source:<id>:cursor|tickets`）、Trigger `source`、Thread/Channel 前缀、
  `find()` 结果、来源页标题（默认实例仍是「WorkMate 待办」，其余为「WorkMate 待办（workmate-b）」）。
- 升级兼容：默认实例旧的无实例段 state 键（`workmate-source:cursor|tickets`）**只读回退**，
  新写入一律带实例段；已结束 Ticket 的映射不会因为升级丢失。

### 10.3 每个实例的配置

`source.repos` 是本实例负责的仓库**绝对路径**数组（空 = 不限制，旧行为）。面板里的
「负责的仓库」是逗号分隔的文本框——Super-agent 的 `rows` 字段只能编辑记录数组，装不下
`string[]`；用 JSON / API 写配置时直接写数组即可。元素必须是绝对路径，否则配置不可用并在
健康里报错（相对路径不可能与待办里的绝对 `repo` 相等，放行只会静默零投递）。

**四处必须一致**（design D7；错一处就是"验的是 A 仓、建在 B 仓"的静默错位）：

| 位置 | 必须指向 | 错位的后果 |
| --- | --- | --- |
| `source.repos`（本实例） | 该执行器负责的仓库绝对路径 | 别的仓库的待办被投给这个执行器（或在它这里全被跳过） |
| `deployment.repository` | 同一个仓库（git URL / `group/project` / 绝对路径） | `git ls-remote` 与 PR 归属验的是 A 仓 |
| `executor.directory` | 同一个仓库下的 `.workmates`（`prepare` 的 `$PWD` 是它的父级） | worktree 建在 B 仓，`git -C "$PWD"` 失败或提交进错仓 |
| `stateDir` | **每个执行器独立**（不要两个部署共用一个） | SQLite 锁冲突、游标/Ticket 混在一起 |

部署前检查清单：

- [ ] 每个仓库一个 Super-agent 部署；`stateDir` 互不相同；
- [ ] 每个部署的 `deployment.repository` 与 `executor.directory` 指向同一个仓库（见上表）；
- [ ] 每个 Source 实例的 `repos` 只含本部署负责的仓库；`taskFile` 指向 WorkMate 的同一份绝对路径；
- [ ] 每个实例的 `policy.allowed` 各自配好（`actor.id` 仍是 `workmate:<createdBy>`，
      但 policy 按来源 kind 存：同进程多实例时两份都要配）；
- [ ] 改完**重启 Super-agent**（kind 注册在 `apply` 阶段，bundle patch 与 entry 不热加载）。

### 10.4 WorkMate 侧配置（面板）

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml 的 workmate 条目
config:
  executorRepos:                 # 哪些仓库有执行器；空 = 不限制（旧行为）
    - /Users/me/work/repo-a
    - /Users/me/work/repo-b
  superagentEndpoints:           # 每个执行器一个管理 API 端点；空 = 退回单值 superagentEndpoint
    - http://127.0.0.1:3080
    - http://127.0.0.1:3090
```

- `executorRepos` 与单值 `executorRepo`（兼容写法）合并成集合：只有集合内的 `repo` 才显示
  「指派」；否则卡片显示「未接入执行器（仓库 X）」并禁用指派。集合为空 = 不限制，保持旧行为；
- 指派到集合外的仓库会被**服务端拒绝**（错误信息点明仓库与已接入集合），不只是 UI 禁用；
- `superagentEndpoints` 与单值 `superagentEndpoint` 同理：面板对每个端点独立探活、独立取
  Ticket，一个端点离线只影响它服务的那批待办，顶部显示「N 个执行器，M 个离线」；
  `TaskBoard.health` 保留单值（首个端点）给旧客户端读，新字段 `endpoints` 给出逐端点状态；
- 端点离线时无法逐卡归因到具体执行器（主包没有 repo→endpoint 映射），因此卡片保持原投影、
  离线原因进 `notes` 与 `endpoints`，不伪造状态。

### 10.5 重启边界

`kind` / entry 的增删、`dsh.profile.bundles` 变更都必须**重启 Super-agent** 才生效；WorkMate
侧的 `executorRepos` / `superagentEndpoints` 是普通插件配置，同样需要宿主重启后生效
（本机：`pnpm build` 后重装/重载 profile）。不要指望热重载。

### 10.6 排查（多仓相关）

| 现象 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 面板显示「未接入执行器（仓库 X）」 | 该仓库不在 `executorRepos`（或落在 `executorRepo` 单值外） | 加上对应仓库；确认该仓确实已有执行器 |
| 待办一直"待接受"，健康显示「跳过 N 条（非本实例仓库）」 | 实例的 `repos` 没包含这条待办的 `repo`，或路径写法不同 | 用绝对路径、与待办 `repo` 逐字一致（尾斜杠会被规范化，basename 不会猜） |
| 第二个实例没出现在来源页 | entry 没加进 profile / kind 非法导致装载失败 / 未重启 | 查宿主日志里 `workmate-superagent-source` 的报错；确认 kind 匹配 `^[a-z][a-z0-9-]*$` |
| 设置页改了「实例 ID」没反应 | id 由插件条目 `config.kind` 决定，设置页是只读 fact | 改 profile entry 的 `config.kind` 后重启 |
| 两个实例健康互相覆盖 / 注册报 already registered | 两个实例用了同一个 `kind` | 每个实例一个唯一 id（宿主对重复 kind 直接抛） |
| 两个实例读到同一待办并重复投递 | 实例的 `repos` 都是空（不限制）且共用同一 `taskFile` | 给每个实例配不相交的 `repos`；空 `repos` 是"所有仓库都投" |
