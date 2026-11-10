'use strict';
// 微信移动端布局验收测试（域 2：手机布局）
// 只用全新浏览器与全新 context，绝不连接用户浏览器/资料目录；不写 Cookie、不调用付费接口。
// 覆盖：地址栏伸缩（100vh 越界）、底部安全区、软键盘遮挡、微信字体放大、横竖屏切换、
//       弹窗滚动锁/嵌套/点击穿透/滚动恢复、小屏横向溢出、44px 触控、桌面端不回归。
//
// 运行（必须先重建 build，否则测的是旧代码）：
//   cd 项目根
//   python -c "import sys; sys.path.insert(0,'tools'); import questionflow; print(questionflow.build_preview(questionflow.ROOT))"
//   node tools/test_wechat_layout.cjs
// 失败时 exitCode=1。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('D:/npm-global/node_modules/playwright')); }

const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'), 'utf8')).path;
const qaDir = path.join(root, '.question-import/qa/wechat');
fs.mkdirSync(qaDir, { recursive: true });

// 微信 Android 内置浏览器的 UA（仅作兼容模拟，不联网）
const WECHAT_UA = 'Mozilla/5.0 (Linux; Android 13; PGT-AN10 Build/HONORPGT-AN10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

const CASES = [
  { width: 360, height: 640 },   // 微信常见小屏（地址栏展开可视高）
  { width: 390, height: 844 },   // iPhone / 主流 Android
  { width: 430, height: 932 },
  { width: 768, height: 1024 },  // 平板/小窗
  { width: 1200, height: 900 }   // 桌面，不得回归
];

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(build, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(build + path.sep)) { res.writeHead(403).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

const failures = [];
let passCount = 0;
let currentWidth = 0;

async function check(label, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  PASS ${label}`);
    return true;
  } catch (error) {
    const message = String(error && error.message ? error.message : error).split('\n').slice(0, 6).join(' | ');
    failures.push(`${currentWidth}px ${label}: ${message}`);
    console.error(`  FAIL ${label} :: ${message}`);
    return false;
  }
}

/* ---------------- 页面/竞态辅助 ---------------- */

async function withPage(env, fn) {
  const page = await env.context.newPage();
  page.on('pageerror', error => env.pageErrors.push(`${error.message}`));
  try {
    await page.goto(env.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(120);
    await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function openMap(page, env) {
  await page.goto(env.url + '#map', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chapters', { timeout: 20000 });
}

async function openPracticeQuiz(page) {
  const fixture = await page.evaluate(() => {
    const units = Array.isArray(window.PRACTICE_UNITS) ? window.PRACTICE_UNITS : window.PRACTICE_UNITS.units;
    const sorted = units.filter(u => u.code && u.answer).sort((a, b) => b.code.length - a.code.length);
    // 两题必须不同 id，否则切题用的 viewKey 相同会被当成“同题重渲染”而保留滚动位置
    const first = sorted[0];
    const second = sorted.find(u => u.id !== first.id) || first;
    startPracticeLevel({ id: 'wechat-layout-fixture', title: '微信适配程序题', questions: [first, second] });
    return { code: first.code, distinct: first.id !== second.id };
  });
  await page.waitForSelector('#quiz-dialog[open] .practice-code');
  return fixture;
}

async function openChoiceQuiz(page) {
  await page.evaluate(() => startQuiz([Q.find(q => q.id === 'n7-1'), Q.find(q => q.id === 'n7-2')], '微信适配选择题'));
  await page.waitForSelector('#quiz-dialog[open] .option');
}

async function closeQuiz(page) {
  await page.evaluate(() => { const dialog = document.querySelector('#quiz-dialog'); if (dialog && dialog.open) dialog.close(); });
  await page.waitForTimeout(120);
}

async function openBugDialog(page) {
  await page.evaluate(() => CQuestBugReport.open(getBugReportContext()));
  await page.waitForSelector('#cquest-bug-dialog[open]');
  await page.waitForTimeout(120);
}

async function closeBugDialog(page) {
  await page.evaluate(() => { const dialog = document.querySelector('#cquest-bug-dialog'); if (dialog && dialog.open) dialog.close(); });
  await page.waitForTimeout(120);
}

// 伪造 visualViewport，模拟「地址栏伸缩 / 软键盘弹出」对可视区的影响。
// ui.js 每次 sync 都重新读取 window.visualViewport，因此替换对象 + dispatch resize 即可。
async function setFakeVisualViewport(page, height, offsetTop) {
  await page.evaluate(({ height, offsetTop }) => {
    const fake = {
      height,
      width: window.innerWidth,
      offsetTop: offsetTop || 0,
      offsetLeft: 0,
      pageTop: offsetTop || 0,
      pageLeft: 0,
      scale: 1,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; }
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
    window.dispatchEvent(new Event('resize'));
  }, { height, offsetTop: offsetTop || 0 });
  await page.waitForTimeout(180);
}

async function restoreVisualViewport(page) {
  await page.evaluate(() => {
    try { delete window.visualViewport; } catch (error) { /* 忽略 */ }
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(180);
}

// 字体放大 1.4 倍（模拟微信/安卓 WebView 字号放大）；先快照再统一赋值，避免逐层相乘。
async function scaleFonts(page, scopeSelector) {
  await page.evaluate(scope => {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return;
    const snapshot = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.closest('svg')) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > 0) snapshot.push([el, size]);
    }
    for (const [el, size] of snapshot) el.style.fontSize = (size * 1.4).toFixed(2) + 'px';
  }, scopeSelector || null);
}

/* ---------------- 各场景 ---------------- */

async function scenarioBasic(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const horizontalOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      return {
        dialogOpen: dialog.open,
        dialogVisible: getComputedStyle(dialog).display !== 'none',
        horizontalOverflow,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        innerHeight: window.innerHeight,
        textAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust,
        locked: document.body.classList.contains('dialog-scroll-locked')
      };
    });
    assert.equal(state.dialogOpen, false, '关闭状态的 #quiz-dialog 不应 open');
    assert.equal(state.dialogVisible, false, '关闭状态的 #quiz-dialog 不应可见');
    assert.ok(state.horizontalOverflow <= 1, `页面横向溢出 ${state.horizontalOverflow}px`);
    assert.equal(state.appHeight, state.innerHeight + 'px', `--app-height 应为可视高度 ${state.innerHeight}px，实际 ${state.appHeight}`);
    assert.ok(!state.locked, '未打开弹窗时不应有 dialog-scroll-locked');
    assert.ok(/100/.test(String(state.textAdjust)), `-webkit-text-size-adjust 应为 100%，实际 ${state.textAdjust}`);
    await page.screenshot({ path: path.join(qaDir, `map-${env.width}.png`) });
  });
}

async function scenarioViewsOverflow(env) {
  await withPage(env, async page => {
    for (const view of ['map', 'practice', 'coach', 'account', 'library', 'progress']) {
      await page.goto(env.url + '#' + view, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(260);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${view} 视图出现 ${overflow}px 页面级横向溢出`);
    }
  });
}

