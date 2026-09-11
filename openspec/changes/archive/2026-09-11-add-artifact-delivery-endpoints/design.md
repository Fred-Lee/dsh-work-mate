## 背景(Context)

Helmsman 的交付物目前只从定制路径漏出:草稿是 `~/.helmsman/workbench/drafts/` 下的纯 `.md`/`.json`(由 `packages/ui-workbench/src/generator.ts` 写入);归档笔记是 vault markdown 文件(`~/.helmsman/vault`,经 `helmsman.knowledge.archive` 写入);仪表盘唯一的下载是 `packages/ui-dashboard/src/api.ts` 的 `GET api/topology/export`,它发 `content-disposition: attachment`,却把 YAML 响应体误标为 `.json`。草稿与归档笔记没有任何下载途径,多 agent 任务的 diff 也只能靠提交进基础仓库来消费。参考模式:MOVO 把生成内容经存储层(本地文件系统或 OSS)交付,带注册表、端点下载与权威交付去重。本变更以文件系统规模采纳这一形态。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- 一个内容寻址产物注册表位于 `~/.helmsman/artifacts/`,Helmsman 自产的每类交付物(草稿、归档笔记、topology 导出、任务包)都流经它。
- 在既有 loopback web 宿主上提供正确下载端点(真实文件名 + MIME、CJK 安全)。
- 任务结果打包成可下载的补丁包 + 伴生 JSON,不引入归档(zip)依赖。
- 按内容哈希去重;零新增运行时依赖。

**非目标:**
- 生成 docx/pptx/xlsx/pdf(仍属 DSH 文档技能——Helmsman 只交付它已产出的)。
- 现在接对象存储(OSS/S3)——存储是可替换接口,先有本地实现(对齐 MOVO local-vs-oss 拆分,日后采纳)。
- 删除/清理产物(内容寻址 blob 暂时只增不改)。
- 流式传输数百 MB 级产物(注册时拒绝超大负载)。

## 决策(Decisions)

### D1. 新服务包 `@helmsman/artifacts` 拥有注册表
纯 Service cordis 插件,暴露 `helmsman.artifacts`:`register({type, fileName, bytes, meta}) → {id, duplicate}`、`resolve(id) → {meta, bytes}`、`list()`。状态位于 `~/.helmsman/artifacts/blobs/<sha256>` + `manifest.json`(tmp+rename 原子重写,沿用 `commands.json` 的做法)。ui-dashboard 与 ui-workbench 经 `ctx.get` 懒获取,缺失时优雅降级。

- **理由**:三个包(仪表盘、工作台、归档流程)需要一个共享存储;把纯 FS 模块放进其中任何一个都会在兄弟插件间造成运行时代码依赖,这正是 monorepo 刻意避免的。第 13 个纯 Service 包符合既有 `memory-topology` 模式,保持各包独立打包,也让注册表成为真实契约而非复制粘贴。
- **考虑过的替代**:把存储放进 ui-workbench、仪表盘跨宿主用文件系统访问(破坏插件边界 + 重复 REST);或在两个宿主各复制一份小模块(漂移风险)。均否决。

### D2. 内容寻址 = 身份,也是去重机制
产物 id = 字节的 sha256 hex;`register` 先查 `blobs/<hash>` 是否存在,存在则返回既有 id 与 `duplicate: true` 标记(默认保留首次注册的元数据,除非调用方传 `keepMeta: false`)。

- **理由**:MOVO 的"权威交付去重"(再导出相同内容不重复劳动)正是 Helmsman 对"重新生成的草稿、重复请求的包"想要的行为;内容寻址使它成为结构性保证,而不是靠一套查找约定。

### D3. 任务包 = 纯文本补丁包 + 伴生 JSON(无归档依赖)
打包由仪表盘宿主编排(它已持有 `orchestrator` + `worktree`):收集各 agent 在 worktree 服务中的补丁,再注册两个产物——`<taskId>.bundle.patch`(带 agent/文件分隔符与任务头的统一 diff 拼接)与 `<taskId>.bundle.json`(agents、基础 sha、各 agent 文件、状态)。两者与其他产物一样内容寻址。

- **理由**:`.zip` 需要归档库——第一个真实运行时依赖。拼接的统一补丁文件正是 `git apply` 逐文件消费的格式,人可读、可 diff,伴生 JSON 保证机器可用。MOVO 的文件交付更丰富,但我们复制的核心是它的*保证*(稳定 id、重复请求不复制)。

### D4. 下载头集中处理且 CJK 安全
一个 `content-disposition` 助手(放在 artifacts 包内,宿主复用):`Content-Disposition: attachment; filename="<ascii 回退>"; filename*=UTF-8''<percent-encoded>`,外加小型 MIME 表(`.md → text/markdown`、`.json → application/json`、`.patch/.diff → text/plain`、`.yaml/.yml → application/yaml`、`.txt → text/plain`)。topology 导出路径改为"先注册 YAML、再经产物端点提供",顺带修正 `.json` 误标。

- **理由**:Helmsman 的草稿与笔记常为中文命名;原始非 ASCII 文件名放进 `Content-Disposition` 会弄坏客户端,所以 RFC 5987 的 `filename*` 是必需而非可选。

### D5. 生产者负责注册,宿主负责呈现
- ui-workbench:草稿生成/保存后、归档流程(调用 `helmsman.knowledge.archive`)成功后,由宿主注册字节,并把产物 id 显示在草稿/笔记旁边。
- knowledge-tolaria 保持不动:归档是它的唯一职责;注册发生在 ui-workbench 已编排的"草稿→归档"流程里。
- ui-dashboard:新增产物标签页(列表 + 下载)与已完成任务的"下载产物包";topology 导出先注册再提供。

## 风险 / 取舍(Risks / Trade-offs)

- [清单是单份 JSON 文件的重写] → 写入为 tmp+rename 原子操作且低频(产生时注册,而非每个流事件);启动时解析失败则通过哈希 `blobs/` 重建清单。
- [相同内容不同生产者时的元数据歧义] → 注册表保留首次元数据 + 生产者数组;新生产者追加进列表。
- [blob 只增不减] → 单用户规模下目前可接受;清理/GC 任务超范围,留待未来变更(内容寻址使清单条目删除后的 GC 安全)。
- [大产物下载占内存] → `register` 拒绝 > 50 MB 并给清晰错误;典型草稿/diff 是 KB 级。

## 迁移计划(Migration Plan)

先加 artifacts 服务包与 bundle 插入,再逐个迁移生产者(草稿 → 归档笔记 → topology 导出 → 任务包);每步独立且增量。旧草稿/commands 文件布局不动(注册时引用的是同一底层字节)。回滚 = 移除端点 + bundle 条目;blob 无害残留。

## 开放问题(Open Questions)

- artifacts 入口放工作台抽屉、仪表盘、还是两者——按 D5 放两者:抽屉成为"My deliverables"的家,仪表盘在与合并结果同处保留"下载产物包"动作。
