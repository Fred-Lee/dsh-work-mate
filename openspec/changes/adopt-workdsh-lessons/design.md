# Design — Adopt WorkDSH Lessons

## D1 钉版门禁：移植而非新造

Helmsman main 分支的 `toolchain.json` + `scripts/check-toolchain.mjs --structural`
是真机与 CI 验证过的实现，直接精简移植（去掉 live/profile 比对模式，保留 structural）：

```jsonc
// toolchain.json
{
  "require": { "@deepseek-ai/cordis": "^4.0.2", "@deepseek-ai/dsh-tools": "0.1.2-alpha.5" },
  "profile": { "dsh": "0.1.7-rc.2" }
}
```

校验逻辑：对账对象是 `package.json` 的 **devDependencies 精确版本**（peer 里的
`dsh-tools: "*"` 是宿主契约不参与对账），与 `toolchain.json` 的 require 逐项一致即
通过；`profile.dsh` 仅记录当前宿主基线不做安装期断言（宿主版本由 profile 管理）。
挂 `pnpm verify:toolchain` 并追加进 contract 门禁链。CI 现状修正（2026-09-29 审核）：仓库实际残留 Helmsman 时期的
`.github/workflows/toolchain.yml`，其引用的脚本与文档路径已被本分支删除——移植
门禁时一并修复该 workflow（paths 过滤收敛为 toolchain.json / package.json /
workflow 自身），故本项是「修复复用」而非新增。

## D2 Skill 同步纪律

技能根：`$DSH_HOME/skills/<name>/SKILL.md`——**已实证**（2026-09-29 读
dsh-skill-manager@0.1.3 源码：`skillRoots()` 返回 `[$DSH_HOME/skills,
~/.agents/skills]`，前者即设计目标根；此前为假设，现升级为 C 级源码证据）。
项目级根 `<项目根>/.dsh/skills/` 属于被编排的目标项目，WorkMate 不写。同步纪律照抄
Helmsman presets：目标目录已存在且含 SKILL.md → 跳过（`synced 0` 是正确幂等）；
缺失 → 写入包内嵌副本。`Config.skillSyncEnabled`（默认 true）关闭时完全不碰用户
目录。包内嵌资产经 esbuild `--loader:.md=text` 打进 host bundle，运行时从
`import.meta.url` 相对路径读取——与 client 资产同纪律。

## D3 验收谓词是编排前置，不是新机制

`workmate_proposal_archive` 已有 force 语义与失败即停；本变更在编排第一步（tasks
快照）处升级：任一关联项目存在未勾选任务（`- [ ]`）→ 编排失败，step 记录逐项目
的 `done/total`，状态不变可重试；`force: true` 跳过该检查（对齐 openspec CLI
`--yes` 的既有妥协，但把警告前移成显式决定）。无关联项目时跳过检查（无依据可验收）。

## D4 ArchiveManifest 的采集与落盘

采集点：编排成功的每个项目 target 内，archive 步骤之后——

- `commits`：`git log --fixed-strings --grep '[proposal:<id>]' --format=%H`（复用
  关联扫描，只取 hash 列表，manifest 里存短 hash）
- `diffStat`：`git diff --stat <base>..<head>`，base 取该项目首次关联提交的父提交，
  无基线（单提交）时退化为 `git show --stat HEAD`
- `specsUpdated`：openspec archive 输出含 spec 更新痕迹（CLI 输出摘要里已有）→
  布尔
- `reindexed`：gitnexus-analyze step 的 ok 布尔

落盘：manifest 写入 `proposals.json` 提案记录的新可选字段 `archiveManifest?`（原子
写纪律不变）。client 在归档卡片详情区渲染（新增「交付物」小节）；无 manifest 的旧
归档提案显示「无归档摘要」。

## D5 不做的事

- 不接 SkillHub / dsh-market；不做桌面载体（§9.4 / §9.6 结论）。
- 不做 `SwarmTaskConfig` 全量形态（swarm 插件未接入）。
- 验收谓词不做「命令执行」类谓词（`done` 里跑任意命令是注入面），只做 tasks 勾选
  状态这一结构化信号。
