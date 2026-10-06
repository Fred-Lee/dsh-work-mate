## MODIFIED Requirements

### Requirement: 项目 wiki 生成

实现 SHALL 提供按项目生成 wiki 的入口（工具与 REST），调用 GitNexus 的 wiki 生成能力，
并把产物目录（`<项目>/.gitnexus/wiki/`，含 `index.html`）与 CLI 摘要回传；
当 GitNexus 桥被配置关闭时 SHALL 返回禁用说明而非报错。

实现 SHALL 在生成前解析网关凭据：环境（`GITNEXUS_API_KEY` / 配置的变量名）、
macOS 钥匙串（配置的服务名）、`~/.gitnexus/config.json`；**没有凭据时 SHALL NOT 启动 CLI**，
SHALL 直接返回包含配置指引的结果。

产物核验 SHALL 以**本次运行**为准：`index.html` 的修改时间早于本次开始时，
SHALL 记为 `staleArtifacts: true`、`pages: 0`、`complete: false`，并说明磁盘上是上一次的产物；
SHALL NOT 把陈旧产物报成本次成功。

#### Scenario: 环境干净但钥匙串有 key

- **WHEN** harness 环境无 `ESP_XKW_KEY`/`GITNEXUS_API_KEY`，而配置的钥匙串服务里有 key
- **THEN** 子进程获得 `GITNEXUS_API_KEY`，生成正常进行

#### Scenario: 完全没有凭据

- **WHEN** 环境、钥匙串与 config.json 都没有 key
- **THEN** 不执行 CLI，返回"缺少网关凭据"的可执行说明，且 `pages` 为 0

#### Scenario: 上一次的产物不得冒充本次成功

- **WHEN** 本次运行失败（或未执行），而目录里存在更早已生成的 `index.html`
- **THEN** 结果 `complete` 为 false、`staleArtifacts` 为 true，并说明产物来自上一次
