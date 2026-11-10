'use strict';
// Fresh browser and isolated contexts only; never connect to a user's browser/profile.
// No real signups, account changes, or paid calls.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('D:/npm-global/node_modules/playwright'));
}

const root = path.resolve(__dirname, '..');
const previewLoc = path.join(root, '.question-import/preview-location.json');
const build = fs.existsSync(previewLoc)
  ? JSON.parse(fs.readFileSync(previewLoc, 'utf8')).path
  : root;

const overridesDir = path.join(root, 'overrides');
const qaDir = path.join(root, '.question-import/qa');
fs.mkdirSync(qaDir, { recursive: true });

// 本地测试 HTTP 服务器：优先响应 overrides 中的 bug-report.js 和 ui.css，其它回退到 build
const server = http.createServer((req, res) => {
  const reqPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let filePath;

  if (reqPath === '/bug-report.js') {
    filePath = path.join(overridesDir, 'bug-report.js');
  } else if (reqPath === '/ui.css') {
    filePath = path.join(overridesDir, 'ui.css');
  } else {
    const sub = reqPath === '/' ? '/index.html' : reqPath;
    filePath = path.resolve(build, '.' + sub);
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not Found: ' + reqPath);
      return;
    }
    res.setHeader('Content-Type', types[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  });
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    let launchOptions = { headless: true };
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }

    console.log('Testing bug-report UI on ports and mock RPC...');

    for (const width of [390, 430, 1200]) {
      const isMobile = width <= 760;
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile,
        hasTouch: isMobile
      });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      // 仅允许访问本服务，阻断一切外部请求
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin === origin) {
          route.continue();
        } else {
          route.abort();
        }
      });

      await page.goto(origin + '/#map');
      await page.waitForLoadState('domcontentloaded');

      // 确保 bug-report.js 脚本与样式已加载
      await page.waitForSelector('.chapters');
      assert.equal(await page.evaluate(() => typeof CQuestBugReport.open), 'function', 'published bundle includes feedback');
      // Exercise the actual shell and account adapter, replacing only the HTTP
      // endpoint. No production report, credentials, signup or model calls.
      let submitted;
      await page.route('**/rest/v1/rpc/cquest_bug_submit', async route => {
        submitted=route.request().postDataJSON();
        assert.ok(!route.request().headers().authorization);
        assert.equal(submitted.payload.context.viewport.width,width);
        assert.equal(submitted.payload.context.questionId,'n7-1');
        assert.equal(submitted.payload.context.position,1);
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({accepted:true,id:submitted.report_id})});
      });
      await page.evaluate(() => startQuiz([Q.find(q=>q.id==='n7-1'),Q.find(q=>q.id==='n7-2')],'反馈集成测试'));
      await page.locator('#quiz-dialog .option').nth(1).click();
      await page.locator('#submit-answer').click();
      await page.getByRole('button',{name:'反馈此题',exact:true}).click();
      await page.locator('#cquest-bug-desc').fill('手机下一题按钮有时无法点击，请核对。');
      await page.locator('#cquest-bug-submit').click();
      await page.waitForFunction(()=>!document.querySelector('#cquest-bug-dialog').open);
      assert.ok(submitted);
      assert.ok(await page.locator('#quiz-dialog').evaluate(el=>el.open),'feedback preserves the quiz modal');
      await page.getByRole('button',{name:'下一题 →',exact:true}).click();
      assert.ok((await page.locator('#quiz-dialog .quiz-meta').innerText()).includes('02 / 02'));
      await page.locator('#quiz-dialog [aria-label="保存并关闭练习"]').click();
      await page.unroute('**/rest/v1/rpc/cquest_bug_submit');

      // 初始化 Mock RPC 环境
      await page.evaluate(() => {
        window.bugTestState = {
          session: { configured: true, loggedIn: true, admin: true },
          reports: [],
          calls: [],
          mode: 'ok'
        };
        window.CQuestAccount = window.CQuestAccount || {};
        window.CQuestAccount.bugReportSession = () => ({ ...window.bugTestState.session });
        window.CQuestAccount.bugReportRpc = async (action, params = {}) => {
          window.bugTestState.calls.push({ action, params });
          if (window.bugTestState.mode === 'fail') {
            throw new Error('网络连接超时，提交失败。');
          }
          if (action === 'submit') {
            const id = params.reportId || ('mock_' + Math.random().toString(36).slice(2));
            window.bugTestState.reports.unshift({
              id,
              created_at: new Date().toISOString(),
              category: params.category,
              description: params.description,
              context: params.context,
              status: 'open'
            });
            return { accepted: true, id };
          }
          if (action === 'list') {
            return structuredClone(window.bugTestState.reports);
          }
          if (action === 'resolve') {
            const r = window.bugTestState.reports.find(x => x.id === params.reportId);
            if (r) r.status = params.status;
            return { updated: true };
          }
          throw new Error('未知 action: ' + action);
        };
      });

      // 1. 测试 open(context) 与上下文清洗（严禁泄漏敏感属性）
      await page.evaluate(() => {
        window.CQuestBugReport.open({
          page: 'practice',
          mode: 'exam',
          questionId: 'q-998',
          position: 5,
          userEmail: 'leak@test.com',
          secretToken: 'secret_token_123',
          fullUrl: 'http://test.com/private/user',
          answers: ['A', 'C'],
          draftText: 'user confidential draft'
        });
      });

      const dialogLocator = page.locator('#cquest-bug-dialog');
      await dialogLocator.waitFor({ state: 'visible' });
      assert.equal(await dialogLocator.evaluate(el => el.open), true, 'dialog should be open via showModal');

      // 检查 context 预览不含任何敏感词
      const previewText = await page.locator('#cquest-bug-ctx-preview').innerText();
      assert.ok(previewText.includes('practice'), 'context preview includes page');
      assert.ok(previewText.includes('q-998'), 'context preview includes questionId');
      assert.ok(!previewText.includes('leak@test.com'), 'context does not leak email');
      assert.ok(!previewText.includes('secret_token'), 'context does not leak token');
      assert.ok(!previewText.includes('confidential draft'), 'context does not leak drafts');

      // 2. 表单验证：问题描述 10~2000 字
      const submitBtn = page.locator('#cquest-bug-submit');
      const descInput = page.locator('#cquest-bug-desc');
      const catSelect = page.locator('#cquest-bug-category');

      assert.equal(await submitBtn.isDisabled(), true, 'submit disabled when empty');

      await descInput.fill('短于十');
      assert.equal(await submitBtn.isDisabled(), true, 'submit disabled when < 10 chars');

      await descInput.fill('这是一个测试反馈描述内容，超过十个字。');
      assert.equal(await submitBtn.isDisabled(), false, 'submit enabled when >= 10 chars');

      // 3. 验证独立草稿键 cquest-bug-draft-v1（不含 context）
      const draftJson = await page.evaluate(() => localStorage.getItem('cquest-bug-draft-v1'));
      assert.ok(draftJson, 'draft is saved to cquest-bug-draft-v1');
      const draftObj = JSON.parse(draftJson);
      assert.equal(draftObj.description, '这是一个测试反馈描述内容，超过十个字。');
      assert.equal(draftObj.context, undefined, 'draft must NOT save context');
      assert.ok(draftObj.reportId, 'draft contains reportId');

      // 4. 测试“复制反馈文本”按钮
      await page.locator('#cquest-bug-copy').click();
      await page.waitForFunction(() => {
        const text = document.querySelector('#cquest-bug-status')?.textContent || '';
        return text.includes('复制');
      });
      const statusText = await page.locator('#cquest-bug-status').innerText();
      assert.ok(statusText.includes('已复制') || statusText.includes('复制'), 'copy feedback triggers status');

      // 5. 验证触控尺寸与无横向溢出
      const submitBox = await submitBtn.boundingBox();
      assert.ok(submitBox.height >= 43.5, `submit button height >= 44px (got ${submitBox.height})`);
      const isOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(isOverflow, false, `${width}px: no horizontal overflow in dialog`);

      // 截图 1: 反馈弹窗
      await page.screenshot({ path: path.join(qaDir, `bug-report-${width}.png`) });

      // 6. 提交反馈并验证草稿被成功清除
      await submitBtn.click();
      await page.waitForFunction(() => !localStorage.getItem('cquest-bug-draft-v1'));
      assert.equal(await page.evaluate(() => localStorage.getItem('cquest-bug-draft-v1')), null, 'draft cleared after success');

      // 检查 RPC 调用参数
      const submitCalls = await page.evaluate(() => window.bugTestState.calls.filter(c => c.action === 'submit'));
      assert.equal(submitCalls.length, 1);
      const submitParams = submitCalls[0].params;
      assert.equal(submitParams.description, '这是一个测试反馈描述内容，超过十个字。');
      assert.equal(submitParams.context.page, 'practice');
      assert.equal(submitParams.context.questionId, 'q-998');
      assert.deepEqual(submitParams.context.viewport,{width,height:844});
      assert.equal(typeof submitParams.context.position,'number');
      assert.equal(submitParams.context.secretToken, undefined, 'submitted context has no leak');

      // 等待弹窗自动关闭
      await page.waitForFunction(() => !document.getElementById('cquest-bug-dialog')?.open);

      // 7. 测试失败保留草稿及 reportId 沿用防重复
      await page.evaluate(() => {
        window.bugTestState.mode = 'fail';
        window.CQuestBugReport.open({ page: 'quiz' });
      });
      await descInput.fill('网络失败测试反馈描述内容');
      const savedReportId = await page.evaluate(() => {
        const d = JSON.parse(localStorage.getItem('cquest-bug-draft-v1'));
        return d.reportId;
      });
      await submitBtn.click();
      // 等待错误提示显示
      await page.waitForFunction(() => document.querySelector('#cquest-bug-status')?.textContent.includes('失败'));
      // 确认草稿保留且 reportId 一致
      const currentDraft = await page.evaluate(() => JSON.parse(localStorage.getItem('cquest-bug-draft-v1')));
      assert.equal(currentDraft.reportId, savedReportId, 'reportId preserved on failure for retry');
      assert.equal(currentDraft.description, '网络失败测试反馈描述内容', 'draft preserved on failure');

      // 关闭弹窗
      await page.locator('.cquest-bug-close').click();

      // 8. 测试 renderAdmin() 管理页
      // A. 非管理员禁止请求 list
      await page.evaluate(() => {
        window.bugTestState.session.admin = false;
        window.bugTestState.calls = [];
        window.CQuestBugReport.renderAdmin();
      });
      await page.locator('#feedback-admin-content').waitFor();
      const noAdminText = await page.locator('#feedback-admin-content').innerText();
      assert.ok(noAdminText.includes('无管理权限') || noAdminText.includes('管理员可见'));
      const listCallsNotAdmin = await page.evaluate(() => window.bugTestState.calls.filter(c => c.action === 'list'));
      assert.equal(listCallsNotAdmin.length, 0, 'non-admin must not request list RPC');

      // B. 管理员展示列表与 XSS 防御测试
      await page.evaluate(() => {
        window.bugTestState.session.admin = true;
        window.bugTestState.mode = 'ok';
        window.bugTestState.reports = [
          {
            id: 'rep_1',
            created_at: new Date(Date.now() - 3600000).toISOString(),
            category: '题目内容',
            description: '第 5 题的指针讲解有笔误 <img src=x onerror="window.xssInjected=true">',
            context: { page: 'quiz', questionId: '5', browser: 'Edge' },
            status: 'open'
          },
          {
            id: 'rep_2',
            created_at: new Date().toISOString(),
            category: '按钮',
            description: '提交按钮点击后无反应',
            context: { page: 'account', browser: 'Chrome' },
            status: 'resolved'
          }
        ];
        window.CQuestBugReport.renderAdmin();
      });

      await page.locator('.feedback-item-card').first().waitFor();
      // XSS 验证：页面不得注入 img 标签
      const imgCount = await page.locator('.feedback-item-desc img').count();
      assert.equal(imgCount, 0, 'description must not inject img element (XSS prevention)');
      const xssInjected = await page.evaluate(() => window.xssInjected);
      assert.equal(xssInjected, undefined, 'no XSS script execution');

      // C. 状态切换：标记已解决
      const openCard = page.locator('.feedback-item-open');
      const resolveBtn = openCard.locator('.feedback-resolve-btn');
      assert.equal(await resolveBtn.innerText(), '标记已解决');
      await resolveBtn.click();
      await page.waitForFunction(() => document.querySelector('.feedback-admin-msg')?.textContent.includes('解决'));

      // 截图 2: 管理端页面
      await page.screenshot({ path: path.join(qaDir, `bug-report-admin-${width}.png`) });

      // 检查移动端无横向溢出
      const adminOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(adminOverflow, false, `${width}px: no horizontal overflow on admin page`);

      assert.deepEqual(pageErrors, []);
      await context.close();
      console.log(`PASS ${width}px: dialog open/close, draft retention/clear, sanitized context, touch target >= 44px, no overflow, admin list, safe escaping, resolve toggle`);
    }

    console.log('ALL TESTS PASSED SUCCESSFULLY.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
