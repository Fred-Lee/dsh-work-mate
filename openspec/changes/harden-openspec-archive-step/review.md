# Review — 归档编排的 openspec-archive 步骤核验产物

## 确认项

- **假绿已复现（修复前）**：临时副本里，`specs/*/spec.md` 用 `## Requirements` 的四份变更，
  编排返回 `ok = true`、步骤 `openspec-archive: ok`、`changes/<id>/` 原地未动
  （见 design.md D0 的原始输出）。这是本变更的立论证据，不是推断。
- **根因定位**：`execCli`（`orchestrate.ts:116-134`）只在 `error` 非空时 reject，
  而 `openspec archive` 在 Aborted 时退出码为 0——实测 `exit=0`。
- **反证（关键）**：新增的 `fails when the CLI aborts but still exits 0` 用例跑**真实**
  `openspec` CLI。把 `orchestrate.ts` 的核验条件临时改成恒真（`if (true || …)`）后重跑：

  ```
  × fails when the CLI aborts but still exits 0 (delta header missing)
    → expected 'ok' to be 'failed' // Object.is equality
  Tests  1 failed | 3 passed | 23 skipped
  ```

  折回原实现后 4 条全绿。**这条用例确实在拦东西**，不是"新用例碰巧是绿的"。
- **正证（同夹具单变量）**：`succeeds when the same fixture only swaps the header to a
  delta section` 与反证用例共用 `seedWithSpec()`，唯一差别是 `## Requirements` →
  `## ADDED Requirements`。前者绿后者红，说明判定只可能来自核验逻辑，不来自夹具差异。
- **幂等未被误伤**：`treats a rerun over an already-archived change as a skip, not a
  failure` —— 第二次编排得 `skipped` 而非 `failed`，`ok = true`。
- **无 `specs/` 的变更未被误伤**：`does not misfire on a change that legitimately has no
  specs directory` —— 实测 `openspec` 对无 `specs/` 的变更只打 warning、目录照样移走，
  本判据给 `ok`。判据锚在"目录去向"，不是"有没有 specs"。
- **失败摘要带两条证据**：断言 `summary` 同时含 `Aborted. No files were changed.`
  （CLI 原话，说明为什么）与 `仍在原地`（产物事实，说明检查过了）。
- **失败不推进**：断言 `status` 步骤不存在、`result.ok === false`、`changes/p1/tasks.md`
  仍可读。service 层在 `!ok` 时记 `gate-failed` 并返回原状态（既有语义，未改）。
- **旧夹具的假绿被清除**：`installFakeOpenspec()` 原先只 `echo`、不移动目录——它**依赖的
  正是这次要修的假绿**。已改成真的 `mv changes/<id> → changes/archive/<date>-<id>`，
  并把断言的假 CLI 回显改为断言产物（`archive/2026-01-01-p1/tasks.md` 可读、
  `changes/p1` 已消失）。
- **上游影响（GitNexus）**：`impact orchestrateArchive --direction upstream` →
  `risk: LOW`、`impactedCount: 1`（唯一直接上游是 `service.ts` 的 `orchestrate` 钩子，
  它只读 `ok` 与 `steps[].status`，本次未改其契约）。`detect-changes --scope all` →
  4 files / 6 symbols / 3 processes / risk medium（`AGENTS.md` 的三个小节标题被索引计为
  symbol，属噪音，非代码风险）。

## 疑问项

- **`readChangeState` 的判据是目录名后缀**（`entries.some(e => e.endsWith('-' + id))`）。
  如果同一变更被归档过两次、`changes/archive/` 下出现两个同名后缀目录，判据仍然成立
  （只要有一个就算 archived）——这正是我们要的幂等语义。反之若有人手工把目录改名成
  不含 id 的形式，会被判 `failed`。这是**刻意的保守方向**：宁可报错也不假绿。
- **多目标（多项目）**：核验放在 per-target 循环内，某个项目没归档成功即
  `allArchived = false`，其余项目的步骤照常产出。混合情形（一个成功一个 Aborted）
  未单独写用例；既有 `tasks` 门的多目标用例覆盖了循环形状，本步骤的循环体与之同构。
- **`continue` 跳过 gitnexus 重索引**：归档没成就不重索引，与既有 `catch` 分支一致。
  若某个 target 失败、另一个成功，成功的那个仍会重索引——符合"各自独立推进"的既有语义。

## 建议补充项

- **`openspec validate` 应该进归档门**：本次根因是 delta 段头写错，而编排**在归档前**
  完全有机会用 `openspec validate <id>` 提前发现（它在 CLI 里是确定性、秒级、无需模型）。
  现在的顺序是"先归档，失败了才知道"，属于把可预测的失败留给最后一步。建议另开提案：
  `openspec-archive` 步骤之前加一道 `openspec-validate` 前置检查，失败即拦且摘要给出
  段头提示。本变更**刻意不做**，因为那是新增门（会影响所有提案的归档路径），
  与本变更"只把假绿改成真红"的范围不同。
- 面板目前把 `failed` 步骤原样展示，这次摘要会变长（CLI 末两行 + 产物事实）。
  若面板列宽吃紧，可考虑摘要与详情分两行渲染，属前端改动。

## CRITICAL 问题

无。

## 明确没验什么

- **没验真机面板路径**：本次改动在 `dist/index.js` 里，而 harness **在开发期间没有重启**
  （用户明确要求"不用重启 harness 宿主，保证开发连贯"）。所以"面板点归档会显示 failed
  且提案停在 archiving"这一条**只有代码级证据**（`orchestrate.test.ts` 的 4 条真 CLI 用例
  + service 层既有 `!ok` 语义的用例），没有真机点击实测。重启后需要复核一次。
- **没验 `openspec` 其它 Aborted 形态**：本次只覆盖"delta 段头缺失"这一种 Aborted 原因。
  理论上任何"退出码 0 但目录未移动"的情形都会被新判据拦住，但没有逐一构造
  （例如 `--skip-specs` 之外的 CLI 组合、权限不足导致 mv 失败等）。
- **没验 `openspec` CLI 版本升级后的行为**：判定不依赖 CLI 文案（这是设计选择），
  但"退出码 0 + 目录不动"这个组合本身是 CLI 的行为，未来 CLI 修掉它（改成非 0 退出码）
  后本判据依然安全——只是那时 `catch` 分支会接管。未实测。
- **没验多目标混合失败**（见疑问项）。

## 审查者与独立性（诚实声明）

本文件由写代码的同一个 agent 写成 —— 按提案自己新增的判据，这是 `same-as-author`（自评），
不是独立审查。`<!-- reviewer: ... -->` 的值如实写作实现者身份，不假造独立名字。

<!-- reviewer: harden-openspec-archive-step-author -->

## 门禁实跑

见提交后的收口记录（`pnpm typecheck && pnpm test && pnpm build && pnpm verify`）。
