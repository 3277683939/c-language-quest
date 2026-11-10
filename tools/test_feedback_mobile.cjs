'use strict';
// 手机反馈（域 4）回归测试：全新浏览器上下文，仅访问本地构建预览，绝不连接真实浏览器资料目录。
// 不真实注册、不发邮件、不调用付费模型；所有云 RPC 由本地路由桩接管，绝不触达线上 Supabase。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('D:/npm-global/node_modules/playwright')); }

const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'), 'utf8')).path;

// 华为 Mate 40 Pro 微信 WebView（模拟 UA，仅兼容性模拟，不代表真机验收）
const WECHAT_UA = 'Mozilla/5.0 (Linux; Android 12; HUAWEI Mate 40 Pro; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36 MMWEBID/1234 MicroMessenger/8.0.49.2600(0x28003133) Process/tools WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(build, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(build + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

const results = { pass: 0, fail: 0, errors: [] };
function ok(cond, message) {
  if (cond) { results.pass++; return; }
  results.fail++;
  results.errors.push(message);
  throw new Error(message);
}

function makeStub() {
  return {
    mode: 'ok',
    calls: [],
    list: [],
    submits: []
  };
}

async function newPage(context, origin, stub) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    // 云 RPC 由本地桩接管（可能是 supabase 跨域地址），永不触达真实服务；
    // 其它跨域请求一律阻断，保证测试隔离。
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const action = url.pathname.split('/').pop();
      const body = route.request().postDataJSON() || {};
      stub.calls.push({ action, body, headers: route.request().headers() });
      if (action === 'cquest_bug_submit') stub.submits.push(body);
      if (stub.mode === 'offline') { await route.abort('failed'); return; }
      if (stub.mode === 'timeout') {
        await new Promise(r => setTimeout(r, 200));
        await route.abort('timedout');
        return;
      }
      if (stub.mode === '429') {
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'PT429', message: 'rate limited' }) });
        return;
      }
      if (stub.mode === '500') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'boom' }) });
        return;
      }
      if (action === 'cquest_bug_submit') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, id: body.report_id }) });
        return;
      }
      if (action === 'cquest_bug_list') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub.list) });
        return;
      }
      if (action === 'cquest_bug_resolve') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    if (url.origin !== origin) { return route.abort(); }
    return route.continue();
  });
  return { page, errors };
}

async function gotoMap(page, origin) {
  await page.goto(origin + '/#map');
  await page.locator('.chapters').waitFor();
  await page.waitForFunction(() => typeof CQuestBugReport?.open === 'function');
}

const BUG_DIALOG = '#cquest-bug-dialog';

async function dialogOpen(page) {
  await page.waitForFunction(sel => { const d = document.querySelector(sel); return d && d.open; }, BUG_DIALOG);
}

async function dialogClosed(page) {
  await page.waitForFunction(sel => { const d = document.querySelector(sel); return !d || !d.open; }, BUG_DIALOG);
}

async function geometry(page) {
  return page.evaluate(sel => {
    const d = document.querySelector(sel);
    const r = d.getBoundingClientRect();
    return {
      left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      innerWidth, innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      dialogScrollWidth: d.scrollWidth, dialogClientWidth: d.clientWidth,
      dialogScrollHeight: d.scrollHeight, dialogClientHeight: d.clientHeight
    };
  }, BUG_DIALOG);
}

async function tapTargetSizes(page, selector) {
  return page.evaluate(sel => {
    const d = document.querySelector(sel);
    const out = [];
    d.querySelectorAll('button, input[type="radio"], input[type="checkbox"]').forEach(el => {
      // 复选框/单选框的有效触控区是其 <label> 包裹行
      const target = (el.type === 'checkbox' || el.type === 'radio') ? (el.closest('label') || el) : el;
      const r = target.getBoundingClientRect();
      out.push({ id: el.id || el.className || el.tagName, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 });
    });
    return out;
  }, selector);
}

async function openFromFooter(page) {
  await page.locator('footer.page-footer button', { hasText: '反馈问题' }).click();
  await dialogOpen(page);
}

