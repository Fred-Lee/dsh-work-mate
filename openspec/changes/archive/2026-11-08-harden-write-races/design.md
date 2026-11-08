# 写入竞态加固：任务分配与提案存储串行化

## D1 promise-chain 互斥，不引入依赖

进程内互斥用一条 `tail: Promise` 链：每个写方法 `serialize(fn)` 把 fn 排到链尾。
方法之间无嵌套调用（create 不调 reply；ensureImplementationTasks 不调 create），
单链无死锁面。跨进程互斥（文件锁）明确不做：任务文件只有面板/工具（同进程）写，
tasks.jsonl 只有 Source（另一进程）写——单写者纪律本来就隔离了跨进程竞争。

## D2 互斥只包文件操作，不包副作用

TaskService.stop 会代理执行器 stop（网络）；ProposalService 的调用方
（LifecycleService.transition）在 setStatus 之间做重活。互斥只覆盖
load→mutate→save 段，副作用留在锁外，避免长操作拖住后续写入。

## D3 失败不吞

链上某个 fn 抛错时，链必须继续（`tail = run.catch(() => undefined)`），
错误原样返回给当次调用方——与现状一致的错误语义，只是不再波及后续写入。
