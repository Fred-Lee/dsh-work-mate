## 1. `@helmsman/artifacts` 服务包

- [x] 1.1 搭建 `packages/artifacts`(名称、插件入口、`OrchestratorService` 风格类型),在 `src/index.ts` 暴露 `register/resolve/list` 与 `helmsman.artifacts` 上下文类型
- [x] 1.2 在 `src/store.ts` 实现存储:blob 写入 `~/.helmsman/artifacts/blobs/<sha256>`,原子 `manifest.json`(tmp+rename),重复检测返回既有 id,50 MB 注册上限,解析损坏清单时按 blob 重建
- [x] 1.3 在 `src/download-headers.ts` 加 content-disposition 助手:ASCII 回退 + RFC 5987 `filename*`(CJK 安全)与 MIME 表(md/json/patch/diff/yaml/txt)
- [x] 1.4 单测存储:register/resolve/list、相同字节去重、元数据 + 生产者列表、重启存活、损坏清单重建、超大拒绝

## 2. ui-workbench:草稿 + 归档笔记成为产物

- [x] 2.1 把 `packages/ui-workbench/src/generator.ts` 的草稿生成/保存接上 `helmsman.artifacts`(懒 `ctx.get`,缺失时降级),产出的字节注册并返回产物 id
- [x] 2.2 在工作台 REST 宿主(`packages/ui-workbench/src/index.ts`)中,归档(`helmsman.knowledge.archive`)成功后注册归档笔记字节,并把产物 id 附到归档响应上
- [x] 2.3 加工作台 REST 路由:`GET api/artifacts`、`GET api/artifacts/:id`(带下载头流式返回)、`GET api/artifacts/:id/meta`
- [x] 2.4 在工作台抽屉(`packages/ui-workbench/src/client/App.tsx`)呈现产物:"交付物"列表,含类型/生产者元数据与下载链接

## 3. ui-dashboard:产物端点、任务包、topology 导出修正

- [x] 3.1 在 `packages/ui-dashboard/src/api.ts` 加 `GET api/artifacts` 与 `GET api/artifacts/:id` 路由,委托给 `helmsman.artifacts`
- [x] 3.2 在 `packages/ui-dashboard/src/api.ts` 实现任务包打包:为已完成任务从 worktree 服务收集各 agent 补丁,注册 `<taskId>.bundle.patch` + `<taskId>.bundle.json`,返回产物 id;在 `packages/ui-dashboard/src/client/App.tsx` 为终态任务加"下载产物包"
- [x] 3.3 改写 `GET api/topology/export`:先注册 YAML、再经产物端点提供(修正 `.json` 命名 YAML 的下载)
- [x] 3.4 路由器单测:产物列表/下载头(含一个中文文件名用例)、打包负载结构、topology 导出 content type

## 4. Bundle + 分发集成

- [x] 4.1 把 `@helmsman/artifacts` 加进 `packages/bundle` 的 `cordis.patch.yml`(第 13 个插件)与 bundle README/插件清单
- [x] 4.2 更新 README 交付物表格、`docs/DISTRIBUTION.md`、`docs/USAGE.md` 的插件计数(12 → 13),并文档化产物端点与策略/状态布局
- [x] 4.3 全仓 `pnpm build && pnpm typecheck && pnpm test` 通过

## 5. E2E 验证 + 文档

- [ ] 5.1 真实 profile 冒烟(手动,记录在 commit message):生成草稿 → 以正确文件名下载;归档笔记 → 出现在产物里;完成一个 2-agent 任务 → 下载产物包并 `git apply` 该补丁文件确认可用;topology 导出以 `.yaml` 下载
- [x] 5.2 更新 `docs/ARCHITECTURE.md`(产物注册表布局)与 `docs/SECURITY-AUDIT.md`(说明产物端点与其余 UI 同处 loopback 信任边界、暴露的是 Helmsman 自产内容)