async function fillValid(page, text) {
  await page.locator('#cquest-bug-desc').fill(text);
  await page.waitForFunction(() => !document.querySelector('#cquest-bug-submit').disabled);
}

async function submit(page) {
  await page.locator('#cquest-bug-submit').click();
}

async function testLayout(page, width, errors) {
  await gotoMap(page, page.__origin);
  assert.deepEqual(errors, [], `${width}: 页面加载不应有 JS 错误`);

  await openFromFooter(page);
  const g = await geometry(page);
  ok(g.left >= -1 && g.right <= g.innerWidth + 1, `${width}: 反馈弹窗不应横向溢出 (${g.left}..${g.right} vs ${g.innerWidth})`);
  ok(g.top >= -1 && g.bottom <= g.innerHeight + 1, `${width}: 反馈弹窗不应纵向超出可视区 (${g.top}..${g.bottom} vs ${g.innerHeight})`);
  ok(g.dialogScrollWidth <= g.dialogClientWidth + 1, `${width}: 弹窗内部不应横向滚动`);
  ok(g.docScrollWidth <= g.docClientWidth + 1, `${width}: 打开弹窗后页面不应横向溢出`);

  const targets = await tapTargetSizes(page, BUG_DIALOG);
  // 允许 0.5px 内的亚像素舍入（44px → 43.99994 属正常布局舍入）
  const tooSmall = targets.filter(t => t.visible && width <= 760 && (t.h < 43.5 || t.w < 43.5));
  ok(tooSmall.length === 0, `${width}: 触控目标需≥44px，过小: ${JSON.stringify(tooSmall)}`);

  // 长描述：1900 字 + 超长不可断 token
  const longText = '长描述测试：' + '很长的中文描述内容，用来验证文字换行与滚动。'.repeat(60) + ' ' + 'A'.repeat(160);
  await fillValid(page, longText);
  const g2 = await geometry(page);
  ok(g2.dialogScrollWidth <= g2.dialogClientWidth + 1, `${width}: 长描述不应导致弹窗横向溢出`);
  await page.locator('#cquest-bug-desc').evaluate(el => el.scrollIntoView({ block: 'center' }));
  const submitVisible = await page.locator('#cquest-bug-submit').isVisible();
  ok(submitVisible, `${width}: 长描述时提交按钮仍在 DOM 可见`);
  // 弹窗内部可以滚动到提交区
  await page.evaluate(sel => { const d = document.querySelector(sel); d.scrollTop = d.scrollHeight; }, BUG_DIALOG);
  const submitRect = await page.locator('#cquest-bug-submit').evaluate(el => el.getBoundingClientRect().toJSON());
  ok(submitRect.bottom <= 844 + 1, `${width}: 滚动到底后提交按钮应进入可视区`);

  // 微信字体放大模拟：把弹窗内文本字号整体放大 1.4 倍（Android WebView 字体缩放近似）
  await page.evaluate(sel => {
    window.__fontBackup = [];
    document.querySelectorAll(sel + ' *').forEach(el => {
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > 0 && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
        window.__fontBackup.push([el, el.style.fontSize]);
        el.style.fontSize = (size * 1.4).toFixed(1) + 'px';
      }
    });
  }, BUG_DIALOG);
  const g3 = await geometry(page);
  ok(g3.dialogScrollWidth <= g3.dialogClientWidth + 1, `${width}: 字体放大 1.4x 后弹窗不应横向溢出`);
  ok(g3.right <= g3.innerWidth + 1, `${width}: 字体放大后弹窗仍在视口内`);
  const bigTargets = await tapTargetSizes(page, BUG_DIALOG);
  const small2 = bigTargets.filter(t => t.visible && width <= 760 && (t.h < 44 || t.w < 44));
  ok(small2.length === 0, `${width}: 字体放大后触控目标仍需≥44px，过小: ${JSON.stringify(small2)}`);
  // 还原字体，避免影响后续用例
  await page.evaluate(() => { (window.__fontBackup || []).forEach(([el, v]) => { el.style.fontSize = v; }); window.__fontBackup = []; });

  // 关闭（取消）不应提交
  const before = stubCount(page);
  await page.locator('#cquest-bug-cancel').click();
  await dialogClosed(page);
  ok(stubCount(page) === before, `${width}: 取消不应发起提交`);

  // 背景滚动锁定 + 关闭后位置恢复（遮罩上滚轮/惯性滚动不得带动页面）
  if (width > 760) {
    // 桌面端不启用移动端滚动锁（原生 dialog + 遮罩已足够），只验证不会误加锁
    await page.evaluate(() => CQuestBugReport.open(getBugReportContext()));
    await dialogOpen(page);
    ok(!(await page.evaluate(() => document.body.classList.contains('dialog-scroll-locked'))), `${width}: 桌面端不应启用移动端滚动锁`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('#cquest-bug-cancel').click();
    await dialogClosed(page);
    return;
  }
  await page.evaluate(() => scrollTo(0, 260));
  const y0 = await page.evaluate(() => scrollY);
  if (y0 > 0) {
    await page.evaluate(() => CQuestBugReport.open(getBugReportContext()));
    await dialogOpen(page);
    await page.mouse.move(6, 6); // 遮罩区域
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(250);
    const locked = await page.evaluate(() => ({
      cls: document.body.classList.contains('dialog-scroll-locked'),
      y: scrollY,
    }));
    ok(locked.cls, `${width}: 弹窗打开时应锁定背景滚动（body.dialog-scroll-locked）`);
    ok(Math.abs(locked.y) <= 1, `${width}: 弹窗打开期间背景不应滚动，实际 scrollY=${locked.y}`);
    await page.locator('#cquest-bug-cancel').click();
    await dialogClosed(page);
    await page.waitForTimeout(120);
    const restored = await page.evaluate(() => ({ y: scrollY, cls: document.body.classList.contains('dialog-scroll-locked') }));
    ok(Math.abs(restored.y - y0) <= 2, `${width}: 关闭弹窗后应恢复原滚动位置 ${y0}，实际 ${restored.y}`);
    ok(!restored.cls, `${width}: 关闭弹窗后应解除滚动锁`);
  }
}

