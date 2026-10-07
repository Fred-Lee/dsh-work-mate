## MODIFIED Requirements

### Requirement: Vault 词法检索

实现 SHALL 提供在 vault 内按关键词检索的能力，返回文件与行号及片段，支持结果上限与项目限定；
无命中或 vault 缺失时 SHALL 返回说明而非报错。

在配置了本地嵌入模型（`Config.wikiVaultEmbeddingModel`）时，实现 SHALL 额外支持语义检索，
并 SHALL 采用**词法优先**策略：词法有命中时 SHALL 直接返回词法结果；
仅在词法无命中（或调用方显式要求语义）时才使用嵌入，结果 SHALL 说明所用引擎；
语义命中 SHALL 引用**分块起始行**，SHALL NOT 声称精确到句。
嵌入调用失败 SHALL 降级为说明并保留词法结果，SHALL NOT 抛错；
单次运行的**新嵌入数量** SHALL 有上限。

#### Scenario: 词法优先

- **WHEN** 词法检索有命中
- **THEN** 返回词法结果，`engine` 为 `lexical`，不调用嵌入模型

#### Scenario: 语义兜底

- **WHEN** 词法无命中且配置了嵌入模型、Ollama 可用
- **THEN** 返回语义命中（行号为分块起始行），`engine` 为 `semantic`

#### Scenario: Ollama 不可用

- **WHEN** 嵌入调用失败
- **THEN** 结果保留词法（空）结果并给出原因说明，不抛错