async function scenarioAddressBar(env, pageHeight) {
  await withPage(env, async page => {
    if (pageHeight && pageHeight !== env.height) await page.setViewportSize({ width: env.width, height: pageHeight });
    await openMap(page, env);
    await openPracticeQuiz(page);
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const initial = await page.evaluate(() => document.querySelector('#quiz-dialog').getBoundingClientRect().height);
    assert.ok(Math.abs(initial - viewportHeight) <= 1, `无地址栏时做题弹窗应铺满 ${viewportHeight}px，实际 ${initial}px`);

    const fakeHeight = viewportHeight - 100; // 模拟地址栏展开后的真实可视高度
    await setFakeVisualViewport(page, fakeHeight); // offsetTop = 0
    const metrics = await page.evaluate(fake => {
      const dialog = document.querySelector('#quiz-dialog').getBoundingClientRect();
      const foot = document.querySelector('#quiz-dialog .quiz-foot').getBoundingClientRect();
      const primary = document.querySelector('#quiz-dialog .quiz-foot .primary').getBoundingClientRect();
      const body = document.querySelector('#quiz-dialog .quiz-body');
      const hit = document.elementFromPoint(primary.left + primary.width / 2, primary.top + primary.height / 2);
      const primaryEl = document.querySelector('#quiz-dialog .quiz-foot .primary');
      return {
        fake,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        dialogTop: dialog.top,
        dialogBottom: dialog.bottom,
        dialogHeight: dialog.height,
        footBottom: foot.bottom,
        primaryBottom: primary.bottom,
        primaryVisible: primary.top >= 0 && primary.bottom <= fake + 1,
        primaryHit: hit === primaryEl || primaryEl.contains(hit),
        bodyHeight: body.clientHeight,
        bodyScrollable: body.scrollHeight > body.clientHeight
      };
    }, fakeHeight);
    assert.equal(metrics.appHeight, fakeHeight + 'px', `--app-height 应跟可视高度 ${fakeHeight}px，实际 ${metrics.appHeight}`);
    assert.ok(Math.abs(metrics.dialogHeight - fakeHeight) <= 1, `做题弹窗高度应=${fakeHeight}px，实际 ${metrics.dialogHeight}px`);
    assert.ok(metrics.footBottom <= fakeHeight + 1, `底栏底边 ${metrics.footBottom}px 超出可视区 ${fakeHeight}px（地址栏会遮挡按钮）`);
    assert.ok(metrics.primaryVisible, '地址栏展开时主按钮必须完整可见');
    assert.ok(metrics.primaryHit, '地址栏展开时主按钮必须可点（elementFromPoint 命中自身）');
    assert.ok(metrics.bodyHeight > 100, `内容区被压得过小：${metrics.bodyHeight}px`);
    assert.ok(metrics.bodyScrollable, '内容区应保持可滚动');

    // CSS 必须保留「先 100vh 再 var(--app-height,100dvh)」双写回退
    const css = await page.evaluate(() => {
      const collect = selector => {
        const chunks = [];
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (error) { continue; }
          const walk = list => {
            for (const rule of list) {
              // 注意：Chromium 116+ 的 CSSStyleRule 也带（可能为空的）cssRules，
              // 必须先收集自身选择器再递归，否则永远匹配不到普通样式规则。
              if (rule.selectorText && rule.selectorText.split(',').map(s => s.trim()).includes(selector)) chunks.push(rule.cssText);
              if (rule.cssRules) walk(rule.cssRules);
            }
          };
          walk(rules);
        }
        return chunks.join('\n');
      };
      return { quiz: collect('#quiz-dialog'), lock: collect('body.dialog-scroll-locked') };
    });
    assert.ok(css.quiz.includes('100vh'), '#quiz-dialog 缺少 100vh 回退');
    assert.ok(css.quiz.includes('var(--app-height'), '#quiz-dialog 缺少 var(--app-height) 增强');
    assert.ok(css.lock.includes('position: fixed'), 'body.dialog-scroll-locked 缺少 position:fixed');

    await page.screenshot({ path: path.join(qaDir, `address-bar-${env.width}x${pageHeight || env.height}.png`) });
    await restoreVisualViewport(page);
    const restored = await page.evaluate(() => document.querySelector('#quiz-dialog').getBoundingClientRect().height);
    assert.ok(Math.abs(restored - viewportHeight) <= 1, `地址栏收起后弹窗高度应恢复 ${viewportHeight}px，实际 ${restored}px`);
    await closeQuiz(page);
  });
}

async function scenarioSafeArea(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '34px'));
    await page.waitForTimeout(80);
    const base = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      return {
        sidebarHeight: sidebar.height,
        sidebarBottom: sidebar.bottom,
        sidebarPaddingBottom: parseFloat(getComputedStyle(document.querySelector('.sidebar')).paddingBottom),
        workspacePaddingBottom: parseFloat(getComputedStyle(document.querySelector('.workspace')).paddingBottom),
        innerHeight: window.innerHeight
      };
    });
    assert.ok(Math.abs(base.sidebarHeight - 90) <= 1, `刘海屏安全区 34px 时底部导航高应为 56+34=90，实际 ${base.sidebarHeight}`);
    assert.ok(Math.abs(base.sidebarBottom - base.innerHeight) <= 1, '底部导航应贴住可视区底部');
    assert.ok(Math.abs(base.sidebarPaddingBottom - 34) <= 1, `底部导航应有 34px 安全区内边距，实际 ${base.sidebarPaddingBottom}`);
    assert.ok(Math.abs(base.workspacePaddingBottom - 102) <= 1, `内容区底部留白应=68+34=102，实际 ${base.workspacePaddingBottom}`);

    await openPracticeQuiz(page);
    const foot = await page.evaluate(() => ({
      paddingBottom: parseFloat(getComputedStyle(document.querySelector('#quiz-dialog .quiz-foot')).paddingBottom),
      bottom: document.querySelector('#quiz-dialog .quiz-foot').getBoundingClientRect().bottom,
      innerHeight: window.innerHeight
    }));
    assert.ok(Math.abs(foot.paddingBottom - 44) <= 1, `做题底栏安全区内边距应=10+34=44，实际 ${foot.paddingBottom}`);
    assert.ok(foot.bottom <= foot.innerHeight + 1, '做题底栏不应被安全区顶出可视区');
    await closeQuiz(page);

    await openBugDialog(page);
    const bug = await page.evaluate(() => ({
      paddingBottom: parseFloat(getComputedStyle(document.querySelector('#cquest-bug-dialog')).paddingBottom),
      dialogBottom: document.querySelector('#cquest-bug-dialog').getBoundingClientRect().bottom,
      innerHeight: window.innerHeight
    }));
    assert.ok(Math.abs(bug.paddingBottom - 52) <= 1, `反馈弹窗安全区内边距应=18+34=52，实际 ${bug.paddingBottom}`);
    assert.ok(bug.dialogBottom <= bug.innerHeight + 1, '反馈弹窗不应被安全区顶出可视区');
    await page.screenshot({ path: path.join(qaDir, `safe-area-${env.width}.png`) });
    await closeBugDialog(page);
    await page.evaluate(() => document.documentElement.style.removeProperty('--safe-bottom'));
  });
}

