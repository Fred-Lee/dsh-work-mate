# Tasks — Multi-Route Fallback

- [x] 1. resolveRoutes 返回有序候选（精确优先，无模型跳过）
- [x] 2. ask() 逐路由尝试，第一条有答案者胜出
- [x] 3. 用例：坏 provider 跳过 + 精确匹配优先
- [x] 4. 重启后真机复跑重排，期望 action=act 且顺序变化/或仍 abstain（都不再有 ACCOUNT_SIGN_IN_REQUIRED）
