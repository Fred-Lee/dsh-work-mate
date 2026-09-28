# Tasks — Add Proposal Middleware

## 1. Host 半：openspec 目录与 Git 关联

- [x] 1.1 `src/features/proposal/openspec.ts`：三件套模板生成（不覆盖已存在）、
      projectRoot 校验
- [x] 1.2 `src/features/proposal/git.ts`：`git log --fixed-strings` 关联提交扫描
      （argv 数组、越界校验、仓库不存在优雅降级）
- [x] 1.3 `src/features/proposal/status.ts`：提案详情聚合（详情 + commits +
      openspec 存在性 / tasks 进度）

## 2. Host 半：归档状态机与工具注册

- [x] 1.4 `src/features/archive/service.ts`：draft/executing/archived 状态机
      （校验迁移合法性、openspec 目录检查）
- [x] 2.1 `src/index.ts`：`inject = ['tools', 'webServer']`；注册三个工具
      （defineTool 形态）；挂载 `/workmate/` prefix

## 3. REST 与 SPA

- [x] 3.1 `src/http.ts`：Router（方法+路径+:param+JSON helper+静态白名单+遍历保护）
- [x] 3.2 `src/api.ts`：proposals 列表/详情/创建/归档 + openspec 目录联动
- [x] 3.3 `src/client/`：ProposalPanel（React）+ main.tsx（IIFE）+ index.tsx
      （ModuleLoader + betterSidebar tab）+ api.ts + styles
- [ ] 3.4 `build.mjs` 两个 client 产物；`package.json` 加 `dsh.client` / `exports`
      / react·jsdom·testing-library devDeps；`tsconfig.client.json`

## 4. 测试与验收

- [x] 4.1 单测：openspec 模板（不覆盖）、git 扫描（临时真 git 仓库）、状态机、
      REST 集成（路由 + 聚合）
- [x] 4.2 client 测试：面板渲染 / 创建 / 归档交互（jsdom + testing-library）
- [x] 4.3 `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm verify:contract` 全绿
- [ ] 4.4 真机冒烟：curl REST 全链路 + 工具在 Agent 侧可见 + 面板页可打开