async function scenarioKeyboardAccount(env) {
  await withPage(env, async page => {
    await page.goto(env.url + '#account', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.account-field input');
    const input = page.locator('input[name="email"]').first();
    await input.focus();
    await page.waitForTimeout(150);
    const keyboardHeight = 320;
    await setFakeVisualViewport(page, keyboardHeight);
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      const rect = active.getBoundingClientRect();
      return {
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        sidebarTransform: getComputedStyle(document.querySelector('.sidebar')).transform,
        activeTag: active.tagName,
        activeTop: rect.top,
        activeBottom: rect.bottom
      };
    });
    assert.equal(state.keyboardOpen, true, '软键盘弹出时应给 body 加 keyboard-open');
    assert.equal(state.appHeight, keyboardHeight + 'px', `软键盘弹出时 --app-height 应为 ${keyboardHeight}px，实际 ${state.appHeight}`);
    assert.notEqual(state.sidebarTransform, 'none', '软键盘弹出时应隐藏底部固定导航');
    assert.equal(state.activeTag, 'INPUT', '焦点应仍在输入框');
    assert.ok(state.activeTop >= 0 && state.activeBottom <= keyboardHeight + 1, `聚焦输入框应滚入可视区（top=${state.activeTop}, bottom=${state.activeBottom}, 键盘顶=${keyboardHeight}）`);
    await page.screenshot({ path: path.join(qaDir, `keyboard-account-${env.width}.png`) });

    await restoreVisualViewport(page);
    await page.waitForTimeout(400);
    const restored = await page.evaluate(() => ({
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
      innerHeight: window.innerHeight,
      sidebarTransform: getComputedStyle(document.querySelector('.sidebar')).transform
    }));
    assert.equal(restored.keyboardOpen, false, '键盘收起后应移除 keyboard-open');
    assert.equal(restored.appHeight, restored.innerHeight + 'px', '键盘收起后 --app-height 应恢复');
    assert.equal(restored.sidebarTransform, 'none', '键盘收起后底部导航应恢复显示');
  });
}

async function scenarioKeyboardBugDialog(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    await openBugDialog(page);
    await page.locator('#cquest-bug-desc').focus();
    const keyboardHeight = 320;
    await setFakeVisualViewport(page, keyboardHeight);
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('#cquest-bug-dialog').getBoundingClientRect();
      const textarea = document.querySelector('#cquest-bug-desc').getBoundingClientRect();
      return {
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        dialogTop: dialog.top,
        dialogBottom: dialog.bottom,
        textareaTop: textarea.top,
        textareaBottom: textarea.bottom,
        keyboardHeight: 320
      };
    });
    assert.equal(state.keyboardOpen, true, '反馈弹窗内软键盘弹出时应加 keyboard-open');
    assert.ok(state.dialogTop <= 10, `反馈弹窗应上移贴顶（top=${state.dialogTop}）`);
    assert.ok(state.dialogBottom <= state.keyboardHeight + 1, `反馈弹窗底边 ${state.dialogBottom}px 落到键盘下面`);
    assert.ok(state.textareaTop >= 0 && state.textareaBottom <= state.keyboardHeight + 1, `反馈输入框应滚到键盘上方（top=${state.textareaTop}, bottom=${state.textareaBottom}）`);
    await page.screenshot({ path: path.join(qaDir, `keyboard-bug-${env.width}.png`) });
    await restoreVisualViewport(page);
    await page.waitForTimeout(300);
    await closeBugDialog(page);
  });
}

async function scenarioScrollLockNested(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForFunction(() => Math.abs(window.scrollY - 300) < 3, null, { timeout: 5000 });
    const startY = await page.evaluate(() => Math.round(window.scrollY));
    assert.ok(startY >= 290, `页面应已滚动到 300 附近，实际 ${startY}`);

    await openChoiceQuiz(page);
    await page.waitForTimeout(200);
    let state = await page.evaluate(() => ({
      locked: document.body.classList.contains('dialog-scroll-locked'),
      position: getComputedStyle(document.body).position,
      top: document.body.style.top,
      scrollY: Math.round(window.scrollY),
      quizOpen: document.querySelector('#quiz-dialog').open
    }));
    assert.equal(state.quizOpen, true, '做题弹窗应已打开');
    assert.equal(state.locked, true, '打开做题弹窗后 body 应有 dialog-scroll-locked');
    assert.equal(state.position, 'fixed', `锁定时 body 应为 fixed，实际 ${state.position}`);
    assert.ok(Math.abs(parseInt(state.top, 10) - (-startY)) <= 1, `body.top 应为 -${startY}px，实际 ${state.top}`);
    assert.equal(state.scrollY, 0, `锁定后 window.scrollY 应为 0，实际 ${state.scrollY}`);

    // 在遮罩/底栏区域滚轮，背景不能滚
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(6, viewportHeight - 10);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0, '弹窗打开期间遮罩区滚轮不得滚动背景');

    // 注：390/844、430/932 下选择题内容恰好放得下（实测 .quiz-body maxScroll=0），无法验证「下层滚动位置保持」。
    // 这里仅在不可滚动时插入占位长块构造可滚动容器（纯排版辅助，不改变被测交互路径）。
    await page.evaluate(() => {
      const body = document.querySelector('#quiz-dialog .quiz-body');
      if (body.scrollHeight - body.clientHeight < 100) {
        const filler = document.createElement('div');
        filler.setAttribute('aria-hidden', 'true');
        filler.style.height = '900px';
        body.appendChild(filler);
      }
      body.scrollTop = 400;
    });
    await page.waitForTimeout(150);
    await openBugDialog(page);
    await page.waitForTimeout(250);
    state = await page.evaluate(() => ({
      quizOpen: document.querySelector('#quiz-dialog').open,
      bugOpen: document.querySelector('#cquest-bug-dialog').open,
      locked: document.body.classList.contains('dialog-scroll-locked'),
      scrollY: Math.round(window.scrollY),
      quizScrollTop: Math.round(document.querySelector('#quiz-dialog .quiz-body').scrollTop),
      selected: document.querySelectorAll('#quiz-dialog .option[aria-pressed="true"]').length,
      submitDisabled: document.querySelector('#submit-answer') ? document.querySelector('#submit-answer').disabled : null
    }));
    assert.equal(state.quizOpen, true, '反馈弹窗打开时 quiz 弹窗应保持');
    assert.equal(state.bugOpen, true, '反馈弹窗应打开');
    assert.equal(state.locked, true, '嵌套弹窗时滚动锁应保持');
    assert.equal(state.scrollY, 0, '嵌套弹窗时 window.scrollY 应为 0');
    const quizScrollBefore = state.quizScrollTop;
    assert.ok(quizScrollBefore > 0, `quiz 内容应已滚动（实际 scrollTop=${quizScrollBefore}）`);

    await page.mouse.move(4, viewportHeight - 6);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(250);
    state = await page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      locked: document.body.classList.contains('dialog-scroll-locked'),
      quizScrollTop: Math.round(document.querySelector('#quiz-dialog .quiz-body').scrollTop)
    }));
    assert.equal(state.scrollY, 0, '反馈弹窗打开期间滚轮不得滚动背景');
    assert.equal(state.locked, true, '嵌套期间锁定不能丢失');
    assert.equal(state.quizScrollTop, quizScrollBefore, '反馈弹窗滚动事件不得影响下层 quiz 内部滚动位置');

    // 点击穿透：遮罩区点击不能命中下层选项
    await page.mouse.click(4, viewportHeight - 6);
    await page.waitForTimeout(200);
    const afterClick = await page.evaluate(() => ({
      bugOpen: document.querySelector('#cquest-bug-dialog').open,
      selected: document.querySelectorAll('#quiz-dialog .option[aria-pressed="true"]').length,
      submitDisabled: document.querySelector('#submit-answer') ? document.querySelector('#submit-answer').disabled : null
    }));
    assert.equal(afterClick.bugOpen, true, '遮罩区点击不应关闭反馈弹窗');
    assert.equal(afterClick.selected, 0, '点击不得穿透到下层选项');
    assert.equal(afterClick.submitDisabled, true, '穿透点击不得改变下层作答状态');

    // 关闭上层：下层 quiz 保持、滚动位置保持、仍锁定
    await page.locator('#cquest-bug-dialog .cquest-bug-close').click();
    await page.waitForTimeout(300);
    state = await page.evaluate(() => ({
      quizOpen: document.querySelector('#quiz-dialog').open,
      locked: document.body.classList.contains('dialog-scroll-locked'),
      scrollY: Math.round(window.scrollY),
      quizScrollTop: Math.round(document.querySelector('#quiz-dialog .quiz-body').scrollTop)
    }));
    assert.equal(state.quizOpen, true, '关闭反馈弹窗后 quiz 应仍打开');
    assert.equal(state.locked, true, '只关一层时滚动锁不应解除');
    assert.equal(state.scrollY, 0, '只关一层时背景不得滚动');
    assert.equal(state.quizScrollTop, quizScrollBefore, '关闭上层后下层内部滚动位置应保持');

    // 关闭最后一层：滚动位置恢复且只恢复一次
    await page.locator('#quiz-dialog [aria-label="保存并关闭练习"]').click();
    await page.waitForTimeout(400);
    const finalState = await page.evaluate(() => ({
      locked: document.body.classList.contains('dialog-scroll-locked'),
      position: getComputedStyle(document.body).position,
      scrollY: Math.round(window.scrollY),
      top: document.body.style.top
    }));
    assert.equal(finalState.locked, false, '全部关闭后应解除滚动锁');
    assert.notEqual(finalState.position, 'fixed', '全部关闭后 body 不应是 fixed');
    assert.equal(finalState.top, '', '全部关闭后 body.top 应清空');
    assert.ok(Math.abs(finalState.scrollY - startY) <= 2, `全部关闭后滚动位置应恢复 ${startY}，实际 ${finalState.scrollY}`);
  });
}

