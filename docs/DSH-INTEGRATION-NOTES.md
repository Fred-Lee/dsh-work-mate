# DSH 宿主集成要点（WorkMate 内部参考）

WorkMate 运行在 DSH 宿主内部，与宿主的交互面散落在若干隐式约定里：有的来自 Helmsman
时期的踩坑，有的来自其它 DSH 项目的一手经验。本文把这些**契约点**集中记录，避免每做
一个新面板就重新逆向一次。

## 来源与证据等级

内容有两个来源，每条都标注证据等级，**不要**把 B 级当成已验证事实使用：

| 等级 | 含义 |
|---|---|
| **A 实测** | 在本机 `0.1.2-alpha.5` harness 上真实跑过，命令与结果见下 |
| **B 借鉴** | 取自 [DSH-Work-Buddy](https://github.com/Fred-Lee/DSH-Work-Buddy)（MIT，v0.1.998）的源码/注释，**尚未**在 Helmsman 侧验证 |
| **C 源码** | 读本机 harness 源码得到 |

---

## A. 已验证：Origin 围栏（任何代理 DSH 的同源网关都必须处理）

DSH 的 HTTP 入口在**认证之前**先做 Origin 校验：请求若携带 `Origin` 头且不是 DSH 自身的
host，直接 403；请求**不带** `Origin`（服务端到服务端）则跳过围栏，转而要求令牌。实测矩阵：

```bash
curl -X POST http://127.0.0.1:3080/api/host.describe \
  -H 'content-type: application/json' \
  -H "Origin: <下表的 origin>" \
  -d '{"type":"client-request","rpcId":"p1","method":"host.describe","payload":{}}'
```

| Origin | 结果 |
|---|---|
| 不带 Origin 头 | `401 unauthorized`（过围栏，缺令牌） |
| `http://127.0.0.1:3080`（DSH 自身） | `401 unauthorized`（过围栏，缺令牌） |
| `http://127.0.0.1:8765`（外来端口） | **`403 forbidden`** |
| `http://evil.example.com`（外来域） | **`403 forbidden`** |

**落地含义**：如果将来 Helmsman 的某个面板要把 DSH 反代到另一个源（另一个端口/域名），
必须在转发时把 `Origin`（以及 `Referer`）改写为 DSH 自身地址，否则浏览器里所有 DSH API
调用都会 403；服务端到服务端调用则不受影响，但需要令牌。这也解释了为什么 Helmsman 现在
的 UI 直接挂载在 DSH 的 `webServer` 上（同源）是成本最低、最不容易出错的选择。

> 注：`/helmsman-*/api/*` 这些**插件路由**在 loopback 上不需要令牌（见 `docs/SECURITY-AUDIT.md`
> §1.6 的信任边界声明），与 DSH 自身的 `/api/*` 不同。

---

## A. 已验证：插件 bundle 声明与 profile 装载

一个包要能被 `dsh.profile.bundles` 引用，**必须**在自己 `package.json` 里声明 bundle 补丁，
否则 profile 装载直接抛错、harness 起不来：

```jsonc
// packages/<pkg>/package.json
"files": ["dist", "cordis.patch.yml", "README.md"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```yaml
# packages/<pkg>/cordis.patch.yml
# @helmsman/<pkg> bundle layer
- insert:
    - id: helmsman-<pkg>
      name: '@helmsman/<pkg>'
```

实测报错（缺声明时）：

```
Error: dsh: profile bundle "@helmsman/artifacts" declares no dsh.bundle in its package.json
    at loadProfile (.../packages/boot/app-boot/src/profile.ts:834)
```

**注意**：单元测试抓不到这类缺陷——只有真装进 profile 才会暴露。新增插件后务必跑一次
`dsh web` 冒烟，或至少检查 `dsh.bundle` 与 `cordis.patch.yml` 是否齐备。

---

## A. 已验证：Profile 的 link 安装方式

`~/.dsh/profiles/web/package.json` 用 `link:` 直连 Helmsman 源码目录，因此**改完代码必须
重新 `pnpm build` 再重启 harness** 才生效（`import.meta.url` 指向 `dist/`）。新增包要同时
写进两处：`dependencies`（`link:` 指向 `packages/<pkg>`）与 `dsh.profile.bundles`
（按装载顺序，artifacts 在 knowledge-tolaria 之后、orchestrator 之前）。改完跑
`pnpm install` 建链。

---

## A. 已验证：Agent preset 的用户级插入点

DSH 的 agent preset 发现会扫描 `<DSH_HOME>/.agent-presets`（默认 `~/.dsh/.agent-presets`）
作为**可写的用户根**，每个 preset 是一个目录：

```
~/.dsh/.agent-presets/<preset-id>/
├── agent.cordis.yml
└── preset.yml
```

这是 Helmsman `@helmsman/presets` 已经在用的机制，也是 WorkBuddy 唯一触及的 DSH 原生扩展点
（它把自己的「通用兼容模式」写进同一目录）。**关键约定**：该目录是用户可编辑的作者根，写入
必须**永不覆盖**已存在的 preset——`packages/presets/src/install.ts` 只在目录缺失、
或目录存在但缺 `agent.cordis.yml` 时补齐，其余情况跳过。因此启动日志出现
`synced 0 preset dirs` 是**正确的幂等行为**，不是失败。

---

## A. 已验证：变更集在真机上的行为

在 `0.1.2-alpha.5` + `web` profile 上实测通过（13 个 Helmsman 插件全部装载、0 error）：

- **持久化历史 + SSE**：任务完成后时间线含 7 条事件、`seq` 单调；`after=5` 精确返回 `[6,7]`；
  SSE 先发 `: connected` 再按 cursor 重放；**harness 重启后任务仍在**（`COMPLETED`）。
- **审批门控**：无令牌合并 → `gate-denied ... (missing-token)`；request→decide 拿到一次性令牌 →
  合并 200；**同一令牌复用 → `gate-denied ... (unknown-token)`**。
- **审计**：`run-completion outcome=completed`（由真实终态派生）；`decision` 记录区分
  `stage=decide`（人工批准）与 `stage=enforce`，`source=ui`。
- **产物交付**：topology 导出经注册表下载为 `application/yaml` + RFC 5987 中文文件名；
  任务包登记 `.bundle.patch` / `.bundle.json`；**同内容重复登记命中 `duplicate: true`**。

---

## B. 借鉴：会话/工作区绑定序列（**Helmsman 未采用该路径**）

WorkBuddy 的 `ensureHarnessSession` 把"任务 ↔ agent 工作区"绑定成了一条固定序列。Helmsman 的
任务工作项模型若要关联对话/工作区，可直接采用同一顺序：

1. `prepare-session` —— 先把该任务目录的 `AGENTS.md` / `MEMORY.md` 写好、套上人格；
2. `workspace.create({ path: task.dir })` —— **幂等**，把任务目录登记为 agent 的 cwd；
3. `session.create({ workspaceId })` —— 建会话；
4. 绑定并快照 —— 把 `{ sessionId, v: 1 }` 落盘到任务记录，供重启后恢复。

配套的产品化做法（同样是 B 级）：每任务一个目录、per-task `AGENTS.md`/`MEMORY.md` 合成、
人格（`agentTemplate`）与长期记忆同步到 `data/agents/<tplId>/MEMORY.md`、归档时落
`manifest.json`（含 tokens / sizeBytes / fileCount / conversation 转录）。

> **采用情况（2026-09-19 实测核对的结论）**：上述标识符
> （`prepare-session` / `workspace.create` / `session.create` / `workspaceId` / `agentTemplate`）
> 在 `packages/*/src` 里**全部 0 处命中** —— Helmsman 既没有走这条序列，也没有引入其 API。
> 它自足地实现了等价物：`helmsman.worktree` 管 worktree、`helmsman.board` 的关联集存
> `{ type, refId, label, at }`、会话读取走 `ctx.get('sessionQuery')`。
>
> **因此本条目按「参考对照」保留，不再作为待验证的落地项。** 唯一被真机验证的是**它想解决的
> 那个问题**（关联在宿主重启后可解析），验证方式与结果见 `docs/TASK-MODEL.md` §10。

---

## B. 借鉴：HTTP RPC 信封与事件流契约（部分条目已更正/降级）

- **RPC 信封**：`POST /api/<method>`，body `{ type: 'client-request', rpcId, method, payload }`，
  响应 `env.result.ok` / `env.result.value` / `env.result.error.message`。
  （本机实测时**未**走通带令牌的成功路径，因此标为 B 级。）
  **2026-09-19 复核**：信封形状在宿主源码中得到确认
  （`packages/api/gateway/tests/gateway.host.spec.ts:1199` 的 `type: 'client-request'`），
  但带鉴权的成功路径**仍未走通**（`/api/*` 返回 401；从 URL 取到的 `?token=` 以 query 传入无效，
  实际机制未查明）—— **维持 B 级**，且不宣称其可用。

- **事件流**：单一 WebSocket，**下行专用**；审批/提问回执走 `POST /api/respond`。
  **⚠️ 路径已更正**：原文记的 `/api/events.mux` 是**旧版**的浏览器下行载体
  （宿主 `2026-08-04` 架构笔记描述的状态）。现行宿主（`0.1.2-alpha.5`）已改为单一
  WebSocket **`/api/remote.mux`**，host 流降级为它内部的 logical endpoint `$events`
  （宿主 `2026-08-10` / `2026-08-18` 两篇 `implemented/` 笔记）。
  证据（强于 live 探测）：`events.mux` 在宿主全仓 **含 `lib/` 编译产物在内零命中**；
  而 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'` 同时出现在
  `packages/api/gateway/src/stream-protocol.ts:6` 与编译产物 `lib/client.js:60` / `lib/index.js:11`。
  帧类型（`session/event`、`session/queue`、`approval/requested|resolved`、
  `question/requested|resolved`、`stream/error`）与 `session/event` 的 chunk 类型
  （`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`）
  **未在现行宿主上复验**，随路径一并视为待更新。

- **易错点**：斜杠命令必须走 `commands/execute`，用 `session.prompt` 发 `/xxx` 文本**不会**
  触发命令，会被当普通消息送进模型。
  **2026-09-19 复核**：`commands/execute` 在宿主源码中存在且签名明确
  （`packages/interaction/commands/lib/typert.remote-client.d.ts:16`：
  `(agentId, line, images, signal?) => Promise<RemoteResult<CommandExecution | undefined>>`）。
  该「易错点」的**行为差异未实测**（需要可用的带鉴权 RPC 通道）。

---

## C. 源码：其它已确认的点

- `~/.dsh/settings.yaml`、`~/.dsh/.credentials.yaml` 是模型与凭证的唯一合法存储位置（项目树外）。
- 项目级技能扫描根：`<项目根>/.dsh/skills/<name>/SKILL.md`。
- 本机 harness 版本 `0.1.2-alpha.5`，cordis `4.0.2`；`@deepseek-ai/dsh-tools` 必须钉在同版本
  （见 `toolchain.json` 与 `docs/COMPATIBILITY.md`）。
- 对照：WorkBuddy 内置的 harness 是 **`0.1.0-rc.7`（cordis 4.0.1）**，与 Helmsman 的目标版本
  不在同一条发布线上，其 `dsh-tools` 不满足 Helmsman 的 `cordis ^4.0.2` peer 约束，
  **不能**用那份内置 harness 跑 Helmsman 的冒烟。

---

## 参考

- 本机 harness：`/Users/fredlee/Documents/workspace/deepseek-harness`（`0.1.2-alpha.5`）
- 借鉴来源：`DSH-Work-Buddy` v0.1.998（MIT，liuda1999）——`WorkBuddy-Web/server.js` 的
  `harnessRpc` / Origin 改写 / `ensureHarnessSession`，`AGENTS.md` 的交互契约段
- 相关规格：`openspec/specs/` 下 `execution-history`、`execution-streaming`、
  `approval-gates`、`audit-trail`、`artifact-delivery`
