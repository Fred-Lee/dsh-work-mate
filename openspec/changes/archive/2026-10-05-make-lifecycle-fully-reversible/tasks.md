# Tasks — Make the Lifecycle Fully Reversible

- [x] 1. host：`ArchiveServiceImpl.stop`（executing → draft，非 executing 拒绝）
- [x] 2. REST：`POST /api/proposals/:id/stop`
- [x] 3. 工具：`workmate_proposal_archive` 增加 `mode`（archive/start/reopen/stop），
      旧布尔 `start` 兼容
- [x] 4. client：执行中卡片「退回提案」按钮
- [x] 5. 测试：往返流转 / 非法方向拒绝（60 用例全绿）；真机 stop/start/非法方向验证