function stubCount(page) { return page.__stub.calls.filter(c => c.action === 'cquest_bug_submit').length; }

async function testKeyboard(page, width) {
  await gotoMap(page, page.__origin);
  await openFromFooter(page);
  await page.locator('#cquest-bug-desc').click();
  await fillValid(page, '键盘遮挡测试：聚焦输入框后模拟软键盘弹出导致可视高度收缩。');
  // 模拟软键盘：可视高度收缩到 420px（Android 微信键盘约占 300~340px）
  await page.setViewportSize({ width, height: 420 });
  const g = await geometry(page);
  ok(g.height <= 420 + 1, `键盘弹出：弹窗高度应适配收缩后的可视区 (${g.height})`);
  ok(g.bottom <= 420 + 1, `键盘弹出：弹窗底部不应超出可视区 (${g.bottom})`);
  await page.evaluate(sel => { const d = document.querySelector(sel); d.scrollTop = d.scrollHeight; }, BUG_DIALOG);
  const sb = await page.locator('#cquest-bug-submit').evaluate(el => el.getBoundingClientRect().toJSON());
  ok(sb.bottom <= 420 + 1 && sb.height >= 44, `键盘弹出：滚动后提交按钮应可见且≥44px (bottom=${sb.bottom}, h=${sb.height})`);
  await page.setViewportSize({ width, height: 844 });
  await page.locator('#cquest-bug-cancel').click();
  await dialogClosed(page);
}

