# Tasks — Adopt DSH-native Config and Guidance Surfaces

- [ ] 1. 依赖：`@deepseek-ai/schemastery@^3.18.2` 进 `dependencies` + `devDependencies`，
      `toolchain.json.require` 记录同线
- [ ] 2. `src/config.ts`：`export const Config: z<Config>`（14 项带 default + description），
      保留 interface 与 `resolveConfig`，新增 `claudeAssetsEnabled`（默认 true）
- [ ] 3. 契约测试：镜像宿主 `isNativeConfigSchema` 谓词断言运行时 `Config` 通过；
      默认值与 `resolveConfig` 行为回归
- [ ] 4. `src/features/guidance/`：faces（skills / systemPrompt 最小面）、content
      （两段 skill 正文 + prompt 段）、index（惰性注册）
- [ ] 5. `src/index.ts`：导出运行时 `Config`，接 `registerGuidance(ctx)`，
      收敛工具描述里重复的纪律话术
- [ ] 6. `.claude/**` 开关：`syncProjectAssets({claudeAssets})` 分流 openspec 资产与
      Claude 资产（含 settings 合并），api/index 透传 `claudeAssetsEnabled`
- [ ] 7. 测试：guidance 注册（有/无服务两种上下文）、quality 开关（关掉后不写 `.claude/**`
      但 openspec 资产照写）、index 入口断言 Config 为 native schema + 两个 skill 注册
- [ ] 8. 文档：README 配置表（新项 + Schemastery 说明）、§8 质量保障机制标注 Claude 资产
      的适用面与 DSH 原生替代、DSH-FIT-AUDIT 标注 Step 2 进度
- [ ] 9. 全量验证：typecheck / test / build(esbuild 产物) / verify:contract /
      verify:toolchain / openspec validate --strict + 真机重启后核对
