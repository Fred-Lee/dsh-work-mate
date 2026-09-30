# Tasks — Harden DSH Plugin Fit

- [x] 1. 宿主 inject 解耦：`inject = ['tools']`，webServer 改 `ctx.inject(['webServer'], …)`
      惰性挂载（缺失即无 UI、工具照常）
      - 回归测试 `src/index.test.ts`：无 webServer 时 10 个工具仍注册、不挂路由；
        有 webServer 时挂 `/workmate` 前缀
- [x] 2. 客户端 inject 解耦：client half 零硬依赖，better-sidebar tab 与 slots 两个入口
      各自惰性注册
      - 回归测试 `src/client/entry.test.tsx`：只有 slots → 两个入口；只有 betterSidebar →
        只有 tab；`inject` 为空数组
- [x] 3. `openspecRoot` 贯通：`LifecycleDeps.openspecRoot`（缺省回落 `'openspec'`），
      替换 service.ts 5 处字面量，index.ts 传 `resolved.openspecRoot`
      - 测试：`openspecRoot: 'spec'` 下 proposing 前置校验通过、wiki.md/commits.md 落在
        `spec/changes/<id>/`、归档编排 options 收到 `'spec'`
- [x] 4. 注册表 fail-closed：`ProjectRegistry.read/upsert/remove` 改为缺失读空、损坏抛
      `StoreCorruptError`、写路径不覆盖；`dirname()` 清理
      - 新增 `src/features/project/registry.test.ts`（5 例，含"损坏字节原样保留"）
- [x] 5. 状态详情补 `lifecycle{status,hint,prev,next}`（`state-machine.ts` 新增 `prevState`）
      - api.test 断言 draft 卡片返回 `{status, hint, next}`；state-machine.test 补 `prevState`
- [x] 6. `force` 贯通：`runArchive(id, {force})` → `orchestrate({reviewGate})`；REST body
      与工具参数 `force` 均生效（只跳过审查门）
      - 测试：无 review.md 时默认阻断、`reviewGate:false` 放行且 openspec archive 仍执行；
        api.test 断言空 body = `force:false`
- [x] 7. 归档回退补齐：`archived → archiving` 回退调用 `orchestrateReopen`，步骤随
      `TransitionOutcome.orchestration` 返回，失败不阻断状态回退
      - 测试：真实目录 `changes/archive/2026-09-28-p1` → `changes/p1`；根不可解析时仍回退状态
- [x] 8. 面板流转：回退 / 推进 / 完成归档 / 强制归档按钮 + `transitionProposal`；
      删除 `startProposal`/`stopProposal`/`reopenProposal` 三个死函数
      - app.test：回退 POST `/transition {to:'proposing'}`；archiving 卡片只给完成/强制归档，
        不出现"推进到 已归档"；强制归档 POST `{force:true}`
- [x] 9. 取消传导：`exec.signal` 贯通 git worktree add / pnpm install / openspec CLI /
      gitnexus / WeKnora fetch（git.ts、manager.ts、gitnexus.ts、weknora.ts、
      orchestrate.ts、service.ts、index.ts）
      - weknora 用 `AbortSignal.any([timeout, caller])`，自有 deadline 与调用方取消取先到者
- [x] 10. 工具元数据：`workmate_proposal_archive`(15min) / `workmate_knowledge_query`(120s) /
      `workmate_knowledge_search`(60s) 声明 `timeoutMs`；4 个只读工具声明
      `isConcurrencySafe: () => true`；写工具保持独占
- [x] 11. 测试：新增 registry 5 例、index 入口 5 例、client 入口 4 例、面板 +2 例、
      archive +4 例、api +1 例、state-machine +1 例 —— 累计 93 例全绿
- [x] 12. 全量验证：`pnpm typecheck` ✅、`pnpm test` 93/93 ✅、`pnpm verify:contract` ✅、
      `pnpm verify:toolchain` ✅、`openspec validate harden-dsh-plugin-fit --strict` ✅、
      `node scripts/build.mjs` + `import('./dist/index.js')` 冒烟 ✅（`inject: ["tools"]`）
      - ⚠️ `pnpm build` 的 `tsc -p tsconfig.decls.json` 步骤**在本轮之前就是坏的**
        （TS 5.6.3 不认识 `rewriteRelativeImportExtensions`，且 `.ts` 后缀 import 与
        `allowImportingTsExtensions: false` 互斥；`git stash` 到 HEAD 复现）。运行时产物由
        `scripts/build.mjs` 先产出，profile 不受影响；已在 `docs/DSH-FIT-AUDIT.md` §4 记为
        P2-8，待 TypeScript 提到 `^5.7` 时一并修（当前 pnpm store v10/v11 不一致挡住了
        `pnpm add`）。