async function testNestedQuiz(page, width) {
  await gotoMap(page, page.__origin);
  await page.evaluate(() => startQuiz([Q.find(q => q.id === 'n7-1'), Q.find(q => q.id === 'n7-2')], '反馈嵌套测试'));
  const qid = await page.evaluate(() => currentQ().id);
  await page.locator('#quiz-dialog .option').nth(1).click();
  await page.locator('#submit-answer').click();
  await page.locator('#quiz-dialog .feedback').waitFor();

  // 从做题弹窗内打开反馈
  await page.locator('#quiz-dialog .text-button', { hasText: '反馈此题' }).click();
  await dialogOpen(page);
  ok(await page.locator('#quiz-dialog').evaluate(el => el.open), `${width}: 打开反馈后做题弹窗仍应保持`);

  const previewText = await page.locator('#cquest-bug-ctx-preview').innerText();
  ok(previewText.includes('题号: ' + qid), `${width}: 反馈上下文题号应为 ${qid}，实际: ${previewText}`);
  ok(previewText.includes('位置: 1'), `${width}: 反馈上下文位置应为 1，实际: ${previewText}`);
  ok(previewText.includes('屏幕: ' + width + '×'), `${width}: 反馈上下文屏幕宽度应为 ${width}，实际: ${previewText}`);
  ok(previewText.includes('模式: choice'), `${width}: 反馈上下文模式应为 choice，实际: ${previewText}`);

  // 弹窗层级：反馈弹窗最后 showModal，应位于最上层（top layer 顺序）
  const order = await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(d => d.id));
  ok(order[order.length - 1] === 'cquest-bug-dialog', `${width}: 反馈弹窗应位于最上层，实际顺序: ${order.join(',')}`);

  await fillValid(page, '做题时反馈：下一题按钮在长解析展开后偶尔点不动，请核对。');
  await page.locator('#cquest-bug-submit').click();
  await dialogClosed(page);

  const captured = page.__stub.submits[page.__stub.submits.length - 1];
  ok(captured && captured.payload.context.questionId === qid, `${width}: 提交的题号应为 ${qid}`);
  ok(captured.payload.context.position === 1, `${width}: 提交的位置应为 1`);
  ok(captured.payload.context.mode === 'choice', `${width}: 提交模式应为 choice`);
  ok(captured.payload.context.viewport.width === width, `${width}: 提交视口宽度应为 ${width}`);

  ok(await page.locator('#quiz-dialog').evaluate(el => el.open), `${width}: 关闭反馈后应回到做题弹窗`);
  const after = await page.evaluate(() => ({ id: currentQ().id, index: quiz.index }));
  ok(after.id === qid && after.index === 0, `${width}: 关闭反馈后应停留在原题原进度 (${JSON.stringify(after)})`);
  ok(await page.locator('#quiz-dialog .feedback').isVisible(), `${width}: 原作答反馈应保留`);
  ok(await page.locator('#quiz-dialog .option.selected, #quiz-dialog .option.correct, #quiz-dialog .option.incorrect').count() > 0,
    `${width}: 原选择状态应保留`);

  // ESC 关闭反馈后仍可继续做题
  await page.locator('#quiz-dialog .text-button', { hasText: '反馈此题' }).click();
  await dialogOpen(page);
  await page.keyboard.press('Escape');
  await dialogClosed(page);
  ok(await page.locator('#quiz-dialog').evaluate(el => el.open), `${width}: ESC 关闭反馈后做题弹窗应保持`);
  await page.getByRole('button', { name: '下一题 →', exact: true }).click();
  const meta = await page.locator('#quiz-dialog .quiz-meta').innerText();
  ok(meta.includes('02 / 02'), `${width}: ESC 后仍可正常下一题，实际: ${meta}`);
  await page.locator('#quiz-dialog [aria-label="保存并关闭练习"]').click();
  await page.waitForFunction(() => !document.querySelector('#quiz-dialog').open);
}

