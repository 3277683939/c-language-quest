# 邮箱验证码（已准备，尚未启用）

用户选择以后再配置发信服务。生产环境继续使用原邮件验证链接；未关闭邮箱验证、未修改 SMTP、未开通付费服务。

代码入口：`CQuestAccount.handleEmailCode(form, resend)`。仅当公开配置 `emailCodeEnabled: true` 时显示并接受验证码。邮箱及验证码仅在页面内存中处理；验证码不保存到存档、浏览器存储或 URL。验证完成后丢弃接口返回的会话令牌，继续走现有邮箱密码登录和存档合并流程。

以后启用的顺序：

1. 在 Supabase Authentication → Emails → SMTP Settings 配置可用发信服务。密码或 SMTP 授权码由用户自行输入，不要放进代码、聊天或公开配置。
2. 修改 Confirm sign up 模板，主题用 `C 题库：邮箱验证码`，正文示例：

```html
<h2>C 题库 · 验证邮箱</h2>
<p>请回到 C 题库账户页，输入本次注册的邮箱验证码：</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:bold">{{ .Token }}</p>
<p>无需点击链接。请在有效期内使用最新一封邮件中的验证码。</p>
<p>如果不是你本人申请，请忽略此邮件，不要将验证码提供给他人。</p>
```

3. 用用户授权的测试邮箱验证真实邮件投递及 `/auth/v1/verify` 的 `type: email` 校验；确认账号验证成功。
4. 通过后才在 `overrides/cloud-config.js` 增加 `emailCodeEnabled: true`，构建并发布。切勿在默认模板仍只发送链接时启用验证码提示。

测试：`node tools/test_email_code.cjs`，以及现有账户、存档竞态回归测试。

验证码仍需要手机连通云端认证接口；它解决邮件链接打开的问题，不代表可以解决所有网络连接问题。
