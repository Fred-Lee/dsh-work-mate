# Review — 归档收尾健壮性

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认：`worktree.remove` 本身已有 `mainBranch` 入参（`baseBranch ?? mainBranch ?? 'main'`），
  缺的只是归档编排与面板释放两处调用没传——改动面是调用方两行，不是回收器重写。
- [x] 确认：`isMergedInto` 的调用方共 4 处（merging 前置、archiving 前置、reject、回收），
  fetch 放在函数内部即可一次覆盖全部调用方，不需要每处各加。
- [x] 确认：fetch 限定 `origin` 与两个引用，本地-only 仓库（本仓库自身当前无 remote 的测试夹具、
  以及未配 remote 的用户仓库）fetch 失败被吞，行为与现状一致——design D3 的不变量有对应用例。

## 疑问项

- fetch 更新远端跟踪引用属于对用户仓库的可观察副作用；本变更接受它（标准 git 行为，
  且只 fetch 两个引用）。若未来要求"门禁零副作用"，可加 `--no-write-fetch-head` 类开关（本机 git 版本相关），暂不做。

## 建议补充项

- 面板单独释放与归档编排共用同一 `remove` 入口，修复自动覆盖两者；无需面板改动。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] 无未解决 CRITICAL 问题。