async function testDraftOfflineDedupe(page, width) {
  await gotoMap(page, page.__origin);
  // 同一页面里更早的用例也提交过反馈，这里以用例开始时的计数为基线
  const baseSubmits = page.__stub.calls.filter(c => c.action === 'cquest_bug_submit').length;
  const submitCallsSince = () => page.__stub.calls.filter(c => c.action === 'cquest_bug_submit').slice(baseSubmits);
  page.__stub.mode = 'offline';
  await openFromFooter(page);
  const text = '断网提交测试：地铁里提交反馈失败，草稿应保留并可手动重试。';
  await fillValid(page, text);
  await submit(page);
  await page.waitForFunction(() => /无法|失败|保留/.test(document.querySelector('#cquest-bug-status').textContent));
  ok((await page.locator('#cquest-bug-desc').inputValue()) === text, `${width}: 网络失败后应保留描述草稿`);
  ok((await page.locator('#cquest-bug-status').innerText()).includes('无法'), `${width}: 应提示网络无法发送，实际: ${await page.locator('#cquest-bug-status').innerText()}`);
  const submitCalls = submitCallsSince();
  ok(submitCalls.length === 1, `${width}: 失败后不应自动重试，实际请求 ${submitCalls.length} 次: ${JSON.stringify(submitCalls.map(c => ({ action: c.action, id: c.body.report_id, desc: String(c.body.description || '').slice(0, 16) })))}`);
  const firstId = submitCalls[0].body.report_id;
  await page.waitForTimeout(1200);
  ok(submitCallsSince().length === 1, `${width}: 1.2s 后仍不应自动重试，实际 ${submitCallsSince().length} 次`);

  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('cquest-bug-draft-v1') || 'null'));
  ok(draft && draft.description === text, `${width}: 本地应保留反馈草稿`);

  // 手动重试：同一 reportId 去重
  await submit(page);
  const calls2 = submitCallsSince();
  ok(calls2.length === 2, `${width}: 手动重试应只再发一次，实际 ${calls2.length}`);
  ok(calls2[1].body.report_id === firstId, `${width}: 重试应沿用同一 reportId 去重 (${firstId} vs ${calls2[1].body.report_id})`);

  // 刷新后草稿恢复
  await page.reload();
  await page.locator('.chapters').waitFor();
  await openFromFooter(page);
  ok((await page.locator('#cquest-bug-desc').inputValue()) === text, `${width}: 刷新后应恢复反馈草稿`);
  ok((await page.evaluate(() => JSON.parse(localStorage.getItem('cquest-bug-draft-v1')).reportId)) === firstId, `${width}: 刷新后应沿用原 reportId`);

  // 429 限制提示
  page.__stub.mode = '429';
  await page.locator('#cquest-bug-desc').fill(text + '（限流测试）');
  await page.waitForFunction(() => !document.querySelector('#cquest-bug-submit').disabled);
  await submit(page);
  await page.waitForFunction(() => /频繁|稍后|保留/.test(document.querySelector('#cquest-bug-status').textContent));
  const status429 = await page.locator('#cquest-bug-status').innerText();
  ok(/频繁|稍后|保留/.test(status429), `${width}: 429 应给出稍后再试且保留内容的提示，实际: ${status429}`);
  ok((await page.locator('#cquest-bug-desc').inputValue()).includes('限流测试'), `${width}: 429 后应保留草稿`);

  // 成功提交：草稿清空，弹窗关闭
  page.__stub.mode = 'ok';
  await submit(page);
  await dialogClosed(page);
  const draftAfter = await page.evaluate(() => localStorage.getItem('cquest-bug-draft-v1'));
  ok(!draftAfter || draftAfter === 'null', `${width}: 成功提交后应清除草稿，实际: ${draftAfter}`);
}

async function testCopyAndConsent(page, width) {
  await gotoMap(page, page.__origin);
  await openFromFooter(page);
  await fillValid(page, '复制反馈测试：应只包含类别、描述与用户同意的环境信息。');
  await page.locator('#cquest-bug-copy').click();
  // 复制是异步 clipboard 调用，等待状态文本出现
  await page.waitForFunction(() => {
    const s = document.querySelector('#cquest-bug-status');
    return s && /已复制|复制失败/.test(s.textContent);
  }, null, { timeout: 5000 }).catch(() => {});
  const status = await page.locator('#cquest-bug-status').innerText();
  ok(/已复制|复制失败/.test(status), `${width}: 复制按钮应给出结果提示，实际: ${status}`);
  let copied = '';
  try {
    copied = await page.evaluate(() => navigator.clipboard.readText());
  } catch {}
  if (copied) {
    ok(copied.includes('【C语言闯关营 反馈】'), `${width}: 复制文本应包含标题`);
    ok(copied.includes('复制反馈测试'), `${width}: 复制文本应包含描述`);
    ok(!/password|token|eyJ/i.test(copied), `${width}: 复制文本不得包含密码/Token`);
    ok(copied.includes('页面: map'), `${width}: 复制文本应包含用户同意的页面信息`);
  }

  // 取消“附带环境信息”后，不应发送 context
  const beforeSubmits = page.__stub.submits.length;
  await page.locator('#cquest-bug-attach-ctx').uncheck();
  ok(!(await page.locator('#cquest-bug-ctx-preview').isVisible()), `${width}: 取消勾选后不应显示附带信息预览`);
  await submit(page);
  await dialogClosed(page);
  const last = page.__stub.submits[page.__stub.submits.length - 1];
  ok(page.__stub.submits.length === beforeSubmits + 1, `${width}: 应提交一次`);
  ok(last && (!last.payload.context || Object.keys(last.payload.context).length === 0),
    `${width}: 未同意时不应附带任何环境字段，实际: ${JSON.stringify(last?.payload?.context)}`);
  ok(Object.keys(last.payload).sort().join(',') === 'category,context,description', `${width}: 提交体只应含 category/description/context，实际: ${Object.keys(last.payload)}`);
}