async function scenarioFontScale(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    await scaleFonts(page);
    const mapState = await page.evaluate(() => {
      const navItems = [...document.querySelectorAll('.sidebar nav a, .sidebar .nav-more')].map(el => el.getBoundingClientRect());
      let overlap = false;
      for (let i = 0; i < navItems.length; i++) {
        for (let j = i + 1; j < navItems.length; j++) {
          const a = navItems[i]; const b = navItems[j];
          const area = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (area > 1) overlap = true;
        }
      }
      const clipped = [...document.querySelectorAll('.segmented button, .page-footer .text-button, .sidebar nav a')]
        .filter(el => el.scrollWidth > el.clientWidth + 2)
        .map(el => `${el.tagName}.${String(el.className).slice(0, 24) || el.tagName}`);
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overlap,
        clipped
      };
    });
    assert.ok(mapState.overflow <= 1, `1.4x 字号下页面横向溢出 ${mapState.overflow}px`);
    assert.equal(mapState.overlap, false, '1.4x 字号下底部导航项互相重叠');
    assert.deepEqual(mapState.clipped, [], `1.4x 字号下文字被横向裁切：${mapState.clipped.join(', ')}`);
    await page.screenshot({ path: path.join(qaDir, `font-scale-map-${env.width}.png`) });

    await openPracticeQuiz(page);
    await scaleFonts(page, '#quiz-dialog');
    const quizState = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const body = dialog.querySelector('.quiz-body');
      const dialogRect = dialog.getBoundingClientRect();
      const footRect = dialog.querySelector('.quiz-foot').getBoundingClientRect();
      const primary = dialog.querySelector('.quiz-foot .primary').getBoundingClientRect();
      const clipped = [...dialog.querySelectorAll('.quiz-foot .primary, .quiz-foot .text-button, .quiz-step-actions button, .action-btn, .option .option-text, .quiz-back')]
        .filter(el => el.scrollWidth > el.clientWidth + 2)
        .map(el => String(el.className).slice(0, 30));
      return {
        overflow: dialog.scrollWidth - dialog.clientWidth,
        bodyHeight: body.clientHeight,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        footBottom: footRect.bottom,
        dialogBottom: dialogRect.bottom,
        primaryBottom: primary.bottom,
        innerHeight: window.innerHeight,
        clipped
      };
    });
    assert.ok(quizState.overflow <= 1, `1.4x 字号下做题弹窗横向溢出 ${quizState.overflow}px`);
    assert.ok(quizState.bodyHeight > 50, `1.4x 字号下内容区过小：${quizState.bodyHeight}px`);
    assert.ok(quizState.bodyScrollable, '1.4x 字号下内容区应仍可滚动');
    assert.ok(quizState.footBottom <= quizState.dialogBottom + 1, `1.4x 字号下底栏超出弹窗（${quizState.footBottom} > ${quizState.dialogBottom}）`);
    assert.ok(quizState.primaryBottom <= quizState.innerHeight + 1, '1.4x 字号下主按钮被裁出屏幕');
    assert.deepEqual(quizState.clipped, [], `1.4x 字号下按钮文字被裁切：${quizState.clipped.join(', ')}`);
    await page.screenshot({ path: path.join(qaDir, `font-scale-quiz-${env.width}.png`) });
    await closeQuiz(page);
  });
}

async function scenarioLandscape(env) {
  await withPage(env, async page => {
    await openPracticeQuiz(page);
    await page.setViewportSize({ width: env.height, height: env.width });
    await page.waitForTimeout(600);
    const landscape = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const dialogRect = dialog.getBoundingClientRect();
      const body = dialog.querySelector('.quiz-body');
      const foot = dialog.querySelector('.quiz-foot');
      const footRect = foot.getBoundingClientRect();
      const primary = dialog.querySelector('.quiz-foot .primary').getBoundingClientRect();
      const hit = document.elementFromPoint(primary.left + primary.width / 2, primary.top + primary.height / 2);
      const primaryEl = dialog.querySelector('.quiz-foot .primary');
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        dialogWidth: dialogRect.width,
        dialogHeight: dialogRect.height,
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        footBottom: footRect.bottom,
        footDirection: getComputedStyle(foot).flexDirection,
        bodyHeight: body.clientHeight,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        overflow: dialog.scrollWidth - dialog.clientWidth,
        primaryVisible: primary.top >= 0 && primary.bottom <= window.innerHeight + 1,
        primaryHit: hit === primaryEl || primaryEl.contains(hit)
      };
    });
    assert.equal(landscape.width, env.height, '横屏后宽度应为原高度');
    assert.equal(landscape.height, env.width, '横屏后高度应为原宽度');
    assert.equal(landscape.appHeight, landscape.height + 'px', `横屏后 --app-height 应=${landscape.height}px，实际 ${landscape.appHeight}`);
    assert.ok(!(landscape.dialogBottom > landscape.height + 1 && landscape.dialogBottom - landscape.height < 2), '弹窗不得越界加高');
    assert.ok(landscape.dialogBottom <= landscape.height + 2 || landscape.dialogTop >= 0, `弹窗越界：top=${landscape.dialogTop}, bottom=${landscape.dialogBottom}, 视口=${landscape.height}`);
    assert.ok(landscape.overflow <= 1, `横屏后弹窗横向溢出 ${landscape.overflow}px`);
    assert.ok(landscape.footBottom <= landscape.height + 2, `横屏后底栏底边 ${landscape.footBottom}px 超出视口 ${landscape.height}px`);
    assert.ok(landscape.primaryVisible, '横屏后主按钮必须完整可见');
    assert.ok(landscape.primaryHit, '横屏后主按钮必须可点');
    assert.ok(landscape.bodyScrollable, '横屏后内容区应可滚动');
    if (env.height <= 760) {
      assert.equal(landscape.footDirection, 'row', `短横屏底栏应横排（实际 ${landscape.footDirection}），给内容留高度`);
      assert.ok(landscape.bodyHeight >= 150, `短横屏内容区仅 ${landscape.bodyHeight}px，低于 150px 可用高度`);
    } else {
      assert.ok(landscape.bodyHeight > 80, `横屏后内容区过小：${landscape.bodyHeight}px`);
    }
    await page.screenshot({ path: path.join(qaDir, `landscape-${env.width}.png`) });

    // 转回竖屏：弹窗、底栏、内外滚动恢复正常
    await page.setViewportSize({ width: env.width, height: env.height });
    await page.waitForTimeout(600);
    const portrait = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const rect = dialog.getBoundingClientRect();
      const foot = dialog.querySelector('.quiz-foot').getBoundingClientRect();
      const primary = dialog.querySelector('.quiz-foot .primary').getBoundingClientRect();
      return {
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        height: window.innerHeight,
        dialogHeight: rect.height,
        dialogBottom: rect.bottom,
        footBottom: foot.bottom,
        primaryVisible: primary.top >= 0 && primary.bottom <= window.innerHeight + 1
      };
    });
    assert.equal(portrait.appHeight, portrait.height + 'px', '转回竖屏后 --app-height 应恢复');
    assert.ok(Math.abs(portrait.dialogHeight - portrait.height) <= 1, `转回竖屏后做题弹窗应铺满 ${portrait.height}px，实际 ${portrait.dialogHeight}px`);
    assert.ok(portrait.footBottom <= portrait.height + 1, '转回竖屏后底栏应回到视口内');
    assert.ok(portrait.primaryVisible, '转回竖屏后主按钮应完整可见');
    await closeQuiz(page);
  });
}

