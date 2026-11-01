# 验收证据 — adopt-superagent-openspec-source

> `review.md` 的四节是机器可读约定，证据一律写在这里（task 28 明确要求）。

## 本机门禁记录（2026-11-01）

环境：macOS 25.6.0 / Node v24.11.0 / pnpm 10.33.2；
宿主内核 `@deepseek-ai/dsh-tools 0.2.1-rc.2`（`--profile web` 实装）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（host / client / packages 三个 program） |
| `pnpm test` | 90 个文件 / 785 条用例全部通过 |
| `pnpm build` | 通过；子包产物 `packages/superagent-source/dist/source-watch.js` 35.2kb |
| `pnpm verify` | 六条门禁全绿：contract / toolchain / host-compat / client-gate / source-gate / test-integrity |
| `pnpm test:toolchain` | 59 条通过（含 `rollback-superagent.test.mjs` 16 条、`verify-source-install.test.mjs` 8 条） |

`verify:source` 原话：

```
[source-gate] ok — name=workmate-superagent-source, inject=[orchestrator], apply 在无 orchestrator 时保持不活动
```

`verify:test` 原话：

```
[test-integrity] ok — 90 个测试文件全部执行，785 条通过，0 skip / 0 todo（仓库发现全集 90，与 include 无关）
```

## `verify-source-install.mjs` 三种夹具（task 27）

夹具用真实宿主 profile，不是 mock：

**① 正常安装**（临时 profile `wm-source-check`，用 `dsh plugin add` 装子包）：

```
[ ok ] 包已安装且版本可读            workmate-superagent-source@0.1.0
[ ok ] bundle 已加入 dsh.profile.bundles
[ ok ] bundle patch 恰好一条 entry    ./cordis.patch.yml 有 1 条 entry
[ ok ] 来源出现在 --dump-config-schema 且可装载
       条目 workmate-superagent-source status=absent（预期：无插件级 Config，配置属于 Source 实例）
结论：来源可被宿主装载。   exit=0
```

`status=absent` 的语义来自宿主 `config-schema/collect.ts:192-214`：模块 import 成功但没有
profile 级 Config。本包的全部配置属于 Source 实例（存 Super-agent 自己的库），所以这是
预期值；`error` / `unsupported` 才是故障。

**② 已装未启用**（把包名从 `dsh.profile.bundles` 移除，其余不变）：

```
[ ok ] 包已安装且版本可读
[FAIL] bundle 已加入 dsh.profile.bundles   bundles 不含 workmate-superagent-source
[ ok ] bundle patch 恰好一条 entry
[FAIL] 来源出现在 --dump-config-schema 且可装载
       --dump-config-schema 里没有 workmate-superagent-source（先确认已装且已进 bundles）
结论：上面 FAIL 的项不修好，这个来源不会工作。   exit=1
```

**③ 未安装**（本机 `web` profile，从未装过子包）：

```
[FAIL] 包已安装且版本可读        未安装：.../node_modules/workmate-superagent-source 不存在
[FAIL] bundle 已加入 dsh.profile.bundles
[FAIL] bundle patch 恰好一条 entry   package.json 未声明 dsh.bundle.patch
[FAIL] 来源出现在 --dump-config-schema 且可装载
结论：上面 FAIL 的项不修好，这个来源不会工作。   exit=1
```

`--dump-config` 侧的证据（正常安装夹具）：`- id: workmate-superagent-source` /
`name: workmate-superagent-source` 出现在 profile 组合树里，且**没有**手工编辑过
`dsh.profile.bundles` —— 由 `dsh plugin add` 自动写入，符合「装即启用」。

## `workmate_team_run` 在 superagent 下的 disabled 结论

`src/features/team/tools.test.ts` 6 条全通过，其中两条直接覆盖：

- `workmate_team_run` 抛出的拒绝文案包含 `taskExecutor`（引导显式设 `team`）；
- `workmate_team_plan(start=true)` 返回 `dispatch: { disabled: true, reason }`，不派发。

## 回滚演练（task 22，真实 git 夹具）

临时仓库 `drill`：`.workmates/workmate-drill-aaaaaaaaaaaa`（分支
`workmate/drill-aaaaaaaaaaaa`）+ `ports.json` 键 `drill-prop--drill--task-drill-1`。

```
WorkMate × Super-agent 回滚
· task-drill-1（drill-prop · drill）
  目录      /tmp/.../.workmates/workmate-drill-aaaaaaaaaaaa [cached]
  worktree  已移除
  分支      workmate/drill-aaaaaaaaaaaa — 已删除
  端口      已释放 drill-prop--drill--task-drill-1
结论：目录与分支已按预期处理。   exit=0
```

执行后：`git worktree list` 只剩主检出，`git branch` 只剩 `main`，`ports.json` 为 `{}`。
演练过程中发现并修正一个真实问题：分支名不能只按目录末段推导（目录带 `workmate-` 前缀
时会拼出双前缀），已改为「提案 target 的 `featureBranch` → 默认命名 → 去前缀命名」三级候选。

## 未执行项（需要真机，task 28）

以下按 `docs/SUPERAGENT-ACCEPTANCE.md` 执行，**当前未做**，因为需要一台跑着 Super-agent
的宿主 + 真实 worker：

- [ ] A 安装与装载（真实 Super-agent profile）
- [ ] B `interactive=false` 首跑的 Thread 可见性
- [ ] C 六阶段面板 ↔ Execution 页逐阶段对照（六张截图）
- [ ] D worktree 目录、分支、`DSH_SUPERAGENT_WORKMATE_*`、`.env` 端口
- [ ] E Channel 端到端（`tasks.jsonl` / `inputs.jsonl` / `gone` / 压缩）
- [ ] F 320 / 760 / 1180 / 1440 四档布局截图
- [ ] G 回退演练（`taskExecutor=team` + 停用子包 + 脚本）
- [ ] H 离线 / 卸包 / 坏文件三种失败态
