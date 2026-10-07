# Tasks — Decision Route Resilience

- [x] 1. 路由未解析时留痕（含 provider 列表与模型样例）
- [x] 2. 宽容匹配 + 回退首个 provider（回退留痕）
- [x] 3. provider 无模型时记录原因
- [x] 4. 用例：配置的 provider 不存在仍能到达适配器；零 provider 时不抛错
- [x] 5. 重启后重跑导出，读取真实 provider id 并定稿配置
