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
- **寄生而非替代**：UI 注入 DSH 原生界面（右侧栏标签 + 对话入口），不另起 Web 应用

> 前身 Helmsman（Agent 舰队指挥中心，15 插件包 monorepo）完整存档于 `main` 分支；
> 当前 `feat/workmate` 分支是按 `docs/DESIGN.md` 另起的全新实现。

---

## 目录

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

---

## 2. 安装

### 2.1 构建

```bash
git clone <本仓库> && cd dsh-Helmsman
pnpm install
pnpm build            # dist/index.js + dist/client/{app,client}.js + dist/assets/
pnpm test             # 可选：71 个单元测试
pnpm verify:contract && pnpm verify:toolchain   # 契约与版本门禁
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
| `workmateHome` | `'workmate'` | 状态目录名（`$DSH_HOME` 下，默认 `~/.dsh/workmate`） |
| `maxConcurrent` | `3` | swarm 并行执行上限（保留项） |
| `projectRoot` | `''` | 默认项目根；空 = 每次显式传 |
| `openspecRoot` | `'openspec'` | 目标项目内 OpenSpec 目录名 |
| `gitnexusEnabled` | `true` | GitNexus 知识查询总开关 |
| `weknoraBaseUrl` | `''` | WeKnora REST 地址（空 = 禁用知识检索） |
| `qualitySyncEnabled` | `true` | 创建提案时向目标项目同步规范资产 |
| `basePort` / `portStep` | `3000` / `10` | worktree 端口段分配（每提案 `portStep` 个端口） |
| `copyFiles` | `['.env', '.env.local']` | worktree 创建时从主工作区复制的文件清单 |
| `packageManager` | `'pnpm'` | worktree 内依赖安装命令 |
| `weknoraEnabled` | `true` | WeKnora Wiki 关联流程开关 |
| `weknoraKbId` | `''` | 默认知识库 id（强制 Wiki 时必填） |
| `weknoraWikiRequired` | `false` | `true` 时实现→合并被缺失 Wiki 引用阻断 |

无效组合启动时响亮提示（如 `weknoraWikiRequired=true` 但 `weknoraKbId` 为空）。

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
#   归档后：changes/archive/<日期>-<id>/ 内含 wiki.md + commits.md；worktree 已回收
```

面板操作与以上等价：卡片「推进 →」按钮逐步前进，「完成归档」在 archiving 状态
出现；卡片展开可看 Git 关联、worktree 信息、决策日志、卡点、审查报告与 Wiki 引用。

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
| `archived` | 编排全部通过 | 终态（可回退 archiving 重开） | ✅ |

- **不跳步**：`transition` 只接受相邻状态；`advance` 自动推进下一步
- **前置不过 = 400 + 可读原因**（如「等待提案分支合并进 main」），状态不变
- 无关联项目的轻量提案可推进到 ready，进入 implementing 需先关联项目

---

## 6. Agent 工具参考

Agent 会话中可直接调用（DSH 工具面注册，名字以 `workmate_` 前缀隔离）：

| 工具 | 用途 |
|---|---|
| `workmate_proposal_create` | 创建提案，联动 OpenSpec 目录与规范资产同步 |
| `workmate_proposal_status` | 详情聚合：Git 关联 / OpenSpec 进度 / 审查报告（按项目） |
| `workmate_proposal_archive` | 生命周期驱动：`mode=advance`（默认）/ `archive` / 任意状态名 |
| `workmate_proposal_decide` | 落决策日志（推翻必须 `supersedes`，禁止静默改口） |
| `workmate_proposal_block` | 卡点上报（卡两轮必须上报，附已尝试内容） |
| `workmate_proposal_unblock` | 答复并解除卡点 |
| `workmate_wiki_link` / `workmate_wiki_links` | 登记 / 列出 WeKnora Wiki 页面引用 |
| `workmate_knowledge_query` | GitNexus 查询（query / context / impact） |
| `workmate_knowledge_search` | WeKnora 文档检索（未配置返回禁用说明） |

**会话纪律**（由同步到目标项目的 rules 注入）：提交信息必须携带
`[proposal:<id>]`（PreToolUse hook 强制）；方向性选择必须 `decide`；卡两轮必须
`block`；调研类问题 fork 子代理；GitNexus 先查后写。

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
| `POST /proposals/:id/archive` | 运行归档编排（仅 archiving 状态） |
| `POST /proposals/:id/decisions` | 追加决策（supersedes 校验） |
| `POST /proposals/:id/block` / `/:id/unblock` | 卡点上报 / 答复解除 |
| `POST /proposals/:id/wiki-links` | 登记 WeKnora 页面引用 |
| `GET /projects` · `POST /projects` · `DELETE /projects/:name` | 项目注册表 CRUD |
| `GET /graph?projectRoot=` | 知识图谱数据（提案↔项目↔提交） |

---

## 8. 质量保障机制

- **审查门**：归档编排第一步检查每个关联项目的
  `openspec/changes/<id>/review.md`——缺失或存在未勾选的 CRITICAL 条目即失败
  （step 列出原因）；`proposal-auditor` subagent 生成该报告
- **决策日志**：`supersedes` 链显式化推翻；auditor 比对链一致性与 GitNexus 事实
- **卡点上报**：open 卡点面板红色置顶，答复后归档留痕
- **验收谓词**：归档编排校验 tasks.md 全部勾选（`force` 可跳过）
- **提交标记 hook**：目标项目 `.claude/settings.json` 的 PreToolUse hook 拦截
  无 `[proposal:<id>]` 的提交

规范资产（OpenSpec 硬约束、workmate-review schema、rules/agents/hooks）在创建
提案时自动同步到目标项目——已存在的文件**永不覆盖**。

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
├── client/                  # 面板 SPA + better-sidebar tab + 对话入口
└── assets/quality/          # 分发到目标项目的 OpenSpec/Claude 规范资产
```

开发命令与贡献规范见 `AGENTS.md`；架构与决策记录见 `docs/DESIGN.md`；
DSH 宿主契约见 `docs/DSH-INTEGRATION-NOTES.md`。

## License

MIT