async function scenarioTouchTargets(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    const auditPage = selectors => page.evaluate(selList => {
      const items = [];
      for (const selector of selList) {
        for (const el of document.querySelectorAll(selector)) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) continue;
          items.push({ selector, tag: el.tagName, cls: String(el.className || '').slice(0, 30), width: rect.width, height: rect.height });
        }
      }
      const seen = new Set();
      return items.filter(item => {
        const key = `${item.tag}:${item.cls}:${Math.round(item.width)}:${Math.round(item.height)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }, selectors);

    const mapTargets = await auditPage(['.sidebar nav a', '.nav-more', '.account-entry', '.avatar', '.segmented button', '.chapter', 'main .primary', 'main .secondary', 'main .quiet', '.page-footer .text-button']);
    const smallMap = mapTargets.filter(item => item.height < 43.5 || item.width < 43.5);
    assert.deepEqual(smallMap, [], `地图页触控目标小于 44px：${JSON.stringify(smallMap)}`);

    await openPracticeQuiz(page);
    const quizTargets = await auditPage(['#quiz-dialog .quiz-back', '#quiz-dialog .icon-button', '#quiz-dialog .quiz-foot .primary', '#quiz-dialog .quiz-foot .text-button', '#quiz-dialog .quiz-step-actions button', '#quiz-dialog .action-btn', '#quiz-dialog .option', '#quiz-dialog .copy-code-btn']);
    const smallQuiz = quizTargets.filter(item => item.height < 43.5 || item.width < 43.5);
    assert.deepEqual(smallQuiz, [], `做题弹窗触控目标小于 44px：${JSON.stringify(smallQuiz)}`);
    await closeQuiz(page);

    await openBugDialog(page);
    const bug = await page.evaluate(() => {
      const label = document.querySelector('.cquest-bug-checkbox-label');
      const input = document.querySelector('#cquest-bug-attach-ctx');
      const labelRect = label.getBoundingClientRect();
      return { labelHeight: labelRect.height, labelWidth: labelRect.width, inputWidth: input.getBoundingClientRect().width, inputHeight: input.getBoundingClientRect().height, checked: input.checked };
    });
    assert.ok(bug.labelHeight >= 43.5, `「附上上下文」整行 label 高度应≥44px，实际 ${bug.labelHeight}`);
    assert.ok(bug.inputWidth >= 21 && bug.inputHeight >= 21, `勾选框视觉尺寸应≥22px，实际 ${bug.inputWidth}x${bug.inputHeight}`);
    await page.locator('.cquest-bug-checkbox-label span').click();
    await page.waitForTimeout(100);
    const toggled = await page.evaluate(() => document.querySelector('#cquest-bug-attach-ctx').checked);
    assert.notEqual(toggled, bug.checked, '点击 label 文字应切换复选框');
    const bugTargets = await auditPage(['#cquest-bug-dialog button', '#cquest-bug-dialog select', '#cquest-bug-dialog textarea']);
    const smallBug = bugTargets.filter(item => item.height < 43.5 || item.width < 43.5);
    assert.deepEqual(smallBug, [], `反馈弹窗触控目标小于 44px：${JSON.stringify(smallBug)}`);
    await closeBugDialog(page);

    await page.locator('.nav-more').click();
    await page.waitForSelector('#more-dialog[open]');
    const moreTargets = await auditPage(['#more-dialog .more-menu a', '#more-dialog .more-menu button', '#more-dialog .icon-button']);
    const smallMore = moreTargets.filter(item => item.height < 43.5 || item.width < 43.5);
    assert.deepEqual(smallMore, [], `更多菜单触控目标小于 44px：${JSON.stringify(smallMore)}`);
    await page.evaluate(() => document.querySelector('#more-dialog').close());
  });
}

async function scenarioDesktopRegression(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    await openPracticeQuiz(page);
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const rect = dialog.getBoundingClientRect();
      const body = dialog.querySelector('.quiz-body');
      const foot = dialog.querySelector('.quiz-foot');
      return {
        dialogWidth: rect.width,
        dialogHeight: rect.height,
        dialogLeft: rect.left,
        dialogBottom: rect.bottom,
        maxHeight: getComputedStyle(dialog).maxHeight,
        footPosition: getComputedStyle(foot).position,
        footBottom: foot.getBoundingClientRect().bottom,
        bodyHeight: body.clientHeight,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        overflow: dialog.scrollWidth - dialog.clientWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        locked: document.body.classList.contains('dialog-scroll-locked')
      };
    });
    // 源码 width:min(840px,calc(100vw-32px))；但原生 <dialog> 的 UA 样式 max-width 是 calc(100% - 36px)，
    // 两者取小，所以不硬编码单一期望值。
    const expectedWidth = Math.min(840, env.width - 32, env.width - 36);
    assert.ok(Math.abs(geometry.dialogWidth - expectedWidth) <= 1.5, `桌面端弹窗宽度应≈${expectedWidth}px（min(840, 100vw-32, UA max-width 100%-36)），实际 ${geometry.dialogWidth}px`);
    assert.ok(geometry.dialogHeight <= geometry.innerHeight - 48 + 1, `桌面端弹窗高度应≤${geometry.innerHeight - 48}px，实际 ${geometry.dialogHeight}px`);
    assert.ok(geometry.footBottom <= geometry.innerHeight + 1, '桌面端底栏应在视口内');
    assert.equal(geometry.footPosition, 'sticky', `桌面端底栏应保持 sticky，实际 ${geometry.footPosition}`);
    assert.ok(geometry.bodyScrollable, '桌面端内容区应可滚动');
    assert.ok(geometry.overflow <= 1, `桌面端弹窗横向溢出 ${geometry.overflow}px`);
    assert.equal(geometry.appHeight, geometry.innerHeight + 'px', '桌面端 --app-height 应等于内高');
    assert.equal(geometry.locked, false, '桌面端打开弹窗不得加 dialog-scroll-locked');
    await page.screenshot({ path: path.join(qaDir, `desktop-quiz-${env.width}.png`) });

    // 桌面端打开反馈弹窗也不锁 body
    await page.evaluate(() => CQuestBugReport.open(getBugReportContext()));
    await page.waitForSelector('#cquest-bug-dialog[open]');
    const bugLocked = await page.evaluate(() => ({
      locked: document.body.classList.contains('dialog-scroll-locked'),
      position: getComputedStyle(document.body).position
    }));
    assert.equal(bugLocked.locked, false, '桌面端反馈弹窗也不得锁 body');
    assert.notEqual(bugLocked.position, 'fixed', '桌面端 body 不应 fixed');
    await closeBugDialog(page);
    await closeQuiz(page);
  });
}

/* 切题后的滚动复位：真实滚动容器是 .quiz-body，#quiz-dialog 本身不滚。
   合并版 practice-flow 已在 renderQuiz / renderPracticeLevelQuiz 复位 body.scrollTop；本用例防回归。 */
async function scenarioQuizScrollReset(env) {
  await withPage(env, async page => {
    await openMap(page, env);

    // 选择题：答一题后切下一题，滚动容器应回到顶部
    await openChoiceQuiz(page);
    await page.locator('#quiz-dialog .option').first().click();
    await page.locator('#submit-answer').click();
    await page.waitForSelector('#quiz-dialog .feedback');
    const before = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const body = dialog.querySelector('.quiz-body');
      if (body.scrollHeight <= body.clientHeight + 5) {
        // 高屏机型上题目本身可能不够长：补一段占位内容确保能滚动（切题后整段重渲染会消失）
        const filler = document.createElement('div');
        filler.className = 'scroll-fixture';
        filler.setAttribute('aria-hidden', 'true');
        filler.style.height = '900px';
        body.appendChild(filler);
      }
      body.scrollTop = 420;
      return {
        meta: (dialog.querySelector('.quiz-meta') || {}).textContent || '',
        scrollable: body.scrollHeight > body.clientHeight,
        bodyTop: body.scrollTop,
        dialogTop: dialog.scrollTop
      };
    });
    assert.ok(before.scrollable, '选择题内容区应可滚动');
    assert.ok(before.bodyTop > 50, `切题前 .quiz-body 应先滚动，实际 scrollTop=${before.bodyTop}`);
    await page.locator('#quiz-dialog .quiz-foot .primary').click();
    await page.waitForTimeout(260);
    const after = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const body = dialog.querySelector('.quiz-body');
      return {
        meta: (dialog.querySelector('.quiz-meta') || {}).textContent || '',
        bodyTop: body.scrollTop,
        dialogTop: dialog.scrollTop
      };
    });
    assert.notEqual(after.meta, before.meta, '点击「下一题」后应切题');
    assert.ok(after.bodyTop <= 2, `切题后 .quiz-body 应回到顶部，实际 scrollTop=${after.bodyTop}`);
    assert.ok(after.dialogTop <= 2, `切题后 #quiz-dialog.scrollTop 应为 0，实际 ${after.dialogTop}`);
    await closeQuiz(page);

    // 程序题：下一题、上一题后都要回到顶部
    await openPracticeQuiz(page);
    const practiceBefore = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const body = dialog.querySelector('.quiz-body');
      body.scrollTop = 300;
      return { meta: (dialog.querySelector('.quiz-meta') || {}).textContent || '', bodyTop: body.scrollTop };
    });
    assert.ok(practiceBefore.bodyTop > 50, `程序题内容区应先滚动，实际 scrollTop=${practiceBefore.bodyTop}`);
    await page.locator('#quiz-dialog .quiz-step-actions .primary').click();
    await page.waitForTimeout(260);
    const practiceNext = await page.evaluate(() => {
      const dialog = document.querySelector('#quiz-dialog');
      const body = dialog.querySelector('.quiz-body');
      return { meta: (dialog.querySelector('.quiz-meta') || {}).textContent || '', bodyTop: body.scrollTop };
    });
    assert.notEqual(practiceNext.meta, practiceBefore.meta, '程序题点「下一题」应切题');
    assert.ok(practiceNext.bodyTop <= 2, `程序题切下一题后 .quiz-body 应回到顶部，实际 ${practiceNext.bodyTop}`);
    await page.locator('#quiz-dialog .quiz-step-actions .secondary').click();
    await page.waitForTimeout(260);
    const practicePrev = await page.evaluate(() => {
      const body = document.querySelector('#quiz-dialog .quiz-body');
      return { meta: (document.querySelector('#quiz-dialog .quiz-meta') || {}).textContent || '', bodyTop: body.scrollTop };
    });
    assert.ok(practicePrev.bodyTop <= 2, `程序题切上一题后 .quiz-body 应回到顶部，实际 ${practicePrev.bodyTop}`);
    await closeQuiz(page);
  });
}

