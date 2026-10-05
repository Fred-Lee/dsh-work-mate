# Design — Add Bands Watch

## D1 为什么不注册宿主 schedule

宿主 `schedule` 的 `ScheduleCreateRequest` 需要 sessionId，投递物是 prompt（会拉起模型），
而插件启动期没有会话、工具执行面也不保证 sessionId。硬做只有两条路：猜内部 API，或让用户
先在某会话里手动建提醒——两条都比"确定性脚本"差。cron/launchd/CI 拉起一个脚本，同样是
"no person in the invocation path"，且可版本化、可单测，与 [P1] 的表述一致。

## D2 检测与动作分离

脚本默认**只检测**（退出码表达结果）；要动作时显式 `--apply`。这与工具默认只读一致：
越界自动开提案是一个会影响工作区的动作，不该被一个定时任务默默带上。

## D3 退出码是契约

`0` = 无越界（或越界未达 `--fail-on` 档）；`1` = 达到 `--fail-on` 档（调度器据此告警/触发）；
`2` = 调用失败（网络/配置）。让 CI 与 launchd 都能直接读退出码，而不必解析文本。

## D4 单一实现

工具的评测口径与 REST 的必须完全一致，否则"工具说没事、脚本说越界"。抽出
`runBandsCheck` 后，两处只有入参差异。
