# Review — 写入竞态加固

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认：TaskService 五个写方法与 ensureImplementationTasks 之间无互相调用，
  单条 promise 链无死锁面；方法均为 load→mutate→save 短段，副作用（执行器 stop 代理）
  留在锁外。
- [x] 确认：ProposalService 的写方法（upsert/patchFields/setStatus/addDecision/addApproval）
  同样无嵌套；LifecycleService.transition 对 proposals 的多次调用是顺序的，每次独立入链。
- [x] 确认：单写者纪律不受影响——tasks.jsonl 仍只有 Source 写，inputs.jsonl 仍只有面板写，
  互斥只收敛同进程内的面板/工具并发。

## 疑问项

- 跨进程文件锁（面板进程 vs 假想的第二个写者）明确不做：现在的部署里聚合文件只有
  一个宿主进程写。若未来出现第二个写者，另开变更。

## 建议补充项

- 无。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] 无未解决 CRITICAL 问题。
