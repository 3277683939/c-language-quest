# 启用邮箱账号和云存档

网页继续发布在GitHub Pages。Supabase负责邮箱身份认证和每个用户独立的学习存档，网页只持有允许公开的项目连接配置。没有项目配置时继续使用本机存档，不会冒充已注册或已同步。

## 一次性设置

1. 打开 [Supabase控制台](https://supabase.com/dashboard)，用自己的账号登录。在免费组织下创建Free项目，选择界面提供的合适地区。项目数据库密码由你设置并自行保存，不要发到聊天或写入网页。
2. 在项目 **SQL Editor** 中执行同目录的 `supabase.sql`。脚本创建用户存档表、访问隔离策略及带版本号检查的保存函数，可重复执行，不删除已有存档。
3. 在 **Authentication → URL Configuration** 中设置网站地址与允许跳转地址为 `https://3277683939.github.io/c-language-quest/`。使用项目支持的邮箱密码登录方式。邮箱验证保持项目的设置；网页会把“等待邮箱验证”与“已登录”区分显示。
4. 在项目的连接/设置页面找到 **Project URL** 和 **Publishable key**（旧项目也可用`anon public` key）。它们是网页允许公开的连接信息。不要使用`secret`或`service_role`管理员Key。
5. 回到项目根目录，双击 **配置云存档.cmd**，输入项目URL与公开Key。程序会拒绝管理员Key，并先检查认证服务能否连接。不会收集或保存你的登录密码。
6. 双击 **预览并发布.cmd**，完成预览和发布。使用自己的邮箱测试注册、验证、登录，在手机与电脑分别登录后检查同一题的草稿、收藏、错题与关卡进度是否同步。

只把公开Key写入前端是不够的；必须执行SQL里的访问隔离策略。网页不会上传DeepSeek Key、登录令牌、密码或AI连接设置。

## 邮件和免费额度

以[当前官方免费套餐](https://supabase.com/pricing)及项目控制台为准；免费项目有容量、流量和闲置暂停限制。不要启用付费项目或绑定收费服务来完成本流程。

Supabase默认邮件服务有收件范围与速率限制。先用项目所有者自己的邮箱验收；对外开放邮箱注册前，应按[官方SMTP说明](https://supabase.com/docs/guides/auth/auth-smtp)配置适合自己的邮件发送服务。不能因为收到user对象就显示注册后已登录。

## 本地验证（不接触真实账号）

```powershell
python -m unittest discover -s tools -p test_cloud_config.py -v
npm install --prefix .question-import/sql-test-runtime --no-audit --no-fund @electric-sql/pglite@0.5.14
node tools/test_cloud_sql.mjs
```

SQL测试在内存中的PostgreSQL环境创建两个虚拟用户，验证匿名用户无权限、A无法读取或修改B、过期版本不能覆盖较新存档及2MB限制。这些测试通过不等同于真实云项目已开通；真实注册与双设备同步仍需要上面的项目配置及上线验收。