async function testPracticeContext(page, width) {
  await gotoMap(page, page.__origin);
  const unitId = await page.evaluate(() => {
    const levels = allLevels();
    const l = levels.find(x => x.type === 'practice' && Array.isArray(x.questions) && x.questions.length);
    if (!l) return null;
    startPracticeLevel(l);
    return l.questions[0].id;
  });
  if (!unitId) { console.log(`SKIP ${width}: 没有可用的自练关卡`); return; }
  await page.locator('#quiz-dialog .text-button', { hasText: '反馈此题' }).first().click();
  await dialogOpen(page);
  const previewText = await page.locator('#cquest-bug-ctx-preview').innerText();
  ok(previewText.includes('模式: practice'), `${width}: 自练反馈模式应为 practice，实际: ${previewText}`);
  // 预览给用户看的题号保留原始 id（自练 id 含中文）
  ok(previewText.includes('题号: ' + unitId), `${width}: 自练反馈题号应为 ${unitId}，实际: ${previewText}`);
  ok(previewText.includes('位置: 1'), `${width}: 自练反馈位置应为 1，实际: ${previewText}`);
  // 提交给云端的 questionId 必须是白名单可接受的 ASCII（非 ASCII 字符编码为 _<hex>）
  await fillValid(page, '自练题目反馈测试：提交后应带上当前自练题号与位置。');
  await submit(page);
  await dialogClosed(page);
  const last = page.__stub.submits[page.__stub.submits.length - 1];
  const sentCtx = last?.payload?.context || {};
  ok(sentCtx.mode === 'practice', `${width}: 提交上下文 mode 应为 practice，实际 ${JSON.stringify(sentCtx)}`);
  ok(sentCtx.position === 1, `${width}: 提交上下文 position 应为 1，实际 ${sentCtx.position}`);
  ok(/^[A-Za-z0-9:_-]{1,100}$/.test(sentCtx.questionId || ''),
    `${width}: 云端 questionId 必须匹配白名单 ^[A-Za-z0-9:_-]{1,100}$，实际 ${sentCtx.questionId}`);
  ok(decodeQuestionId(sentCtx.questionId) === unitId,
    `${width}: 编码后的 questionId 应可还原为原始题号 ${unitId}，实际 ${decodeQuestionId(sentCtx.questionId)}`);
  await page.evaluate(() => closeQuiz());
}

