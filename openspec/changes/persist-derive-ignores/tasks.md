## 1. 忽略清单存取（memory-topology）

- [ ] 1.1 新增 `derive-ignores.ts`:按群读写 `~/.helmsman/derive-ignores.json`(原子 tmp+rename,`schemaVersion`,键 `from→to` + 时间);损坏时报错且不覆盖;`HELMSMAN_HOME` 感知
- [ ] 1.2 服务面:`ignoreCandidates(group, keys[])`、`restoreIgnoredCandidates(group, keys?)`(缺省全部)、推导与漂移路径装排除集
- [ ] 1.3 `derive-dependencies.ts`:`DeriveOptions.exclude?: readonly string[]`(纯过滤,模块保持可注入测试);结果回显 `excluded` 计数
- [ ] 1.4 单测:忽略后推导不含该候选且 `excluded=1`;重启(新实例)仍生效;漂移「未声明」不含被忽略对;恢复后重现;全部恢复清空;忽略不动拓扑/声明文件(字节不变)

## 2. UI（ui-dashboard）

- [ ] 2.1 「忽略」改为调用落库接口,成功后即时移出;toast 确认
- [ ] 2.2 「已忽略 (N)」折叠清单(目标对 + 证据摘要 + 恢复按钮);逐条恢复与全部恢复;N=0 或旧版服务(无能力)时不显示
- [ ] 2.3 `api.ts` 路由(如 `POST api/topology/derive/ignore`、`POST api/topology/derive/restore`)+ `client/api.ts`;单测(转发/旧版降级/载荷形状)
- [ ] 2.4 组件测试:忽略后行消失且已忽略区出现;恢复后重回候选;旧服务不显示该区

## 3. 文档与验证

- [ ] 3.1 `docs/USAGE.md`:忽略/恢复流程、存储位置、与漂移核对的关系
- [ ] 3.2 `docs/VERIFICATION-GUIDE.md`:可复现步骤(推导 → 忽略 oss → 重跑不出现 → 恢复 → 重现)
- [ ] 3.3 全仓 `pnpm typecheck && pnpm test` 通过
- [ ] 3.4 真机冒烟(父对话):推导 → 忽略 `oss`/`bapi` → 重跑不出现 → 漂移「未声明」同步干净 → 恢复 → 重现
