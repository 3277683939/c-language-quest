# 学习排行榜部署

1. 已有云存档项目先运行 `supabase.sql`（现有项目不必重复）。
2. 运行 `leaderboard-questions.sql`，再运行 `leaderboard.sql`。
3. 用匿名公开密钥 POST `/rest/v1/rpc/cquest_rank_list`，请求体 `{}`；无成员时应返回 `[]`。

排行榜默认无人加入。用户登录、验证邮箱后自行填写昵称并同意公开，再调用加入接口。只返回名次、昵称、做对题数和当前登录者标记。退出只删除公开昵称记录，保留私人云存档。

分数来自已有云存档的不同选择题；同一题做对多次、多个设备的计数只算一题。未知题号、填空/编程题自评不计入。分数依赖用户的学习存档，因此是学习交流榜，并非可用于正式考试的防作弊排名。上传存档完成后刷新榜单可看到变化。

新增题目后，重新运行 `python tools/generate_leaderboard_questions.py`，在控制台执行生成的 `leaderboard-questions.sql` 更新题号表；脚本不会删除学习进度。当前生成器读取 `overrides/bank.js` 中的选择题；若新增题目位于其他导入文件，也需将正式发布的选择题 ID 纳入表中，不能让客户端任意提交题号或分数。

验证命令（不使用真实用户、密钥或收费 API）：

```
node tools/test_leaderboard_sql.mjs
node tools/test_leaderboard_account.cjs
node tools/test_account.cjs
node tools/test_account_races.cjs
```

SQL 测试使用 `.question-import/sql-test-runtime` 中现有的 PGlite，在隔离内存数据库中验证 RLS、昵称校验、自愿加入/退出、合法题号、计分去重、同分并列及隐私输出。