/* 键盘操作 + 嵌套弹窗滚动锁 + ESC 关闭后的页面滚动恢复。 */
async function scenarioKeyboardOps(env) {
  const mobile = env.width <= 760;
  await withPage(env, async page => {
    await openMap(page, env);
    await page.evaluate(() => window.scrollTo(0, 260));
    await page.waitForTimeout(140);
    const startY = await page.evaluate(() => window.scrollY);
    assert.ok(startY > 100, `地图页应可滚动以便验证恢复，实际 scrollY=${startY}`);

    // 1) 选择题热键：A–E 选项、Enter 提交/下一题
    await openChoiceQuiz(page);
    await page.keyboard.press('a');
    let pressed = await page.evaluate(() => Array.from(document.querySelectorAll('#quiz-dialog .option')).map(o => o.getAttribute('aria-pressed')));
    assert.equal(pressed[0], 'true', `按 A 应选中第一个选项，实际 ${JSON.stringify(pressed)}`);
    await page.keyboard.press('b');
    pressed = await page.evaluate(() => Array.from(document.querySelectorAll('#quiz-dialog .option')).map(o => o.getAttribute('aria-pressed')));
    assert.equal(pressed[1], 'true', `按 B 应改选第二个选项，实际 ${JSON.stringify(pressed)}`);
    assert.notEqual(pressed[0], 'true', '单选改选后第一个选项应取消选中');
    const metaBefore = await page.evaluate(() => (document.querySelector('#quiz-dialog .quiz-meta') || {}).textContent || '');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#quiz-dialog .feedback');
    const submitState = await page.evaluate(() => ({
      feedback: !!document.querySelector('#quiz-dialog .feedback'),
      primary: ((document.querySelector('#quiz-dialog .quiz-foot .primary') || {}).textContent || '').trim()
    }));
    assert.ok(submitState.feedback, '按 Enter 应提交答案并展示反馈');
    assert.ok(/下一题|查看本次成绩/.test(submitState.primary), `提交后主按钮应为下一题，实际「${submitState.primary}」`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(260);
    const metaAfter = await page.evaluate(() => ({
      meta: (document.querySelector('#quiz-dialog .quiz-meta') || {}).textContent || '',
      feedback: !!document.querySelector('#quiz-dialog .feedback')
    }));
    assert.notEqual(metaAfter.meta, metaBefore, '反馈态再按 Enter 应切到下一题');
    assert.equal(metaAfter.feedback, false, '切题后不应残留上一题反馈');

    // 2) ESC 关闭 quiz：滚动锁释放并恢复页面滚动位置
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);
    const afterEsc = await page.evaluate(() => ({
      open: document.querySelector('#quiz-dialog').open,
      locked: document.body.classList.contains('dialog-scroll-locked'),
      scrollY: window.scrollY
    }));
    assert.equal(afterEsc.open, false, 'ESC 应关闭做题弹窗');
    assert.equal(afterEsc.locked, false, '关闭后应释放滚动锁');
    assert.ok(Math.abs(afterEsc.scrollY - startY) <= 2, `关闭后应恢复页面滚动位置 ${startY}，实际 ${afterEsc.scrollY}`);

    // 3) 程序题热键：→/n 下一题、←/p 上一题
    await openPracticeQuiz(page);
    const pMeta = () => page.evaluate(() => (document.querySelector('#quiz-dialog .quiz-meta') || {}).textContent || '');
    const p0 = await pMeta();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(220);
    assert.notEqual(await pMeta(), p0, '程序题按 → 应切到下一题');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(220);
    assert.equal(await pMeta(), p0, '程序题按 ← 应切回上一题');
    await page.keyboard.press('n');
    await page.waitForTimeout(220);
    assert.notEqual(await pMeta(), p0, '程序题按 n 应切到下一题');
    await page.keyboard.press('p');
    await page.waitForTimeout(220);
    assert.equal(await pMeta(), p0, '程序题按 p 应切回上一题');
    await page.evaluate(() => document.querySelector('#quiz-dialog').close());
    await page.waitForTimeout(200);

    // 4) 反馈弹窗打开时，做题热键不得穿透（键盘焦点在反馈弹窗内、不是表单控件）
    await openChoiceQuiz(page);
    const beforeBug = await page.evaluate(() => ({
      pressed: Array.from(document.querySelectorAll('#quiz-dialog .option')).map(o => o.getAttribute('aria-pressed')),
      feedback: !!document.querySelector('#quiz-dialog .feedback')
    }));
    await openBugDialog(page);
    await page.evaluate(() => { const d = document.querySelector('#cquest-bug-dialog'); d.tabIndex = -1; d.focus(); });
    const focusTag = await page.evaluate(() => (document.activeElement ? document.activeElement.tagName : ''));
    assert.ok(!/INPUT|SELECT|TEXTAREA/.test(focusTag), `本用例应覆盖「焦点不在输入框」的穿透场景，实际 ${focusTag}`);
    await page.keyboard.press('b');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(220);
    const afterBugKeys = await page.evaluate(() => ({
      pressed: Array.from(document.querySelectorAll('#quiz-dialog .option')).map(o => o.getAttribute('aria-pressed')),
      feedback: !!document.querySelector('#quiz-dialog .feedback'),
      quizOpen: document.querySelector('#quiz-dialog').open,
      bugOpen: !!(document.querySelector('#cquest-bug-dialog') || {}).open,
      locked: document.body.classList.contains('dialog-scroll-locked')
    }));
    assert.deepEqual(afterBugKeys.pressed, beforeBug.pressed, `反馈弹窗打开时按 B 不得改做题选项（焦点 ${focusTag}）`);
    assert.equal(afterBugKeys.feedback, false, '反馈弹窗打开时按 Enter 不得提交做题答案');
    assert.equal(afterBugKeys.quizOpen, true, '反馈弹窗打开时 quiz 应保持打开');
    assert.equal(afterBugKeys.bugOpen, true, '反馈弹窗应保持打开');
    assert.equal(afterBugKeys.locked, mobile, mobile ? '嵌套弹窗时仍应锁定背景滚动' : '桌面端嵌套弹窗不得锁 body');

    // 5) ESC 只关闭顶层反馈弹窗，quiz 与滚动锁保持；再关 quiz 才恢复页面滚动
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);
    const afterFirstEsc = await page.evaluate(() => ({
      quizOpen: document.querySelector('#quiz-dialog').open,
      bugOpen: !!(document.querySelector('#cquest-bug-dialog') || {}).open,
      locked: document.body.classList.contains('dialog-scroll-locked'),
      scrollY: window.scrollY
    }));
    assert.equal(afterFirstEsc.bugOpen, false, 'ESC 应只关闭顶层反馈弹窗');
    assert.equal(afterFirstEsc.quizOpen, true, '关闭反馈弹窗后 quiz 应保持打开');
    assert.equal(afterFirstEsc.locked, mobile, mobile ? '关闭反馈弹窗后背景仍应保持锁定' : '桌面端关闭反馈弹窗后仍不锁 body');
    const expectedLockedScroll = mobile ? 0 : startY;
    assert.equal(afterFirstEsc.scrollY, expectedLockedScroll, mobile ? '锁定期间页面滚动位置应固定为 0' : `桌面端页面滚动位置应保持 ${startY}，实际 ${afterFirstEsc.scrollY}`);
    await page.evaluate(() => document.querySelector('#quiz-dialog').close());
    await page.waitForTimeout(260);
    const afterAllClosed = await page.evaluate(() => ({
      locked: document.body.classList.contains('dialog-scroll-locked'),
      position: getComputedStyle(document.body).position,
      scrollY: window.scrollY
    }));
    assert.equal(afterAllClosed.locked, false, '全部弹窗关闭后应释放滚动锁');
    assert.notEqual(afterAllClosed.position, 'fixed', '全部弹窗关闭后 body 不应 fixed');
    assert.ok(Math.abs(afterAllClosed.scrollY - startY) <= 2, `全部关闭后应恢复页面滚动位置 ${startY}，实际 ${afterAllClosed.scrollY}`);
  });
}