// 还原 bug-report.js encodeQuestionId：_<hex> -> 码点
function decodeQuestionId(encoded) {
  return String(encoded || '').replace(/_([0-9a-f]+)/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

async function testMoreEntry(page, width) {
  await gotoMap(page, page.__origin);
  if (width <= 760) {
    await page.locator('.nav-more').click();
    await page.waitForFunction(() => document.querySelector('#more-dialog').open);
    await page.locator('#more-dialog button', { hasText: '反馈问题' }).click();
    await dialogOpen(page);
    ok(await page.locator('#more-dialog').evaluate(el => !el.open), `${width}: 从“更多”打开反馈后更多菜单应关闭`);
    ok((await page.evaluate(() => location.hash)) === '#map', `${width}: 打开反馈不应改变路由，实际: ${await page.evaluate(() => location.hash)}`);
  } else {
    // 桌面端没有底部“更多”入口，用页脚反馈按钮验证同一条路径
    await page.locator('.page-footer button', { hasText: '反馈问题' }).click();
    await dialogOpen(page);
  }
  await page.locator('#cquest-bug-cancel').click();
  await dialogClosed(page);
  ok(await page.locator('.chapters').isVisible(), `${width}: 关闭反馈后应回到闯关地图`);
}

async function testAdmin(page, width) {
  await page.goto(page.__origin + '/#map');
  await page.locator('.chapters').waitFor();
  const longToken = 'https://example.com/' + 'x'.repeat(220);
  await page.evaluate(token => {
    window.__xss = false;
    window.CQuestAccount.bugReportSession = () => ({ configured: true, loggedIn: true, admin: true });
    window.__listCalls = 0;
    const items = [
      { id: '11111111-1111-1111-1111-111111111111', created_at: '2026-01-02T03:04:05Z', category: '按钮', description: '<img src=x onerror="window.__xss=true"> 下一题按钮点不动 ' + token, context: { page: 'map', questionId: 'n7-1', position: 1, viewport: { width: 360, height: 640 }, browser: 'WeChat' }, status: 'open' },
      { id: '22222222-2222-2222-2222-222222222222', created_at: '2026-01-03T03:04:05Z', category: '显示', description: '反馈弹窗在华为手机上被键盘遮挡。', context: { page: 'map' }, status: 'resolved' }
    ];
    window.CQuestAccount.bugReportRpc = async (action, params = {}) => {
      if (action === 'list') { window.__listCalls++; return items; }
      if (action === 'resolve') { window.__resolveCall = params; return { updated: true }; }
      throw new Error('unexpected action ' + action);
    };
  }, longToken);
  await page.evaluate(() => { location.hash = '#feedback'; });
  await page.locator('.feedback-items-list').waitFor();
  ok(await page.locator('.feedback-item-card').count() === 2, `${width}: 管理员应看到 2 条反馈`);
  ok(!(await page.evaluate(() => window.__xss)), `${width}: 反馈列表不得执行描述中的 XSS`);
  await page.waitForTimeout(150);
  ok(!(await page.evaluate(() => window.__xss)), `${width}: 延迟后 XSS 仍不得执行`);
  // 列表按时间倒序，带 XSS 的条目未必是第一条，改为在所有卡片文本中查找
  const cardTexts = await page.locator('.feedback-item-card').allInnerTexts();
  ok(cardTexts.some(t => t.includes('<img src=x')), `${width}: 应把 HTML 当作文本显示，实际: ${cardTexts.join(' | ').slice(0, 160)}`);
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth
  }));
  ok(overflow.doc <= overflow.client + 1, `${width}: 管理员列表长 token 不应横向溢出 (${overflow.doc} > ${overflow.client})`);
  // 列表按时间倒序，第一条可能是已解决项；对“待处理”的那条执行解决，才能断言 status=resolved
  const openCard = page.locator('.feedback-item-card').filter({ hasText: '<img src=x' });
  const resolveBtn = openCard.locator('.feedback-resolve-btn');
  await resolveBtn.waitFor({ timeout: 8000 });
  const rb = await resolveBtn.evaluate(el => el.getBoundingClientRect().toJSON());
  ok(rb.height >= 43.5, `${width}: 解决按钮触控高度应≥44px，实际 ${rb.height}`);
  await resolveBtn.click();
  await page.waitForFunction(() => !!window.__resolveCall);
  const resolveCall = await page.evaluate(() => window.__resolveCall);
  ok(resolveCall && resolveCall.status === 'resolved', `${width}: 解决操作应传 status=resolved，实际 ${JSON.stringify(resolveCall)}`);
  // 筛选：解决之后两条都已解决，待处理应为空
  await page.locator('input[name="fb-filter"][value="resolved"]').check();
  await page.waitForFunction(() => document.querySelectorAll('.feedback-item-card').length === 2, null, { timeout: 8000 }).catch(() => {});
  ok(await page.locator('.feedback-item-card').count() === 2, `${width}: 筛选已解决应有 2 条，实际 ${await page.locator('.feedback-item-card').count()}`);
  await page.locator('input[name="fb-filter"][value="open"]').check();
  await page.waitForFunction(() => document.querySelectorAll('.feedback-item-card').length === 0, null, { timeout: 8000 }).catch(() => {});
  ok(await page.locator('.feedback-item-card').count() === 0, `${width}: 全部解决后筛选待处理应为空，实际 ${await page.locator('.feedback-item-card').count()}`);
  ok(await page.locator('.rank-empty').count() >= 1, `${width}: 待处理为空时应显示占位说明`);
}

