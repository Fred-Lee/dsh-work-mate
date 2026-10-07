## MODIFIED Requirements

### Requirement: Vault 视图笔记

迭代笔记中的每条「触及模块」边 SHALL 标注其来源（路径命中 / token 命中 / 向量相似 / 判断层归类），
使得边的可靠强度可被读者判断；段落标题 SHALL NOT 暗示所有边都来自 Impact 段。
front-matter 的 `touches` SHALL 保持纯 slug/名称，不掺入标注文字；热度与去重统计 SHALL 忽略标注。

#### Scenario: 理由可见

- **WHEN** 一次迭代的模块边分别来自路径、token 与判断层
- **THEN** 笔记中相应行分别出现「路径命中」「token 命中」「判断层归类」
