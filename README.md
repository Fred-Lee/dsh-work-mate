# WorkMate — 围绕「变更提案」的 DSH 研发流程编排插件

WorkMate 构建在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
「一切皆插件」架构上，以**变更提案（Proposal）**为核心实体，把研发全流程编排成
一条可回退、可审计的自动化链：

```
draft → proposing → reviewing → ready → implementing → merging → archiving → archived
  需求      提案分支     评审      环境就绪     实现        合并校验    归档      终态
```

- **状态机不跳步**：每一步前进都有硬前置（提案文件、分支合并、Wiki 覆盖），
  相邻回退全程可逆
- **环境自动隔离**：ready→implementing 自动创建 worktree——串行锁保护、端口段
  自动分配注入 `.env`、配置文件复制、依赖安装；归档后自动回收
- **质量门**：归档前强制交叉审查报告（proposal-auditor），未解决 CRITICAL 阻断
- **知识沉淀**：WeKnora Wiki 引用随提案登记并归档留痕；GitNexus 提供事实锚
- **寄生而非替代**：UI 优先走 DSH 原生工作台槽位——`main` 中央面板（key `workmate`）
  + `sidebar.panellist` 左栏图标，点左栏图标即把中央切成 WorkMate；同时保留
  better-sidebar 标签与两个对话入口，任一侧服务缺失都不影响另一条；
  同名面板另有 `/workmate/` 独立页供调试直连；UI 是**可选面**——任何 profile
  （含 headless / acp / sdk）里 agent 工具面都照常可用

> 前身 Helmsman（Agent 舰队指挥中心，15 插件包 monorepo）完整存档于 `main` 分支；
> 当前 `feat/workmate` 分支是按 `docs/DESIGN.md` 另起的全新实现。

---

## 目录

