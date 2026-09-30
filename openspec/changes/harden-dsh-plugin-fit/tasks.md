# Tasks — Harden DSH Plugin Fit

- [ ] 1. 宿主 inject 解耦：`inject = ['tools']`，webServer 改 `ctx.inject(['webServer'], …)`
      惰性挂载（缺失即无 UI、工具照常）
- [ ] 2. 客户端 inject 解耦：client half 零硬依赖，better-sidebar tab 与 slots 两个入口
      各自惰性注册
- [ ] 3. `openspecRoot` 贯通：`LifecycleDeps.openspecRoot`（缺省回落 `'openspec'`），
      替换 service.ts 5 处字面量，index.ts 传 `resolved.openspecRoot`
- [ ] 4. 注册表 fail-closed：`ProjectRegistry.read/upsert/remove` 改为缺失读空、损坏抛
      `StoreCorruptError`、写路径不覆盖；`dirname()` 清理
- [ ] 5. 状态详情补 `lifecycle{status,hint,prev,next}`（`state-machine.ts` 新增 `prevState`）
- [ ] 6. `force` 贯通：`runArchive(id, {force})` → `orchestrate({reviewGate})`；REST body
      与工具参数 `force` 均生效（只跳过审查门）
- [ ] 7. 归档回退补齐：`archived → archiving` 回退调用 `orchestrateReopen`，步骤随
      `TransitionOutcome.orchestration` 返回，失败不阻断状态回退
- [ ] 8. 面板流转：回退 / 推进 / 完成归档 / 强制归档按钮 + `transitionProposal`；
      删除 `startProposal`/`stopProposal`/`reopenProposal` 三个死函数
- [ ] 9. 取消传导：`exec.signal` 贯通 git / pnpm install / openspec CLI / gitnexus /
      WeKnora fetch（git.ts、manager.ts、gitnexus.ts、weknora.ts、orchestrate.ts、service.ts、index.ts）
- [ ] 10. 工具元数据：`workmate_proposal_archive` / `workmate_knowledge_query` 声明
      `timeoutMs`；4 个只读工具声明 `isConcurrencySafe: () => true`
- [ ] 11. 测试：registry fail-closed（新增 registry.test.ts）、openspecRoot 贯通、
      force 跳过审查门、archived→archiving 目录搬回、面板推进/回退/强制归档渲染、
      live（act 埋点）判定
- [ ] 12. 全量验证：`pnpm typecheck` + `pnpm test` + `pnpm build` + `pnpm verify:contract`
      + `openspec validate harden-dsh-plugin-fit --strict`
