# Tasks — Add `/workmate` Command

- [x] 1. `CommandFace` 最小面（register）+ 定义类型
- [x] 2. `parseWorkmateInput()` 纯函数：help / status / wiki + 旗标 + 路径校验
- [x] 3. 定义与 handler：按需代理 → 可选重索引 → 生成 → 按 complete/pages 汇报
- [x] 4. `ctx.inject(['commands'])` 注册（effect 绑定 fiber）
- [x] 5. 测试：解析各分支、非法输入、status 只读、wiki 成功/半份产物（注入假实现）、注册形状
- [x] 6. 文档：README 命令表 + §0 入口 + 常驻系统提示；AGENTS 里程碑
- [x] 7. 验证：typecheck / test / build / verify