/* 资料弹窗：原题入口与 PDF 整页入口都不能报错、不能空白弹窗。 */
async function scenarioMaterialDialog(env) {
  await withPage(env, async page => {
    await openMap(page, env);
    const question = await page.evaluate(() => {
      const withImage = Q.find(item => item.source && item.sourceImage) || Q.find(item => item.source) || Q[0];
      return { id: withImage.id, source: withImage.source, page: withImage.page, number: withImage.number };
    });
    const scrollBefore = await page.evaluate(() => { window.scrollTo(0, 220); return window.scrollY; });

    // 原题入口（app.js:111-123 openQuestionSource）
    await page.evaluate(id => openQuestionSource(id), question.id);
    await page.waitForSelector('#material-dialog[open]');
    const sourceState = await page.evaluate(() => {
      const dialog = document.querySelector('#material-dialog');
      const rect = dialog.getBoundingClientRect();
      const content = document.querySelector('#reader-content');
      return {
        open: dialog.open,
        title: (document.querySelector('#reader-title') || {}).textContent || '',
        href: (document.querySelector('#reader-link') || {}).href || '',
        contentLength: content ? content.innerHTML.length : 0,
        contentText: content ? content.innerText.trim() : '',
        horizontalOverflow: dialog.scrollWidth - dialog.clientWidth,
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        locked: document.body.classList.contains('dialog-scroll-locked'),
        display: getComputedStyle(dialog).display
      };
    });
    assert.equal(sourceState.open, true, '原题入口应打开资料弹窗');
    assert.notEqual(sourceState.display, 'none', '资料弹窗不应隐藏');
    assert.ok(/原题/.test(sourceState.title), `资料弹窗标题应包含「原题」，实际「${sourceState.title}」`);
    assert.ok(sourceState.href.startsWith('http') && sourceState.href.includes('#page='), `「新窗口阅读」链接应可跳转，实际 ${sourceState.href}`);
    assert.ok(sourceState.contentLength > 120, `原题内容不应为空，实际 innerHTML ${sourceState.contentLength} 字符`);
    assert.ok(sourceState.rect.height <= sourceState.innerHeight + 1 && sourceState.rect.width <= sourceState.innerWidth + 1, `资料弹窗应完整在视口内：${JSON.stringify(sourceState.rect)} vs ${sourceState.innerWidth}x${sourceState.innerHeight}`);
    assert.ok(sourceState.horizontalOverflow <= 1, `资料弹窗横向溢出 ${sourceState.horizontalOverflow}px`);
    if (env.width <= 760) assert.equal(sourceState.locked, true, '手机端资料弹窗应锁定背景滚动');

    // PDF 整页入口：getPracticePDF 已被上游提交 fa4c708 移除（全仓库无定义），
    // 正确行为是弹窗保持打开并显示明确降级说明（可点「新窗口阅读」），而不是空白或未捕获异常。
    const hasHeadingButton = await page.evaluate(() => !!document.querySelector('#reader-content .reader-question-heading button'));
    if (hasHeadingButton) await page.locator('#reader-content .reader-question-heading button').click();
    else await page.evaluate(q => openMaterial(q.source, q.page || 1), question);
    await page.waitForTimeout(700);
    const pdfState = await page.evaluate(() => {
      const content = document.querySelector('#reader-content');
      const canvas = document.querySelector('#reader-canvas');
      return {
        title: (document.querySelector('#reader-title') || {}).textContent || '',
        text: content ? content.innerText.trim() : '',
        htmlLength: content ? content.innerHTML.length : 0,
        canvasWidth: canvas ? canvas.width : 0,
        controls: !!content && !!content.querySelector('.reader-controls'),
        loadingText: content && content.querySelector('.reader-loading') ? content.querySelector('.reader-loading').textContent.trim() : ''
      };
    });
    assert.ok(/第\s*\d+\s*页/.test(pdfState.title), `整页阅读标题应包含页码，实际「${pdfState.title}」`);
    assert.ok(pdfState.text.length >= 10, `整页阅读内容不应空白，实际「${pdfState.text}」`);
    assert.ok(pdfState.controls, '整页阅读应展示翻页控件');
    assert.ok(pdfState.canvasWidth !== 300 || pdfState.text.includes('无法在此处显示 PDF'), '整页阅读应渲染 PDF 画布（宽度≠默认 300）或给出明确降级说明');
    assert.ok(!/正在打开/.test(pdfState.loadingText), `整页阅读不应停留在「正在打开」加载态，实际「${pdfState.loadingText}」`);

    // 关闭按钮 + 滚动恢复
    await page.locator('#material-dialog button[aria-label="关闭资料阅读"]').click();
    await page.waitForTimeout(260);
    const afterClose = await page.evaluate(() => ({
      open: document.querySelector('#material-dialog').open,
      locked: document.body.classList.contains('dialog-scroll-locked'),
      position: getComputedStyle(document.body).position,
      scrollY: window.scrollY
    }));
    assert.equal(afterClose.open, false, '关闭按钮应关闭资料弹窗');
    assert.equal(afterClose.locked, false, '关闭资料弹窗后应释放滚动锁');
    assert.notEqual(afterClose.position, 'fixed', '关闭资料弹窗后 body 不应 fixed');
    if (env.width <= 760) assert.ok(Math.abs(afterClose.scrollY - scrollBefore) <= 2, `关闭资料弹窗后应恢复页面滚动 ${scrollBefore}，实际 ${afterClose.scrollY}`);
  });
}

