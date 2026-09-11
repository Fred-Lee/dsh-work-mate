## Why

Helmsman 的稳定性上限取决于它所挂载的 DSH 平台,但它对依赖版本的假设目前只靠文字约束:文档在 README/设置说明里用散文形式钉住社区插件与 `dsh-tools` 的版本,没有机器可读的清单、没有兼容性记录、也没有升级校验脚本。MOVO 项目展示了 Helmsman 所缺的工业化模式——锁定依赖清单、兼容性矩阵、CI 里的脚本化升级检查——这正是让一个外部项目跟上上游内核更新又不静默翻车的关键。本次变更给 Helmsman 仓库加上这套轻量版本治理:把所有声明的版本(DSH 平台、cordis API、`dsh-tools`、社区插件、Node/pnpm)一次钉死、可检查、可验证。

## What Changes

- 为"经过验证的版本"建立唯一事实源——仓库根部的清单文件(建议 `toolchain.json` 或可注入 env 的形式),记录:DSH 平台/CLI 版本、`@deepseek-ai/cordis` 与 `dsh-tools` 版本、十个社区工作台插件及各自确切版本,以及 Node/pnpm 的 engines 约束。
- 依据该清单生成 `docs/COMPATIBILITY.md`:记录"哪个 Helmsman 版本在哪些 DSH/社区版本上验证过",以及已知可用/已知损坏的组合。
- 新增升级校验脚本(`scripts/check-dsh-compat.mjs` 或 shell):对活动 profile(`dsh plugin list`、已装 Node/pnpm)校验清单;并在每次清单变更时由 CI workflow(`.github/workflows/compat.yml`)执行。
- 维持"社区插件只复用、绝不重写"的立场:清单只声明 Helmsman 需要哪些插件,仍由用户通过 `dsh plugin add` 安装——不 vendor 任何东西。
- 无运行时行为变化:这是纯仓库/治理工具,先于其他基于固定版本的能力变更落地。

## Capabilities

### New Capabilities
- `toolchain-version-governance`:DSH 平台/内核、cordis、dsh-tools、社区插件与工具链的机器可读钉版清单,附派生的兼容性文档与脚本化升级校验。

### Modified Capabilities
<!-- 暂无。 -->

## Impact

- 仓库根部:新增 `toolchain.json`(或等价)清单;`.github/workflows/compat.yml`;`scripts/` 下新增助手。
- `docs/`:新增 `COMPATIBILITY.md`;`docs/WORKBENCH-SETUP.md` 与 `docs/DISTRIBUTION.md` 改为引用清单,不再用散文钉版本。
- `packages/bundle` 的 README/`cordis.patch.yml` 与清单交叉核对(12 插件集合)。
- 插件运行时代码与 `~/.helmsman` 下的状态零改动。