0. [使用说明：从装好到第一次归档（配图）](#0-使用说明从装好到第一次归档配图)
1. [环境要求](#1-环境要求)
2. [安装](#2-安装)
3. [配置](#3-配置)
4. [快速上手：一次完整提案](#4-快速上手一次完整提案)
5. [八态生命周期详解](#5-八态生命周期详解)
6. [Agent 工具参考](#6-agent-工具参考)
7. [REST API 参考](#7-rest-api-参考)
8. [质量保障机制](#8-质量保障机制)
9. [WeKnora Wiki 关联](#9-weknora-wiki-关联)
10. [可选生态插件](#10-可选生态插件)
11. [故障排查](#11-故障排查)

---

## 0. 使用说明：从装好到第一次归档（配图）

> **截图证据等级**：下面三张是**面板自身在同一台机器上的真机截图**，用
> `http://127.0.0.1:3080/workmate/?view=board|console|graph` 抓取——独立页与 DSH 内嵌面板
> 渲染的是**同一个组件**（`src/client/App.tsx`），差别只是内嵌时外面还套一层 DSH 外壳
> （左栏图标、右侧 dock 标签）。DSH 主界面本身需要 `dsh web` 打印的带 token URL，无法在
> 无头浏览器里截取，所以没有放主界面截图；需要的话在浏览器里自己截一张替换即可。
> 截图对应的数据是两个演示提案（`dl-demo` / `lc-demo`），所以数字很小，属正常。

### 0.1 先确认三件事（30 秒）

```bash
DSH=/Users/fredlee/Documents/workspace/deepseek-harness/apps/cli/lib/bin.js

# ① 插件在 profile 里（应看到 `# == workmate4dsh` 与 `id: workmate`）
node $DSH --profile web --dump-config | grep -A 2 workmate

# ② 服务在跑、接口通（应打印 200）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/workmate/api/proposals

# ③ 判断层配置生效（应看到 decisionEnabled: true / decisionSamples: 3）
node $DSH --profile web --dump-config | sed -n '/id: workmate/,/^- id:/p'
```

改过配置或升级过插件后：**重启 harness**（`pnpm dsh web`），然后**刷新页面**。
只改客户端（面板 UI）时不必重启，刷新即可。

### 0.2 第 1 步：进入面板（三个入口随便挑）

| 入口 | 位置 | 适合 |
|---|---|---|
| **左栏图标**（原生工作台） | 左栏最下方「设置」上方，WorkMate 图标；点它**中央区域**从对话切成工作台 | 日常：把 DSH 当工作台用 |
| **右侧 dock 标签** | 右侧栏的「🛠 WorkMate」标签（better-sidebar 提供） | 边聊边看提案 |
| **独立页** | `http://127.0.0.1:3080/workmate/`，可加 `?view=console` / `?view=graph` | 调试、深链、截图 |

进入后顶部有三个视图切换：**看板 / 控制台 / 知识图谱**，右侧是「＋ 新提案」。

### 0.3 第 2 步：看板视图 —— 提案都在哪

![WorkMate 看板视图](docs/images/workmate-standalone-board.png)

- 三列按阶段聚合：**提案阶段**（draft / proposing / reviewing）、**实现与合并**（ready /
  implementing / merging / archiving）、**已归档**（archived）；每列标题带数量。
- 每张卡片显示：标题、id、OpenSpec tasks 进度条、状态、最近更新；有未决人工批准时会出现
  「⏳ 等待人工批准」徽标。
- **点卡片**展开详情区（下面 0.6 会细说）：Git 关联 / worktree / 审查报告 / 决策日志 /
  卡点 / 并行任务 / 交付物，以及「推进到 X ›」「‹ 回退到 Y」按钮。
- 右上「＋ 新提案」创建：填标题即可（id 可留空自动生成），可勾选关联项目；带正文时判断层会
  顺带做一次"外部文本是否夹带指令"的判定。

### 0.4 第 3 步：控制台视图 —— 流程到底有没有用

![WorkMate 控制台视图](docs/images/workmate-standalone-console.png)

这一屏回答"这套流程值不值"，三块内容：

1. **KPI**：提案总数、返工率（有过回退的比例）、首次通过率、周期时间中位数、
   近 7/30 天归档数、agent/人 触发占比。
2. **提案过程**：每行一个提案——状态、**该状态已停留多久**、周期时间、返工次数、
   门禁失败次数、未决卡点、审批次数。
3. **控制带**：每指标一行——档位 / 当前 / 基线 / σ / 偏离 / 样本数。

> **看到「数据不足」是正常的、也是诚实的**：控制带要求至少 8 个历史样本才建基线，
> 样本不够时它明确说"数据不足"，**不会**显示成绿色的"正常"。上图四个指标都是数据不足
> （只有 2 个提案），等提案多了才会出现 `log` / `diagnose` / `propose` 档位。

对应命令：`workmate_metrics`（工具）或 `curl $API/metrics`；控制带用 `workmate_bands` 或
`curl $API/bands`。

### 0.5 第 4 步：知识图谱视图

![WorkMate 知识图谱视图](docs/images/workmate-standalone-graph.png)

按「提案 → 项目 → 提交」分层展示关联关系；点「刷新」重新扫描。

### 0.6 第 5 步：从一个想法到归档（完整 8 步）

> `$API=http://127.0.0.1:3080/workmate/api`。每一步都可以用命令、面板按钮，或直接让 agent
> 调对应工具（工具名见 §6）。

| # | 做什么 | 命令 / 工具 | 面板等价操作 |
|---|---|---|---|
| 1 | 注册项目（一次） | `POST $API/projects` | 新提案弹窗里勾选已注册项目 |
| 2 | 建提案（带来源） | `POST $API/proposals`；工具 `workmate_proposal_create`（可带 `source`/`sourceRef`/`relatesTo`/`notes`） | ＋ 新提案 |
| 3 | 写 `design.md` / `tasks.md`（tasks 里可标 `<!-- writes: src/a/** -->`） | 编辑文件 | — |
| 4 | 审查：产出 `review.md`（带严重度标签或交给判断层归级） | 技能 `workmate-proposal-audit` | 详情区「🔍 审查报告」+ 重新审查 |
| 5 | 逐态推进到 `ready` | `POST $API/proposals/<id>/advance`；工具 `workmate_proposal_archive(mode=advance)` | 「推进到 X ›」/「‹ 回退到 Y」 |
| 6 | `implementing`：自动建 worktree（端口注入 / 配置复制 / 依赖安装） | 同上 | 同上 |
| 7 | `merging` / `archiving`：**需要人工批准** | **面板点按钮**（会问批准理由） | 「推进到 merging ›」→ 再「完成归档」 |
| 8 | 归档编排：验收谓词 → 审查门 → `openspec archive` → `gitnexus analyze` → worktree 回收 → 写交付物摘要 | `POST $API/proposals/<id>/archive`；工具 `workmate_proposal_archive(mode=archive)` | 「完成归档」（审查门没过时用「强制归档（跳过审查门）」） |

第 7 步是最容易被忽略的一步：**agent 推不动 `merging`/`archiving`**（写码者不得批准），
它会报错让你去面板点。这是设计如此，不是 bug。

### 0.7 第 6 步：展开一张卡片能看到什么

点任意卡片展开，详情区自上而下可能有：

- **📦 项目**：分支名、关联提交（`[proposal:<id>]` 标记）、`git status` 摘要；
- **📋 OpenSpec**：`changes/<id>/` 状态与 tasks 完成度；
- **🔍 审查报告**：分级 tally（`CRIT 1/2` 这类计数）、审查者与 `shadow` 徽标、逐条发现；
- **🧩 并行任务**（swarm）：每个任务的 id / 状态 / 提交；
- **📦 交付物**（归档后）：标记提交数、spec 是否更新、知识图谱是否重建、漂移百分比、
  账本条目数；
- **决策日志 / 卡点**：`supersedes` 链与未决问题。

### 0.8 第 7 步：判断层（DeepSeek 冒充 Jev）会给你什么

前提：`cordis.patch.yml` 里 workmate 行已开 `decisionEnabled: true`（本机已开）。用起来会看到：

| 场景 | 你会看到 |
|---|---|
| 建提案时粘贴了工单/网页正文 | 命中注入判定 → `provenance.untrusted` 自动置位，事件流多一条 `decision` |
| agent 追加一条与旧决策矛盾的决策且没写 `supersedes` | 被拒，提示补 `supersedes=<旧 id>` |
| `workmate_assess_risk` 判为 high | 提案进 `implementing` 也要人工批准（错误信息写"高风险管理"） |
| 归档时 review.md 里有没打标签的疑问/建议 | 审查门摘要出现「判断层归级 N 条」，判为 CRIT 会真的拦住 |
| 归档时任务已勾选但 diff 不像满足它 | manifest 的 `taskJudgements` 里能看到结论（`taskJudgementGate: true` 时才阻断） |

判断是否真的跑了，看事件流（每行一条 JSON）：

```bash
tail -n 5 ~/.dsh/workmate/events.jsonl | python3 -c "
import json,sys
for line in sys.stdin:
    e = json.loads(line)
    if e.get('kind') == 'decision':
        print(e['node'], e.get('choice'), e.get('action'), 'cert=%.2f' % e.get('certainty', 0),
              e.get('provider'), 'samples=%s' % e.get('samples'), 'cached=%s' % e.get('cached'),
              'degraded=%s' % e.get('degraded'), '%dms' % e.get('latencyMs', 0))
"
```

同一道题第二次问会命中缓存：`cached=True` 且 `latencyMs` 接近 0——这是把"DeepSeek 当判官"
变得便宜的关键；`degraded=True` 说明首选 provider 没答上来，结论来自降级链。

### 0.9 快速命令：给一个已有项目生成 wiki

不需要建提案。WorkMate 把 GitNexus 的 wiki 生成能力包成了一个工具/接口，产物固定落在
`<项目>/.gitnexus/wiki/`（逐模块 markdown + 可用浏览器打开的 `index.html`）：

```bash
API=http://127.0.0.1:3080/workmate/api
ROOT=/Users/fredlee/Documents/xkw_workspace/internal-homework

# ① 先看索引新不新（只读，不会偷偷重跑重索引）
gitnexus status            # 在项目目录里跑；显示 stale 就先 analyze

# ② 生成 wiki（LLM 配置读 ~/.gitnexus/config.json；中文加 --lang chinese）
curl -s -X POST $API/wiki -H 'content-type: application/json' \
  -d "{\"projectRoot\":\"$ROOT\",\"lang\":\"chinese\"}" | python3 -m json.tool

# ③ 打开阅读器
open $ROOT/.gitnexus/wiki/index.html
```

对话里等价于工具 `workmate_wiki_generate`：

| 参数 | 作用 |
|---|---|
| `projectRoot` | 已索引仓库的绝对路径（必填） |
| `analyze: true` | 先 `gitnexus analyze` 重建索引再生成（慢，但保证 wiki 基于最新图谱） |
| `lang: "chinese"` | 输出语言；也可用配置 `gitnexusWikiLang` 固定 |
| `force: true` | 即使 GitNexus 认为已是最新也整份重生成 |
| `review: true` | 只做到模块分组就停，先人工确认结构再生成页面 |

结果里有四个字段值得看：

| 字段 | 含义 |
|---|---|
| `stale` | 索引是否落后于当前提交（只读探针的结论，不擅自替你重跑重索引） |
| `pages` | **实际写出**的模块页数（数出来的，不是声称的） |
| `complete` | `index.html` 是否存在——**缺它就是没跑完**（GitNexus 在收尾阶段才写阅读器）。CLI 报成功也可能是半份产物，此时 `note` 会写"生成中断：已写出 N 页、缺 index.html" |
| `note` | 失败/中断原因 + 下一步（如"先配 provider/key"），原文转述 CLI 输出 |

> 实测教训（2026-10-06，`internal-homework`）：一次 LLM 端点熔断中断的生成，13 个模块只写出
> 7 个（34 页）、没有 `index.html`，而命令行本身看起来"跑完了"。所以判成功请认 `complete`，
> 不要认退出信息。

> 与 `workmate_wiki_link` 的区别：后者登记的是**提案级 WeKnora 页面引用**，
> 本命令生成的是**项目级 GitNexus 仓库 wiki**，两者互补。

### 0.10 第 8 步：并行执行（swarm）

```bash
# 1) 计划：从 tasks.md 派生任务，同批内 writes 不相交
#    在 tasks.md 里写：- [ ] 2. 拆分计费模块 <!-- writes: src/billing/**, docs/billing.md -->
#    工具：workmate_swarm_plan {id, maxParallel?}
# 2) 起载体：每任务一个 worktree（.workmates/<提案>--<任务>）+ 分支 feature/<提案>--<任务>
#    工具：workmate_swarm_task {id, action: "start", taskId: "t1"}
# 3) 在任务 worktree 里干活并提交（带 [proposal:<id>] 标记）
# 4) 合回 implementation 分支（提案 worktree 内 --no-ff merge）
#    工具：workmate_swarm_task {id, action: "merge", taskId: "t1"}
```

合并冲突时插件会 `merge --abort` 回到干净态并把冲突文件交回；**裁决姿势**：在任务 worktree 里
`git merge feature/<提案>` → 解冲突 → 提交 → 重跑第 4 步。未合并的任务会挡住归档
（`force` 可跳过）。

### 0.11 常见问题速查

| 现象 | 原因 / 处理 |
|---|---|
| 点「控制台」空白 | 已修（REST 返回 `{metrics:{…}}` 包装，客户端曾按扁平解析而崩）；**硬刷新页面**即可；仍空则看浏览器控制台或内联的「过程度量加载失败：…」 |
| 提示「需要人工批准」 | 设计如此：在**面板**点「推进到 X ›」（可填理由），agent 不能自我批准 |
| 控制带显示「数据不足」 | 样本不足 8 个，不判越界；提案多了自然出档位 |
| 归档报「验收未通过：… 仍有未勾选任务」 | 把 `tasks.md` 真正做完并勾上，或让用户显式 `force` |
| 归档报「计划漂移」 | 开启 `planDriftGate` 后，改了没在 `writes`/`files` 里声明的文件；补声明或 `force` |
| 归档报「判断层归级 N 条 / CRIT 1/1 未解决」 | review.md 里那条发现被判为阻断级，修掉或勾选解决 |
| wiki 生成报"没有 LLM 配置" | 先配 GitNexus 的 provider/key：`~/.gitnexus/config.json`，或跑一次 `gitnexus wiki --provider openai --base-url <url> --model <m> --api-key <k>` 存下来 |
| wiki 内容是基于旧代码 | 先 `gitnexus analyze`（或调工具时传 `analyze: true`），结果的 `stale` 字段会告诉你索引落后 |
| 判断层好像没生效 | 重启 harness；确认 `decisionEnabled: true`；看 `decision` 事件是否 `degraded`（首选 provider 不可用会降级到规则） |

更细的排障见 §11。

---

## 1. 环境要求

| 组件 | 版本 | 必需 | 说明 |
|---|---|---|---|
| DSH 宿主 | `0.1.7-rc.2`（已验证线） | ✅ | 其它版本未验证，升级需重跑冒烟 |
| Node.js | `>= 22.19` 或 `>= 24` | ✅ | 宿主与构建同要求 |
| pnpm | `>= 10` | ✅ | 仓库与 worktree 安装均使用 |
| git | 任意近期版本 | ✅ | worktree / 分支合并检查 |
| openspec CLI | `>= 1.3.1` | ✅ | 提案工件与归档编排（`npm i -g @fission-ai/openspec`） |
| GitNexus CLI | 最新 | 可选 | `workmate_knowledge_query` 需要；目标仓库需先 `gitnexus analyze` |
| WeKnora 服务 | 自建部署 | 可选 | Wiki 关联与知识检索；未部署时自动降级 |

> **profile 覆盖**：agent 工具面只依赖 `tools`，在 headless / acp / sdk / web 任何
> profile 都可装载；面板与 `/workmate/` 独立页只在带 `webServer` 的 profile
> （`dsh-web-app`）挂载。客户端半同样零硬依赖——`dsh-better-sidebar` 缺失时只少一个
> 侧栏标签，两个对话入口照常注册。

### 1.1 跟随 DSH 升级（为什么本插件不会被"装不上"）

宿主只用 `peerDependencies` 里名字为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的范围判定
兼容性（含 prerelease），**不满足就整包跳过装载**——这是社区插件在宿主换线后集体失效的
原因。WorkMate 的 `@deepseek-ai/dsh-tools` peer 固定为 `*`，因此任何宿主版本都不会被拒；
真正的构建基准线写在 `devDependencies` + `toolchain.json`，由门禁守：

```bash
pnpm verify:host-compat   # 借宿主自己的 evaluatePluginCompatibility 判定本包 manifest
                          # + 比对 toolchain.json 基线与实装内核版本（漂移即失败）
```

运行时也不需要跟着换：宿主解析会把 linked importer 声明的 peer 指向**运行中安装的那份
内核**，所以我们执行的是宿主那份 `dsh-tools`；devDependency 只服务类型检查与测试。

宿主换线后的升级仪式（细节见 `AGENTS.md`）：对齐内核 devDependency 与 schemastery 线 →
更新 `toolchain.json` → `pnpm typecheck && pnpm test` → `pnpm verify && pnpm build` →
重装 profile 并用 `--dump-config-schema` 核验 workmate 条目 `status: schema`。

当前基线：DSH `0.2.1-alpha.1`、`dsh-tools 0.2.1-alpha.1`、
`schemastery 3.18.5-alpha.1`。

---

## 2. 安装

### 2.1 构建

```bash
git clone <本仓库> && cd dsh-Helmsman
pnpm install
pnpm build            # dist/index.js + dist/client/{app,client}.js + dist/assets/
pnpm test             # 可选：71 个单元测试
pnpm verify                                     # 四条门禁（契约 + 钉版 + 宿主兼容 + 客户端工厂求值）
pnpm verify:client                              # 在 VM 里求值 dist/client/client.js，校验装载契约与 external 白名单
```

### 2.2 方式 A：tarball 安装（推荐生产）

```bash
pnpm pack             # 生成 workmate4dsh-0.1.0.tgz
dsh plugin --profile web add ./workmate4dsh-0.1.0.tgz
```

### 2.3 方式 B：link 直连源码（推荐开发）

编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    // …其它插件
    "workmate4dsh": "link:/绝对路径/dsh-Helmsman"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "workmate4dsh"]   // 追加到 bundles 数组
    }
  }
}
```

然后：

```bash
cd ~/.dsh/profiles/web && pnpm install
pnpm dsh --profile web --dump-config | grep workmate   # 应出现 workmate 条目
pnpm dsh web                                            # 启动，默认 http://127.0.0.1:3080
```

> **link 模式注意**：改完代码必须 `pnpm build` 再重启宿主才生效。

### 2.4 验证安装

- 启动日志出现：`[workmate] tools registered …` 与 `[workmate] service ready (root: ~/.dsh/workmate)`
- 浏览器打开 `http://127.0.0.1:3080/workmate/`（独立面板页，200 即可）
- DSH 主界面右侧栏 `+` 菜单出现「🛠 WorkMate」标签

---

## 3. 配置

写在 profile 装载配置里（`cordis.patch.yml` 的 `config:` 段或 profile 编辑器），
全部可省略：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `workmateHome` | `'workmate'` | 状态目录名（`$DSH_HOME` 下，默认 `~/.dsh/workmate`）；其中 `proposals.json` 是提案聚合（原子写、损坏 fail-closed），`events.jsonl` 是只追加的过程事件流（每次状态迁移/门禁失败/控制带越界各一条；读取容错撕裂尾行）；`bands.json` 是控制带配置（缺失用内建默认，损坏 fail-closed） |
| `maxConcurrent` | `3` | swarm 并行执行上限（保留项） |
| `projectRoot` | `''` | 默认项目根；空 = 每次显式传 |
| `openspecRoot` | `'openspec'` | 目标项目内 OpenSpec 目录名（提案目录生成、状态聚合、生命周期前置校验、归档编排全链路一致） |
| `gitnexusEnabled` | `true` | GitNexus 知识查询总开关 |
| `weknoraBaseUrl` | `''` | WeKnora REST 地址（空 = 禁用知识检索） |
| `qualitySyncEnabled` | `true` | 创建提案时向目标项目同步规范资产（OpenSpec 侧） |
| `claudeAssetsEnabled` | `true` | 同时分发 Claude Code 资产（`.claude/rules`、`agents`、`hooks`、`settings.json` 合并）；DSH 侧用插件内置 skill，不需要这一组 |
| `basePort` / `portStep` | `3000` / `10` | worktree 端口段分配（每提案 `portStep` 个端口） |
| `copyFiles` | `['.env', '.env.local']` | worktree 创建时从主工作区复制的文件清单 |
| `packageManager` | `'pnpm'` | worktree 内依赖安装命令 |
| `weknoraEnabled` | `true` | WeKnora Wiki 关联流程开关 |
| `weknoraKbId` | `''` | 默认知识库 id（强制 Wiki 时必填） |
| `weknoraWikiRequired` | `false` | `true` 时实现→合并被缺失 Wiki 引用阻断 |
| `approvalsRequired` | `['merging','archiving']` | 需要**人工批准**才能进入的状态；`[]` 关闭这道门 |
| `allowAgentApproval` | `false` | `true` 时允许 agent actor 跨过受控状态（放弃"写码者不得批准"的分离） |
| `reviewBlockingSeverities` | `['CRIT']` | 归档审查门阻断哪些严重度（CRIT/HIGH/MED/LOW）；影子态报告一律只记录不阻断 |
| `planDriftGate` | `false` | `true` 时归档被"改了但没声明"的文件阻断（`force` 可跳过）；默认只记录不拦 |
| `decisionEnabled` | `false` | 判断层总开关（门禁里发起模型调用必须显式开启） |
| `decisionProvider` | `'agent'` | 判断 provider：`agent`（宿主 LLM）/ `rules`（确定性兜底）/ `jev`（占位，待 key） |
| `decisionLlmProvider` / `decisionModel` | `''` | `agent` 用的路由与模型；留空取第一个已注册路由的默认模型 |
| `decisionSamples` | `1` | 同一题采样次数；>1 时一致率作为 certainty 代理（留痕里记 samples） |
| `decisionTimeoutMs` | `4000` | 单次判断超时 |
| `decisionActThreshold` / `decisionReviewThreshold` | `0.8` / `0.6` | certainty ≥ 前者 → `act`；≥ 后者 → `review`；否则 `abstain` |
| `highRiskExtraGates` | `['implementing']` | `risk: high` 的提案在这些状态也**必须人工批准**（与 `approvalsRequired` 并集） |
| `taskJudgementGate` | `false` | `true` 时"判断层认为 diff 未满足某条已勾选任务"会阻断归档（`force` 可跳过） |
| `reviewGradeMax` | `5` | 一次归档最多让判断层给多少条未打标签的审查发现归级 |
| `decisionCacheEnabled` | `true` | 判断缓存：同题（state/选项/provider/model/采样数全等）复用上次结论，命中标记 `cached: true` |
| `decisionCacheMax` | `500` | 缓存条目上限（按时间淘汰）；文件损坏 fail-open，绝不挡住门禁 |

无效组合启动时响亮提示（如 `weknoraWikiRequired=true` 但 `weknoraKbId` 为空）。

> 配置以 **native Schemastery schema** 运行时导出（`export const Config`），宿主因此能
> 校验取值并在配置界面里渲染这些开关；写错类型会在装载时报错，而不是被静默忽略。

---

## 4. 快速上手：一次完整提案

> 以下命令中 `$API = http://127.0.0.1:3080/workmate/api`。所有操作也可以在面板
> 或对话中让 Agent 完成（见 §6 工具表）。

```bash
# ① 注册项目（一次即可，持久化在 ~/.dsh/workmate/projects.json）
curl -X POST $API/projects -H 'content-type: application/json' \
  -d '{"name":"svc-grading","root":"/abs/path/to/svc-grading"}'

# ② 创建提案（自动：生成 OpenSpec change 三件套 + 同步规范资产到项目）
curl -X POST $API/proposals -H 'content-type: application/json' \
  -d '{"id":"batch-grading-v2","title":"批量批改 v2.1","projects":["svc-grading"]}'

# ③ 推进状态（每步校验前置条件；任何一步失败都会给出可读原因）
curl -X POST $API/proposals/batch-grading-v2/advance -H 'content-type: application/json' -d '{}'
#   draft → proposing：要求 openspec/changes/<id>/proposal.md 已生成
#   proposing → reviewing：要求 proposal/<id> 分支存在
#   reviewing → ready：要求该分支已合并进 main
#   ready → implementing：自动创建 worktree（端口注入 / 配置复制 / 依赖安装）

# ④ Agent 在 worktree 内执行 tasks.md（实现 + Wiki 更新）

# ⑤ merging：声明了 wiki 的任务必须已登记 WeKnora 页面引用
curl -X POST $API/proposals/batch-grading-v2/wiki-links -H 'content-type: application/json' \
  -d '{"url":"weknora://kb/demo/wiki/grading-concurrency","pageType":"concept","version":3,"taskId":"2"}'

# ⑥ archiving → 运行归档编排（审查门 → openspec archive → gitnexus → 清理）
curl -X POST $API/proposals/batch-grading-v2/advance -H 'content-type: application/json' -d '{}'
curl -X POST $API/proposals/batch-grading-v2/archive -H 'content-type: application/json' -d '{}'
#   审查门未过（缺 review.md 或有未解决 CRITICAL）时，可只跳过审查门重跑：
curl -X POST $API/proposals/batch-grading-v2/archive -H 'content-type: application/json' -d '{"force":true}'
#   归档后：changes/archive/<日期>-<id>/ 内含 wiki.md + commits.md；worktree 已回收
```

面板操作与以上等价：卡片展开后「推进到 X ›」「‹ 回退到 Y」逐步流转（回退离开
`archived` 时会把各项目 `changes/archive/*-<id>/` 搬回 `changes/<id>/`），
「完成归档」与「强制归档（跳过审查门）」在 archiving 状态出现；卡片展开还可看
Git 关联、worktree 信息、决策日志、卡点、审查报告与 Wiki 引用。

> **人工批准门（默认开启）**：`merging` 与 `archiving` 只能由**人**进入——agent 调工具推进
> 会被拒（`force` 也绕不过），面板会问一句批准理由并写入审批记录与事件流；
> 卡片上会显示「⏳ 等待人工批准」。要恢复全自动，把 `approvalsRequired` 设为 `[]`
> （或 `allowAgentApproval: true`，但那是明确放弃"写码者不得批准"这条分离）。
> 上面的 `curl` 示例走的是 REST（actor=human），因此不受影响；`advance` / `transition`
> 都接受可选的 `{"rationale":"..."}`。

---

## 5. 八态生命周期详解

| 状态 | 进入前置（自动校验） | 此阶段做什么 | 回退 |
|---|---|---|---|
| `draft` | — | 输入需求、生成 proposal.md | — |
| `proposing` | 提案文件存在 | 创建 `proposal/<id>` 分支并提交提案 | ✅ |
| `reviewing` | 提案分支存在 | 评审（可跑 proposal-auditor）；完成后合并进 main | ✅ |
| `ready` | 提案分支已合并 main | 确认实现计划 | ✅ |
| `implementing` | （自动）worktree 已创建 | Agent 在 worktree 执行 tasks；更新 Wiki；落决策日志 | ✅ |
| `merging` | wiki 类型覆盖通过 | 实现分支合并进 main | ✅ |
| `archiving` | 实现分支已合并 main | 生成 wiki.md/commits.md，运行归档编排 | ✅ |
| `archived` | 编排全部通过 | 终态（可回退 archiving 重开，目录一并搬回） | ✅ |

- **不跳步**：`transition` 只接受相邻状态；`advance` 自动推进下一步
- **前置不过 = 400 + 可读原因**（如「等待提案分支合并进 main」），状态不变
- 无关联项目的轻量提案可推进到 ready，进入 implementing 需先关联项目

---

## 5.5 工作台面板与「控制台」视图

- **原生面板**：客户端半边在 `main` 槽注册 `key: 'workmate'`，并在 `sidebar.panellist`
  注册同名 id 的左栏图标——这是宿主自带的工作台模型（`plugins` / `schedules` /
  `mnemon` 同款）。左栏点一下，中央就从对话切成 WorkMate；better-sidebar 的 dock 标签
  仍然保留（两条路并存）。
- **三个视图**：`看板`（提案卡）/ `控制台` / `知识图谱`。
- **控制台**（跨提案只读视图）：聚合 KPI（提案数、返工率、首次通过率、周期时间中位数、
  近 7/30 天归档数、agent/人 触发占比）+ 每提案行（状态、该状态停留、周期、返工、门禁
  失败、未决卡点）+ 控制带表（指标 / 档位 / 当前 / 基线 / σ / 偏离 / 样本）。
  样本不足的指标显示「**数据不足**」而不是绿色正常——这是刻意的：薄基线不等于一切安好。

---

## 5.6 Maintain 回环：把控制带接到任何调度器

playbook 要求"检测确定性、无模型参与，越界后才叫模型"。WorkMate 给出的可调度单元是一个
**脚本**（不是宿主 schedule——DSH 的 `schedule` 服务是**会话绑定**的提醒投递，需要 sessionId
且投递的是 prompt，插件启动期没有会话可绑）：

```bash
# 只看：退出码 0=无越界 / 1=达到 --fail-on 档 / 2=调用失败
node scripts/bands-watch.mjs --fail-on propose

# 越界即回流：3σ 的那一项会开一个 metric-regression 草稿提案（走与人和 agent 相同的创建路径）
node scripts/bands-watch.mjs --fail-on propose --apply
```

接 cron（每天 09:10 检查，越界时告警）：

```cron
10 9 * * * cd /Users/fredlee/Documents/workspace/dsh-Helmsman && /usr/bin/env node scripts/bands-watch.mjs --fail-on propose >> /tmp/workmate-bands.log 2>&1
```

接 launchd（`~/Library/LaunchAgents/com.workmate.bands.plist` 里 `StartCalendarInterval` +
`ProgramArguments` 指向 `node .../scripts/bands-watch.mjs --apply`）同理。REST 侧对应
`GET /workmate/api/bands`（只读）与 `POST /workmate/api/bands {"apply":true}`（留痕 + 回流），
`workmate_bands` 工具与它们共用同一个执行器——**"工具说没事、脚本说越界"不会发生**。

---

## 5.7 并行执行（swarm）：每任务一个 worktree

提案内部的多个任务可以真并行——**每个任务一个 worktree + 独立分支**，冲突靠声明与装批避免：

```bash
# 1. 计划（从 tasks.md 派生任务，writes 声明写在行内注释里）
#    - [ ] 2. 拆分计费模块 <!-- writes: src/billing/**, docs/billing.md -->
# 工具：workmate_swarm_plan {id, maxParallel?} → 装批结果 + 冲突对 + 未声明清单
# 2. 起任务载体（worktree: .workmates/<提案>--<任务>，分支: feature/<提案>--<任务>）
# 工具：workmate_swarm_task {id, action: "start", taskId: "t1"}
# 3. 在任务 worktree 里干活、提交（记得带 [proposal:<id>]）
# 4. 合回提案的 implementation 分支（在提案 worktree 内 --no-ff merge）
# 工具：workmate_swarm_task {id, action: "merge", taskId: "t1"}
```

- **防踩踏**：同一批内任意两任务的 `writes` 不得相交（相交则分到不同批，严格串行）；未声明
  `writes` 的任务不阻塞并行，但会在计划里标出来。
- **合并冲突是裁决，不是机械操作**：冲突时插件 `merge --abort` 回到干净态、把冲突文件交给
  你，任务标 `failed`；**裁决方式**——在任务 worktree 里 `git merge feature/<提案>`，
  解完提交，再重跑 merge。
- **归档门**：存在未 `merged` 的 swarm 任务时归档编排第一步失败并列出 `[taskId] status`
  （`force` 可显式跳过）。
- 任务状态随提案记录返回，面板详情区有「🧩 并行任务」小节。
- 附带纪律：worktree 创建时会把 `.env` 与 `.workmates/` 写进仓库的
  `.git/info/exclude`（**本地文件、不进版本库**），这样 `git add -A` 不会把机器本地文件
  带进分支、也不会在合并时与载体里的未跟踪副本打架。

---

## 5.8 工件账本与计划漂移

- **声明**：`tasks.md` 行内 `<!-- writes: src/a/** -->`、`design.md` 里 `<!-- files: ... -->`
  就是"计划要动什么"。两处都没有 → 工具会说"无法判定漂移"，**不会**把所有改动都算未声明。
- **实际**：本提案 `[proposal:<id>]` 标记提交所触及的文件（`git diff-tree` 逐提交并集，
  根提交也算得出来）。提案自己的 `openspec/changes/**` 不计入——那是计划本身。
- **查询**：`workmate_plan_drift {id}` 在归档前就能看 `undeclared` / `missing` / `driftRatio`，
  来得及补声明或改实现。
- **账本**：归档成功后记录归档目录里各工件的 `sha256` + 字节数 + 覆盖提交，写进 manifest；
  面板「📦 交付物」小节显示漂移与账本条数。这让"审的是哪一版工件"可验证。
- **可选门**：`planDriftGate: true` 时存在未声明改动即归档失败并列出文件（`force` 可跳过）。
  默认关闭：`writes` 声明是新约定，历史提案没有它。

---

## 5.9 判断层：把"语义卡点"交给模型，但阈值留在我们手里

流程里有一批**高频、封闭、可验证**的判断节点（审查发现分级、决策是否语义矛盾、外部文本
是否夹带指令、变更风险等级、任务是否真的完成）。它们不适合"让 agent 自由读一遍再写段话"，
但确实需要语义判断——这正是 Jev（TypeSafe System One）那类**判断模型**的定位：给 state +
固定选项，返回选项概率，不生成文本。

**没有 TypeSafe key 也能用**：`provider: 'agent'` 用宿主自己的 `ctx.llm`，把题目**约束成
一次强制工具调用**（单一 tool、`enum` 选项）——答案只能是枚举里的一个，解析失败即视为
"答不出"，不会被当成默认选项。多采样（`decisionSamples: 3`）时一致率充当 certainty 代理，
且采样次数写进留痕，避免把"一次采样"误读成"高置信"。

**成本工程**：`agent` 每次判断都是一次真实模型调用，而判断题目高度重复（同一条发现、
同一份 diff、同一对决策会被归档重试/面板刷新反复问到）。所以判断层自带**缓存**
（`~/.dsh/workmate/decision-cache.json`，原子写 + 上限淘汰 + fail-open），命中时不再调用模型
并把 `cached: true` 写进事件——这是把"DeepSeek 当判官"变得和专用判断模型一样便宜的关键一步。

三条写死的纪律：

1. **阈值归 WorkMate**：`certainty ≥ act → act`、`≥ review → review`、否则 `abstain`——
   动作永远不由 provider 决定（与 TypeSafe 自己的纪律一致：`decision` 由调用方在代码里算）。
2. **只收紧，不放松**：判断层是**附加门**，可以把一次操作标成"需要复核/拒绝"，
   但**绝不能**放行确定性门禁本来会拦的操作。
3. **降级可见**：provider 缺失/超时/答不出 → 依次降级（`agent → rules`），仍无结论即
   `abstain`；每次判断向事件流写 `decision` 事件（node / choice / action / certainty /
   provider / samples / threshold / latency / degraded），"这次判断其实没跑成"在账本上看得见。

**四个已接入的节点**：

| 节点 | 什么时候跑 | 结论怎么用 |
|---|---|---|
| `decision-consistency` | `workmate_proposal_decide` 追加决策前 | `act` + 矛盾且无 `supersedes` → **拒绝**，要求补 `supersedes` |
| `risk-tier` | 工具 `workmate_assess_risk` | `act` 档写回 `Proposal.risk`；`risk: high` → 进 `highRiskExtraGates` 也**必须人工批准**（叠加，不替换） |
| `review-severity` | 归档审查门（每次最多 `reviewGradeMax` 条） | `act` 档把未打标签的疑问/建议合成分级发现，进分级 tally → 判为 CRIT 会真的挡住归档 |
| `injection-risk` | 创建提案时（有 notes/provenance） | `act + risky` → **自动置** `provenance.untrusted = true`（benign 绝不撤销调用方的声明） |
| `task-satisfied` | 归档时（最多 3 条已勾选任务） | 写进 manifest 的 `taskJudgements`；`taskJudgementGate: true` 时未满足即阻断 |

**语义矛盾检测**（上面第一个节点）——新决策与既有决策
矛盾且没给 `supersedes` 时，`act` 档直接拒绝并要求补 `supersedes`（原先只机械校验
"supersedes 指向的 id 存不存在"，判不出"你其实在推翻某条旧决策"）。没开判断层时行为完全不变。

> Jev 接入方式：把 `decisionProvider` 设为 `jev` 并配置 TypeSafe key 后，只需实现一个
> `DecisionProvider` 适配器（`POST https://api.typesafe.ai/v1/systemone`，`state` +
> 类型化题目 → 选项概率），调用方与门禁逻辑一行不改。

---

## 6. Agent 工具参考

Agent 会话中可直接调用（DSH 工具面注册，名字以 `workmate_` 前缀隔离）：

| 工具 | 用途 |
|---|---|
| `workmate_proposal_create` | 创建提案，联动 OpenSpec 目录与规范资产同步；可带 `source`（spec/incident/review-finding/metric-regression/maintenance）、`sourceRef`、`relatesTo`、`notes`，并把「来源 / Provenance」段写进 `proposal.md` |
| `workmate_proposal_status` | 详情聚合：Git 关联 / OpenSpec 进度 / 审查报告（按项目）+ 生命周期位置（prev/next） |
| `workmate_proposal_archive` | 生命周期驱动：`mode=advance`（默认）/ `archive`（`force` 只跳过审查门）/ 任意状态名；`exec.signal` 中断会终止正在跑的 git / openspec / gitnexus 子进程 |
| `workmate_proposal_decide` | 落决策日志（推翻必须 `supersedes`，禁止静默改口） |
| `workmate_proposal_block` | 卡点上报（卡两轮必须上报，附已尝试内容） |
| `workmate_proposal_unblock` | 答复并解除卡点 |
| `workmate_wiki_link` / `workmate_wiki_links` | 登记 / 列出 WeKnora Wiki 页面引用 |
| `workmate_knowledge_query` | GitNexus 查询（query / context / impact） |
| `workmate_knowledge_search` | WeKnora 文档检索（未配置返回禁用说明） |
| `workmate_wiki_generate` | 为已索引项目生成 GitNexus wiki（`<项目>/.gitnexus/wiki/`）；`analyze` 先重建索引、`lang` 选语言、`stale` 如实报告索引新旧 |
| `workmate_metrics` | 过程度量（由提案事件流现算）：各状态停留、周期时间、返工次数、门禁失败排行、吞吐、agent/人 归因；带 `id` 出单提案，缺省出全局 |
| `workmate_bands` | 控制带评测：每提案一个样本 + rolling 基线（均值/σ）+ 1σ log / 2σ diagnose / 3σ propose；样本不足报 `insufficient-data` 不误报。默认只读，`apply:true` 时 3σ 会开一个 `metric-regression` 草稿提案 |

**会话纪律**改为经 DSH 原生面分发（不再依赖 Claude Code 的 rules/hook）：

| 分发面 | 内容 |
|---|---|
| skill `workmate-proposal-flow` | 八态流程、工具地图、三条硬纪律（决策日志 / 卡点 / 提交标记）、归档与回退 |
| skill `workmate-proposal-audit` | 提案审查规程与 `review.md` 的机器可读形状（分级 tally、审查者头、影子期） |
| skill `workmate-archive-checklist` | 归档前验收清单：tasks 勾选纪律、`[proposal:<id>]` 标记、「完成标记 ≠ 成功证明」、交付物摘要读法 |
| skill `workmate-knowledge-usage` | GitNexus query/context/impact 的选择指南、WeKnora 边界与取证纪律 |
| systemPrompt 段落 `tool:workmate` | 一段话的流程指引，从第一轮就可见（工具描述只留"怎么做"） |

四个 skill 全部随插件以 **runtime skill** 注册（`ctx.skills.register`，fiber 卸载即注销），
**不写用户目录、也不写用户项目**——早期设计里的 `$DSH_HOME/skills/**` 文件同步已作废
（原生注册面更小、更干净，见变更 `adopt-workdsh-lessons` 的 design 修订）。
DSH 侧据此执行：提交信息带 `[proposal:<id>]`、方向性选择必须 `decide`、同一方向卡两轮
必须 `block`、代码事实先经 `workmate_knowledge_query` 核实。
若配置 `claudeAssetsEnabled: true`（默认），同一套纪律还会以 Claude Code 的
rules/agent/hook 形式分发到目标项目，供在同一个仓库里跑 Claude Code 的人使用。

---

## 7. REST API 参考

全部挂在 `/workmate/api/` 前缀（同源，无需令牌）：

| 方法 + 路径 | 用途 |
|---|---|
| `GET /proposals` | 提案列表 |
| `POST /proposals` | 创建（id 可选自动生成；projects 多选；projectRoot 可选） |
| `GET /proposals/:id?projectRoot=` | 详情（多项目 Git/OpenSpec/审查报告聚合） |
| `POST /proposals/:id/advance` | 推进到下一状态 |
| `POST /proposals/:id/transition` | 显式相邻转换 `{to}` |
| `POST /proposals/:id/archive` | 运行归档编排（仅 archiving 状态；`{force:true}` 只跳过审查门） |
| `POST /proposals/:id/decisions` | 追加决策（supersedes 校验） |
| `POST /proposals/:id/block` / `/:id/unblock` | 卡点上报 / 答复解除 |
| `POST /proposals/:id/wiki-links` | 登记 WeKnora 页面引用 |
| `GET /projects` · `POST /projects` · `DELETE /projects/:name` | 项目注册表 CRUD |
| `GET /graph?projectRoot=` | 知识图谱数据（提案↔项目↔提交） |
| `GET /metrics?id=` | 过程度量（带 `id` 出单提案，缺省出全局聚合） |
| `GET /bands?windowDays=` | 控制带评测结果（只读） |

---

## 8. 质量保障机制

- **验收谓词**：归档编排第一步检查**所有**关联项目的 `tasks.md` 是否全部勾选；
  任一项目有未完成项即失败并列出逐项目 `done/total`（`force` 可显式跳过）。
- **交付物摘要**：归档成功后提案记录写入 `archiveManifest`（逐项目：标记提交、
  `git diff --stat`、spec 是否更新、GitNexus 是否重建），面板「已归档」卡片详情区
  渲染「📦 交付物」小节。
- **审查门**：归档编排第二步检查每个关联项目的
  `openspec/changes/<id>/review.md`——缺失或存在未勾选的 CRITICAL 条目即失败
  （step 列出原因，`force` 可只跳过这一道门）；报告由 skill `workmate-proposal-audit`
  描述的规程生成
- **决策日志**：`supersedes` 链显式化推翻；审查时比对链一致性与 GitNexus 事实
- **卡点上报**：open 卡点面板红色置顶，答复后归档留痕
- **验收谓词**：归档编排校验 tasks.md 全部勾选（`force` 不跳过这一步）

资产分发在创建提案时进行，已存在的文件**永不覆盖**，分两组：

| 组 | 内容 | 受谁控制 | 适用面 |
|---|---|---|---|
| OpenSpec | `openspec/config.yaml`、`workmate-review` schema 与模板 | `qualitySyncEnabled`（默认 true） | 审查门依赖它，DSH 与 Claude Code 共用 |
| Claude Code | `.claude/rules`、`.claude/agents`、`.claude/hooks` + `settings.json` hook 合并 | `claudeAssetsEnabled`（默认 true） | **只在 Claude Code 里生效**（或宿主装了第一方 `@deepseek-ai/dsh-hooks-claude-code` 桥）；DSH 侧对应能力由内置 skill 提供 |

---

## 9. WeKnora Wiki 关联

- tasks.md 任务声明：`- [ ] 2.3 实现并发控制 <!-- wiki: true; type: technical -->`
- 类型覆盖：`technical` → 页面类型 `concept|synthesis`；`business` → `entity|concept`
- 归档留痕：`wiki.md` 按技术方案/业务规则分组列出全部引用（URL/PageType/版本）
- 依赖：`dsh plugin --profile web add @wxg-prc-cpg/dsh-weknora`（npm 已核实，
  0.1.0）并配置 `WEKNORA_BASE_URL` / `WEKNORA_KNOWLEDGE_BASE_IDS` 环境变量；
  未安装/未配置时流程自动降级（`weknoraWikiRequired=false` 不阻断）

---

## 10. 可选生态插件

| 插件 | 用途 | 状态 |
|---|---|---|
| `@wxg-prc-cpg/dsh-weknora` | WeKnora 检索工具（wiki/知识检索） | npm 已核实；安装即用 |
| `dsh-swarm-orchestrator` | tasks 并行执行（worktree 编排已预留接口） | 待接入，启用后单独提案 |
| `@hucj/dsh-file-mention` | 输入框 @文件 快捷指令 | 待安装 |

---

## 11. 故障排查

| 现象 | 处置 |
|---|---|
| 启动日志无 `[workmate]` | 检查 profile bundles 是否含 `workmate4dsh`、`pnpm install` 是否跑过 |
| 提案卡在 ready 无法推进 | 未关联项目（implementing 需要 worktree）——面板关联项目 |
| merging 报「Wiki 关联未完成」 | 按 step 列出的缺失类型登记 `workmate_wiki_link`，或确认任务不需要 wiki 后去掉声明 |
| 归档报「审查报告缺失」 | 会话中运行 proposal-auditor 生成 review.md；勾掉全部 CRITICAL |
| 归档报「already archived in a previous run」 | 上次部分成功的幂等跳过，不是错误 |
| worktree remove 被拒 | feature 分支未合并进 main；先合并或显式 force |
| 面板按钮不可点 / 控制台报 slot 错误 | 检查 profile 内社区插件版本是否匹配宿主（过时插件会炸 client 初始化链） |
| 记忆/知识面板不可用 | 对应社区插件（如 dsh-mnemon）需升级到支持当前宿主的版本 |

---

## 仓库布局与开发

```
src/
├── index.ts                 # 插件入口（工具注册 / webServer 挂载 / 服务提供）
├── config.ts                # 配置（§3 全部项）
├── features/
│   ├── proposal/            # 状态机、提案存储（原子写）、Git 关联、状态聚合
│   ├── archive/             # 生命周期集成层 + 归档编排（审查门/swarm/openspec/gitnexus）
│   ├── worktree/            # 端口分配器 + worktree 生命周期管理
│   ├── wiki/                # WeKnora 引用登记与归档渲染
│   ├── knowledge-bridge/    # GitNexus CLI 桥接 + WeKnora HTTP 客户端
│   ├── quality/             # 规范资产同步 + review.md 解析
│   └── project/             # 项目注册表
├── client/                  # 面板 SPA + 原生工作台面板/左栏图标 + better-sidebar tab + 对话入口
└── assets/quality/          # 分发到目标项目的 OpenSpec/Claude 规范资产
```

开发命令与贡献规范见 `AGENTS.md`；架构与决策记录见 `docs/DESIGN.md`；
DSH 宿主契约见 `docs/DSH-INTEGRATION-NOTES.md`。

## License

MIT