async function testAdminPermission(page, width) {
  await page.goto(page.__origin + '/#map');
  await page.locator('.chapters').waitFor();
  // 普通登录用户
  await page.evaluate(() => {
    window.__listCalls = 0;
    window.CQuestAccount.bugReportRpc = async action => {
      if (action === 'list') window.__listCalls++;
      throw new Error('只有站点管理员能查看和处理反馈。');
    };
    window.CQuestAccount.bugReportSession = () => ({ configured: true, loggedIn: true, admin: false });
  });
  await page.evaluate(() => { location.hash = '#feedback'; });
  await page.locator('.rank-empty').waitFor();
  const text = await page.locator('#app').innerText();
  ok(text.includes('无管理权限'), `${width}: 普通用户应看到无权限提示，实际: ${text.slice(0, 80)}`);
  ok(!(await page.locator('.feedback-items-list').count()), `${width}: 普通用户不得渲染反馈列表`);
  ok((await page.evaluate(() => window.__listCalls)) === 0, `${width}: 普通用户不应请求反馈列表`);

  // 直接调用 RPC 也必须在客户端先被拒绝（服务端另有 RLS 校验）
  const denied = await page.evaluate(async () => {
    try { await window.CQuestAccount.bugReportRpc('list', {}); return null; } catch (e) { return e.message; }
  });
  ok(denied === null || /管理员/.test(denied), `${width}: 普通用户直接调用列表应被拒绝`);

  // 未登录
  await page.evaluate(() => { window.CQuestAccount.bugReportSession = () => ({ configured: true, loggedIn: false, admin: false }); });
  await page.evaluate(() => { location.hash = '#map'; });
  await page.locator('.chapters').waitFor();
  await page.evaluate(() => { location.hash = '#feedback'; });
  await page.locator('.rank-empty').waitFor();
  ok((await page.locator('#app').innerText()).includes('需要登录'), `${width}: 未登录应提示登录`);
}

async function testViewport(browser, origin, width, height) {
  const isMobile = width <= 760;
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile,
    hasTouch: isMobile,
    userAgent: isMobile ? WECHAT_UA : undefined,
    deviceScaleFactor: isMobile ? 3 : 1
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const stub = makeStub();
  const { page, errors } = await newPage(context, origin, stub);
  page.__stub = stub;
  page.__origin = origin;
  try {
    await testLayout(page, width, errors);
    await testKeyboard(page, width);
    await testNestedQuiz(page, width);
    await testCopyAndConsent(page, width);
    await testPracticeContext(page, width);
    await testDraftOfflineDedupe(page, width);
    await testMoreEntry(page, width);
    await testAdmin(page, width);
    await testAdminPermission(page, width);
    assert.deepEqual(errors, [], `${width}: 全流程不应有 JS 错误`);
    console.log(`PASS ${width}px: 反馈布局/键盘/嵌套弹窗/草稿去重/复制/自练上下文/管理员`);
  } finally {
    await context.close();
  }
}

async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const [width, height] of [[360, 640], [390, 844], [430, 932], [1200, 900]]) {
      try {
        await testViewport(browser, origin, width, height);
      } catch (e) {
        console.error(`FAIL ${width}px: ${e.message}`);
        results.fail++;
        results.errors.push(`${width}px: ${e.message}`);
        try { console.error(e.stack.split('\n').slice(0, 4).join('\n')); } catch {}
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n反馈手机端测试：通过 ${results.pass} 项，失败 ${results.fail} 项`);
  if (results.fail) {
    console.error(results.errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
}

run().catch(e => { console.error(e); process.exitCode = 1; });