/* ---------------- 主流程 ---------------- */

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = process.env.TEST_BASE_URL || `http://127.0.0.1:${server.address().port}/`;
  console.log(`微信手机布局测试（build=${build}）`);
  let browser = null;
  try {
    try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
    catch (error) { browser = await chromium.launch({ headless: true }); }
    const origin = new URL(url).origin;
    for (const testCase of CASES) {
      currentWidth = testCase.width;
      const mobile = testCase.width <= 760;
      const context = await browser.newContext({
        viewport: { width: testCase.width, height: testCase.height },
        screen: { width: testCase.width, height: testCase.height },
        isMobile: mobile,
        hasTouch: mobile,
        userAgent: WECHAT_UA,
        deviceScaleFactor: mobile ? 2.75 : 1
      });
      // 只允许本服务，阻断一切外网请求（含 CDN / 模型接口 / 统计）
      await context.route('**/*', route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === origin) route.continue();
        else route.abort();
      });
      const env = { browser, url, width: testCase.width, height: testCase.height, context, pageErrors: [] };
      console.log(`\n[${testCase.width}x${testCase.height}${mobile ? ' 微信手机' : ' 桌面'}]`);
      try {
        await check('关闭状态弹窗隐藏 / 无横向溢出 / --app-height / text-size-adjust', () => scenarioBasic(env));
        await check('六个主视图无页面级横向溢出', () => scenarioViewsOverflow(env));
        if (mobile) {
          await check('地址栏伸缩：360x640 可视高下底栏按钮可见可点', () => scenarioAddressBar(env));
          if (testCase.width === 360) await check('地址栏伸缩：360x780 可视高下底栏按钮可见可点', () => scenarioAddressBar(env, 780));
          await check('底部安全区：刘海屏 34px 时导航/底栏/反馈弹窗留白', () => scenarioSafeArea(env));
          await check('软键盘：account 表单输入框不被遮挡', () => scenarioKeyboardAccount(env));
          await check('软键盘：反馈弹窗 textarea 不被遮挡', () => scenarioKeyboardBugDialog(env));
          await check('滚动锁+嵌套弹窗：背景不滚/不穿透/关闭恢复', () => scenarioScrollLockNested(env));
          await check('字体放大 1.4x：不溢出/不重叠/不裁切', () => scenarioFontScale(env));
          await check('横竖屏切换：弹窗高度/滚动/底栏', () => scenarioLandscape(env));
          await check('触控目标≥44px：地图/做题/反馈/更多菜单', () => scenarioTouchTargets(env));
        } else {
          await check('桌面端不回归：弹窗宽度/sticky 底栏/无滚动锁', () => scenarioDesktopRegression(env));
        }
        await check('切题滚动复位：.quiz-body 回到顶部（选择/程序题）', () => scenarioQuizScrollReset(env));
        await check('键盘操作：A–E/Enter/方向键/ESC 与关闭后滚动恢复', () => scenarioKeyboardOps(env));
        await check('资料弹窗：原题入口与 PDF 整页入口不报错不空白', () => scenarioMaterialDialog(env));
        await check('无 pageerror', async () => { assert.deepEqual(env.pageErrors, [], `页面运行时报错：${env.pageErrors.join(' | ')}`); });
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }

  console.log(`\n合计：${passCount} 项 PASS，${failures.length} 项 FAIL`);
  if (failures.length) {
    console.error('失败项：');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
