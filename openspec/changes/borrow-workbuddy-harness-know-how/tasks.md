## 1. 参考文档

- [x] 1.1 新建 `docs/DSH-INTEGRATION-NOTES.md`：证据分级说明（A 实测 / B 借鉴 / C 源码）+ 来源与版本标注
- [x] 1.2 写入 **A 级** 条目：Origin 围栏实测矩阵（不带/自身/外来端口/外来域 → 401/401/403/403）与可复现命令
- [x] 1.3 写入 **A 级** 条目：插件 bundle 声明要求（`dsh.bundle.patch` + `cordis.patch.yml`）与缺声明时的装载报错全文
- [x] 1.4 写入 **A 级** 条目：profile 的 `link:` 安装方式、双处登记（deps + bundles）、改码后必须重建重启
- [x] 1.5 写入 **A 级** 条目：agent preset 用户级插入点 `~/.dsh/.agent-presets/<id>/` 与"永不覆盖"约定（含 `synced 0` 是幂等而非失败）
- [x] 1.6 写入 **A 级** 条目：真机行为清单（历史/SSE/重启存活、门控三态、审计 stage/source、产物下载头与去重）
- [x] 1.7 写入 **B 级** 条目：会话/工作区绑定序列、per-task 目录当 cwd、per-task AGENTS/MEMORY、归档 manifest 形状
- [x] 1.8 写入 **B 级** 条目：HTTP RPC 信封、`events.mux` 帧与 chunk 类型、`commands/execute` 与 `session.prompt` 的区别（注明未走通成功路径）
- [x] 1.9 写入 **C 级** 条目与结论：凭证/settings 位置、项目级技能扫描根、本机 harness 版本，以及"WorkBuddy 内置 rc.7 harness 不可用作冒烟环境"的依据

## 2. 集成缺陷修复（真机冒烟暴露）

- [x] 2.1 新建 `packages/artifacts/cordis.patch.yml`（`insert: helmsman-artifacts`）
- [x] 2.2 `packages/artifacts/package.json` 补 `dsh.bundle.patch` 并把补丁与 README 加入 `files`
- [x] 2.3 新建 `packages/artifacts/README.md`（同门包均有，`files` 已引用）
- [x] 2.4 全仓扫描确认 14 个包声明齐备（唯 artifacts 缺失，已修）
- [x] 2.5 用户 profile 增补 `@helmsman/artifacts`（deps 的 `link:` + `dsh.profile.bundles`，位置按装载顺序置于 knowledge-tolaria 之后）并 `pnpm install` 建链

## 3. 真机冒烟（本次已执行并记录证据）

- [x] 3.1 启动 `dsh web`：13 个 Helmsman 插件全部 ready、日志 0 error
- [x] 3.2 历史 + SSE：跑一个真实任务，核对时间线 `seq` 单调、`after=` 游标精确、SSE 先连接注释再重放；重启后任务仍在
- [x] 3.3 门控：无令牌合并被拒 / 批准后带令牌成功 / 令牌复用被拒（`missing-token` → 200 → `unknown-token`）
- [x] 3.4 审计：核对 `run-completion` 的 outcome 派生、`decision` 的 `stage=decide|enforce` 与 `source=ui`
- [x] 3.5 产物：topology 导出经注册表下载为 `application/yaml` + RFC 5987 中文名；任务包登记 patch+json；同内容 `duplicate: true`

## 4. 冒烟暴露的缺陷修复（bundle 去重）

- [x] 4.1 定位根因：bundle manifest 用 `new Date().toISOString()` 把生成时刻写进内容（并流入 `.patch` 头部），每次请求字节不同 → 内容寻址去重失效
- [x] 4.2 修复：改用任务自身稳定时间戳（`task.createdAt` / `endedAt`），使 bundle 内容成为任务状态的纯函数
- [x] 4.3 补齐 dashboard 缺失的 artifact/bundle/topology-export 路由测试（原 task 3.4 声称完成但实际无测试），含去重回归断言
- [x] 4.4 真机复验：连续三次请求 bundle，第 2、3 次命中 `duplicate: true` 且 id 相同

## 5. 收尾

- [ ] 5.1 把 B 级条目在 `add-task-workitem-model` 落地时逐条验证并升级为 A 级（已作为该变更的设计输入登记）
- [x] 5.2 清理本次冒烟残留（临时仓库、smoke 任务记录、worktree、产物库、审计日志；`~/.helmsman` 其余既有数据未触碰）

## 6. 静态检查防复发（测试盲区固化）

- [x] 6.1 在 `scripts/check-toolchain.mjs --structural` 增加检查：每个 `@helmsman/*` 包必须声明 `dsh.bundle.patch`
- [x] 6.2 同检查覆盖两点衍生缺陷：声明的补丁文件不存在、`files[]` 未包含补丁（打包会丢 bundle 层）
- [x] 6.3 补 3 个测试用例（缺声明失败、files 漏项失败、声明齐备通过），`node --test` 15/15 通过
- [x] 6.4 负向验证：临时删掉 `packages/artifacts` 的 `dsh` 字段，检查以精确信息 MISMATCH；恢复后 OK
