# Label Evidence, Not the Matcher

## Why

理由标注上线后真机统计暴露一个措辞错误：

```
理由分布: {token 命中: 60, 向量相似: 2, 判断层归类: 16, 路径命中: 0}
```

**所有 60 条边都被标成「token 命中」**——因为 Impact 段里的证据是**文件路径**
（`.../HomeworkManagementService.java`），而路径里不会出现带连字符的模块 slug
（`homework-management`），所以"精确 slug 包含"判据几乎从不命中，全部落到 token 分支。

但读者关心的是**证据类型**（这段证据是代码路径，还是散文里的词？），不是**匹配算法**
（slug 包含 vs token 重叠）。把代码路径标成"token 命中"会让强证据看起来像弱推测。

## What Changes

1. 判据改为按**证据类型**：看起来像路径/文件名（含 `/` 或以扩展名结尾）→ `路径命中`；
   仅当原始证据不是路径、又靠 token 命中时才标 `token 命中`；
2. 向量/判断层来源仍由 `touchReasons` 决定（优先级最高）；
3. 用例断言：代码路径**不再**被标成 token 命中。

## Impact

- `src/features/wiki/vault.ts` + 一个用例；指标（边数/热度）不变，只是标注更诚实。
