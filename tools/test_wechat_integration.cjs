'use strict';
// 微信手机端跨域集成回归：闯关/随机/原题自练/连续点击/异步讲解/反馈嵌套/断网草稿/刷新恢复。
// 全新独立浏览器上下文，只访问本地构建预览，绝不连接真实浏览器资料目录。
// 不注册、不发邮件、不调用付费模型：DeepSeek 与 Supabase RPC 全部由本地路由桩接管。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('D:/npm-global/node_modules/playwright')); }

const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'), 'utf8')).path;

// 华为 Mate 40 Pro 微信 WebView（模拟 UA，仅兼容性模拟，不代表真机微信验收）
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
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// 还原 bug-report.js 的 encodeQuestionId：_<hex> -> 码点（自练题 id 含中文，提交前被 ASCII 编码）
function decodeQuestionId(encoded) {
  return String(encoded || '').replace(/_([0-9a-f]+)/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function makeStub() {
  return { mode: 'ok', aiMode: 'ok', aiDelay: 0, aiTag: '桩讲解', calls: [], submits: [], aiCalls: 0 };
}

async function newPage(context, origin, stub) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    // 1) 云 RPC（Supabase 跨域）由本地桩接管，永不触达线上服务
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const action = url.pathname.split('/').pop();
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch {}
      stub.calls.push({ action, body, headers: route.request().headers() });
      if (stub.mode === 'offline') { await route.abort('failed'); return; }
      if (stub.mode === 'timeout') {
        await new Promise(r => setTimeout(r, 150));
        await route.abort('timedout');
        return;
      }
      if (stub.mode === '500') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'boom' }) });
        return;
      }
      if (action === 'cquest_bug_submit') {
        stub.submits.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, id: body.report_id }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
      return;
    }
    // 2) 本站资源正常放行
    if (url.origin === origin) { await route.continue(); return; }
    // 3) DeepSeek API 由本地桩接管（可延时，模拟异步讲解晚到）
    if (url.hostname === 'api.deepseek.com') {
      stub.aiCalls++;
      if (stub.aiMode === 'offline') { await route.abort('failed'); return; }
      if (stub.aiDelay) await new Promise(r => setTimeout(r, stub.aiDelay));
      if (stub.aiMode === 'error') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'stub failure' } }) });
        return;
      }
      const lesson = { hint: '桩提示', explanation: '桩讲解：' + stub.aiTag, steps: ['第一步'], code: '', takeaway: '桩记忆点' };
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(lesson) } }] })
      });
      return;
    }
    // 4) 其余外部请求（含本机辅导桥）一律阻断，保证测试隔离且不触达本机服务
    await route.abort('failed');
  });
  return { page, errors };
}

async function gotoMap(page, origin) {
  await page.goto(origin + '/#map', { waitUntil: 'domcontentloaded' });
  await page.locator('.chapters').waitFor({ timeout: 15000 });
}

async function waitQuiz(page) {
  await page.waitForSelector('#quiz-dialog[open] .quiz-body', { timeout: 12000 });
}

async function waitQuizClosed(page) {
  await page.waitForFunction(() => { const d = document.querySelector('#quiz-dialog'); return d && !d.open; }, null, { timeout: 12000 });
}

// 单字母答案的题目集合，保证集成流程可确定性地点击选项
function pickChoiceIds(page, count) {
  return page.evaluate(n => {
    const pool = Q.filter(q => typeof q.answer === 'string' && /^[A-E]$/.test(q.answer) &&
      Array.isArray(q.options) && q.options.length >= 2);
    return pool.slice(0, n).map(q => q.id);
  }, count);
}

async function startQuizWithIds(page, ids, label) {
  await page.evaluate(({ ids, label }) => {
    const qs = ids.map(id => Q.find(q => q.id === id));
    startQuiz(qs, label || '集成测试');
  }, { ids, label });
  await waitQuiz(page);
}

// 点击当前题的某个选项（correct=true 选正确项，false 选错误项）
async function chooseOption(page, correct) {
  return page.evaluate(wantCorrect => {
    const q = currentQ();
    const answer = String(q.answer || '').toUpperCase();
    const options = [...document.querySelectorAll('#quiz-dialog .option')];
    const mapped = options.map(b => ({ b, letter: (b.querySelector('.letter')?.textContent || '').trim() }));
    const target = mapped.find(x => x.letter === answer);
    const other = mapped.find(x => x.letter !== answer);
    const pick = wantCorrect ? target : other;
    if (!pick) throw new Error('没有可点击的选项: ' + answer);
    pick.b.click();
    return pick.letter;
  }, correct);
}

async function submitAnswer(page) {
  await page.waitForSelector('#submit-answer', { timeout: 8000 });
  await page.click('#submit-answer');
  await page.waitForSelector('#quiz-dialog button[onclick="nextQuestion()"]', { timeout: 8000 });
}

async function clickNext(page) {
  const before = await page.evaluate(() => ({ index: quiz.index, total: quiz.ids.length, finished: quiz.finished }));
  await page.click('#quiz-dialog button[onclick="nextQuestion()"]');
  await page.waitForTimeout(60);
  return before;
}

async function readQuizState(page) {
  return page.evaluate(() => ({
    index: quiz ? quiz.index : -1,
    total: quiz ? quiz.ids.length : 0,
    results: quiz ? quiz.results.length : 0,
    finished: quiz ? quiz.finished : null,
    selected: Array.isArray(selected) ? selected.slice() : [],
    session: state.session,
    dialogOpen: !!document.querySelector('#quiz-dialog')?.open,
    resultPage: !!document.querySelector('#quiz-dialog button[onclick="closeQuiz()"]')
  }));
}

/* ============================ 用例 ============================ */

// 1) 地图闯关真实点击链路：进入关卡 → 逐题作答 → 结果页 → 返回地图 → 进度落盘
async function testMapFlow(page, origin, width) {
  await gotoMap(page, origin);
  const level = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.level.choice-level')].find(x => !x.classList.contains('locked'));
    return b ? { label: (b.innerText || '').replace(/\s+/g, ' ').trim() } : null;
  });
  ok(!!level, `${width}: 地图上应有可进入的闯关关卡`);
  await page.locator('.level.choice-level:not(.locked)').first().click();
  await waitQuiz(page);

  let guard = 0;
  for (;;) {
    guard++;
    ok(guard < 80, `${width}: 闯关答题循环不应失控`);
    const state = await readQuizState(page);
    if (state.resultPage || state.finished) break;
    if (await page.$('#submit-answer')) {
      await chooseOption(page, true);
      await submitAnswer(page);
      continue;
    }
    if (await page.$('#quiz-dialog button[onclick="nextQuestion()"]')) {
      await clickNext(page);
      continue;
    }
    throw new Error(`${width}: 闯关题面既无提交也无下一题按钮，index=${state.index}`);
  }
  const state = await readQuizState(page);
  ok(state.finished === true, `${width}: 闯关应正常结束（不卡在答题态），实际 ${JSON.stringify(state)}`);
  ok(state.resultPage, `${width}: 结束应显示结果页`);
  const title = clean(await page.locator('#quiz-dialog h2#quiz-title').innerText());
  ok(/完成|通关|再来/.test(title), `${width}: 结果页标题异常: ${title}`);

  await page.click('#quiz-dialog button[onclick="closeQuiz()"]');
  await waitQuizClosed(page);
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem('c-quest-progress-v1') || '{}';
    const parsed = JSON.parse(raw);
    return { hasSession: !!parsed.session, answers: Object.keys(parsed.answers || {}).length, levels: Object.keys(parsed.levels || {}).length };
  });
  ok(persisted.answers > 0, `${width}: 作答应写入本地进度`);
  ok(persisted.hasSession === false, `${width}: 结束闯关后不应残留未完成 session`);
}

// 2) 随机挑战：生成 → 作答 → × 关闭 → 不残留卡死状态
async function testRandomChallenge(page, origin, width) {
  await page.goto(origin + '/#random', { waitUntil: 'domcontentloaded' });
  await page.locator('#random-size').waitFor({ timeout: 12000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#app button')].find(x => /生成挑战/.test(x.textContent || ''));
    if (!b) throw new Error('未找到生成挑战按钮');
    b.click();
  });
  await waitQuiz(page);
  const label = clean(await page.locator('#quiz-title').innerText());
  ok(/随机|挑战/.test(label), `${width}: 随机挑战弹窗标题异常: ${label}`);
  const before = await readQuizState(page);
  ok(before.total > 0, `${width}: 随机挑战应有题目`);

  // 答一题后直接用 × 关闭（保存并关闭练习）
  await chooseOption(page, true);
  await submitAnswer(page);
  await page.click('#quiz-dialog button[aria-label="保存并关闭练习"]');
  await waitQuizClosed(page);
  const after = await readQuizState(page);
  ok(after.dialogOpen === false, `${width}: 随机挑战关闭后弹窗应关闭`);
  const stillUsable = await page.evaluate(() => {
    document.querySelector('#navigation a[href="#map"]')?.click();
    return true;
  });
  ok(stillUsable, `${width}: 关闭后应能继续导航`);
  await page.locator('.chapters').waitFor({ timeout: 12000 });
}

// 3) 原题自练：草稿 → 展开答案 → 下一题/上一题往返 → 关闭
async function testPracticeUnit(page, origin, width) {
  await gotoMap(page, origin);
  const picked = await page.evaluate(() => {
    const lv = allLevels().find(l => l.type === 'practice' && Array.isArray(l.questions) && l.questions.length >= 2);
    if (!lv) return null;
    return { id: lv.id, units: lv.questions.length, firstId: lv.questions[0].id };
  });
  ok(!!picked, `${width}: 应存在原题自练关卡`);
  await page.evaluate(id => {
    const lv = allLevels().find(l => l.id === id);
    startPracticeLevel(lv);
  }, picked.id);
  await waitQuiz(page);
  ok(await page.$('#quiz-dialog .practice-quiz-body'), `${width}: 自练弹窗应使用 practice-quiz-body`);

  await page.fill('#practice-quiz-draft-input', '集成测试草稿：指针与数组');
  await page.click('#quiz-dialog .toggle-answer-btn');
  ok(await page.isVisible('#practice-quiz-answer-section'), `${width}: 展开后参考答案区应可见`);

  const geo = await page.evaluate(() => {
    const d = document.querySelector('#quiz-dialog');
    const body = d.querySelector('.quiz-body');
    return { docOverflow: document.documentElement.scrollWidth - window.innerWidth, dsw: d.scrollWidth - d.clientWidth, bodyOverflow: body.scrollWidth - body.clientWidth };
  });
  ok(geo.docOverflow <= 2, `${width}: 自练弹窗打开时页面不应横向溢出（${geo.docOverflow}px）`);
  ok(geo.dsw <= 2, `${width}: 自练弹窗内部不应横向溢出（${geo.dsw}px）`);

  await page.click('#quiz-dialog button[onclick="nextPracticeQuestion()"]');
  await page.waitForTimeout(120);
  let st = await readQuizState(page);
  ok(await page.evaluate(() => practiceQuiz.index) === 1, `${width}: 自练下一题应前进 1 题`);
  await page.click('#quiz-dialog button[onclick="prevPracticeQuestion()"]');
  await page.waitForTimeout(120);
  ok(await page.evaluate(() => practiceQuiz.index) === 0, `${width}: 自练上一题应回到第 1 题`);
  const draft = await page.inputValue('#practice-quiz-draft-input');
  ok(draft.includes('集成测试草稿'), `${width}: 往返切题后草稿应保留，实际: ${draft}`);

  await page.click('#quiz-dialog button[aria-label="保存并关闭"]');
  await waitQuizClosed(page);
  const closeState = await readQuizState(page);
  ok(closeState.session !== undefined, `${width}: 关闭自练后状态仍可读取`);
}

// 4) 超长题干/代码：内部可滚动、无横向溢出、按钮可触达
async function testLongQuestionLayout(page, origin, width) {
  await gotoMap(page, origin);
  const item = await page.evaluate(() => {
    const pool = Q.filter(q => typeof q.answer === 'string' && /^[A-E]$/.test(q.answer) && Array.isArray(q.options) && q.options.length >= 2);
    const q = pool.reduce((a, b) => ((b.stem || '').length > (a.stem || '').length ? b : a));
    return { id: q.id, len: (q.stem || '').length };
  });
  await startQuizWithIds(page, [item.id], '长题干');
  const geo = await page.evaluate(() => {
    const d = document.querySelector('#quiz-dialog');
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      dsw: d.scrollWidth - d.clientWidth,
      scrollable: d.scrollHeight > d.clientHeight,
      innerBodyScrollable: (() => { const b = d.querySelector('.quiz-body'); return b ? b.scrollHeight > b.clientHeight : false; })()
    };
  });
  ok(geo.docOverflow <= 2, `${width}: 长题干页面不应横向溢出（${geo.docOverflow}px）`);
  ok(geo.dsw <= 2, `${width}: 长题干弹窗不应横向溢出（${geo.dsw}px）`);
  ok(geo.scrollable || geo.innerBodyScrollable, `${width}: 长内容应可在弹窗内滚动`);

  await page.evaluate(() => {
    const d = document.querySelector('#quiz-dialog');
    d.scrollTop = d.scrollHeight;
    const b = d.querySelector('.quiz-body');
    if (b) b.scrollTop = b.scrollHeight;
  });
  await page.waitForTimeout(120);
  const btn = await page.evaluate(() => {
    const el = document.querySelector('#submit-answer');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: r.height, vh: window.innerHeight, vw: window.innerWidth, right: r.right };
  });
  ok(btn && (width > 760 || btn.h >= 44), `${width}: 长题干滚动后提交按钮触控高度应达标，实际 ${JSON.stringify(btn)}`);
  ok(btn && btn.top >= -2 && btn.bottom <= btn.vh + 2, `${width}: 长题干滚动后提交按钮应完整出现在视口内，实际 ${JSON.stringify(btn)}`);
  ok(btn && btn.right <= btn.vw + 2, `${width}: 提交按钮不应超出右边界`);
}

// 5) 连续点击：同步连点提交/下一题/查看成绩，不得跳题、重复计分或反复重开
async function testRapidClicks(page, origin, width) {
  await gotoMap(page, origin);
  const ids = await pickChoiceIds(page, 3);
  ok(ids.length === 3, `${width}: 需要至少 3 道单字母题`);
  await startQuizWithIds(page, ids, '连点测试');

  await chooseOption(page, true);
  // 同步连点两次“确认答案”
  await page.evaluate(() => { const b = document.querySelector('#submit-answer'); b.click(); b.click(); });
  await page.waitForSelector('#quiz-dialog button[onclick="nextQuestion()"]', { timeout: 8000 });
  await page.waitForTimeout(80);
  let st = await readQuizState(page);
  ok(st.results === 1, `${width}: 连点提交只应记录 1 次作答，实际 ${st.results}`);

  // 同步连点两次“下一题”
  await page.evaluate(() => { const b = document.querySelector('#quiz-dialog button[onclick="nextQuestion()"]'); b.click(); b.click(); });
  await page.waitForTimeout(120);
  st = await readQuizState(page);
  ok(st.index === 1, `${width}: 连点下一题只应前进 1 题，实际 index=${st.index}`);
  ok(st.results === 1, `${width}: 连点下一题不应产生额外作答，实际 ${st.results}`);

  // 依次答完剩余题目直到最后一题
  for (let i = 1; i < ids.length; i++) {
    await chooseOption(page, true);
    await submitAnswer(page);
    if (i < ids.length - 1) await clickNext(page);
  }
  // 答最后一题后同步连点两次“查看本次成绩”
  await page.evaluate(() => { const b = document.querySelector('#quiz-dialog button[onclick="nextQuestion()"]'); b.click(); b.click(); });
  await page.waitForTimeout(150);
  st = await readQuizState(page);
  ok(st.finished === true, `${width}: 查看成绩后 quiz 应结束: ${JSON.stringify({ finished: st.finished, index: st.index, results: st.results, resultPage: st.resultPage })}`);
  ok(st.resultPage === true, `${width}: 连点查看成绩后应停在结果页`);
  const content = clean(await page.locator('#quiz-dialog').innerText());
  ok(!/第\s*0*[0-9]+\s*题|01\s*\/\s*0*[0-9]+/.test(content), `${width}: 结果页不应被误重开成答题页`);
  await page.click('#quiz-dialog button[onclick="closeQuiz()"]');
  await waitQuizClosed(page);
}

// 6) 异步 AI 讲解晚到：切题后返回，不得覆盖新题、丢选择或卡死
async function testLateTeaching(page, origin, width, stub) {
  await gotoMap(page, origin);
  const ids = await pickChoiceIds(page, 2);
  stub.aiDelay = 900;
  stub.aiTag = '晚到讲解-' + width;
  try {
    await startQuizWithIds(page, ids, '异步讲解');
    await chooseOption(page, false);
    await submitAnswer(page);
    // 讲解请求尚在途中就切到下一题
    await clickNext(page);
    let st = await readQuizState(page);
    ok(st.index === 1, `${width}: 异步讲解期间应能正常切题`);
    await page.waitForTimeout(1600);
    st = await readQuizState(page);
    ok(st.index === 1, `${width}: 晚到的讲解不应把题目切回上一题，实际 index=${st.index}`);
    const info = await page.evaluate(() => ({
      cur: currentQ()?.id,
      teaching: state.teaching || {},
      panel: (document.querySelector('#quiz-dialog .ai-teaching')?.innerText || ''),
      selectedLen: selected.length,
      dialogOpen: !!document.querySelector('#quiz-dialog')?.open
    }));
    ok(info.cur === ids[1], `${width}: 当前题应保持为第 2 题，实际 ${info.cur}`);
    ok(info.dialogOpen, `${width}: 晚到讲解不应关闭答题弹窗`);
    const firstTeaching = info.teaching[ids[0]];
    ok(firstTeaching && firstTeaching.status === 'answered', `${width}: 上一题的讲解应被记录为已收到，实际 ${JSON.stringify(firstTeaching && firstTeaching.status)}`);
    ok(!info.panel.includes('晚到讲解-' + width), `${width}: 上一题讲解不应渲染到当前题上`);
    // 当前题仍可正常选择并提交
    await chooseOption(page, true);
    await submitAnswer(page);
    const after = await readQuizState(page);
    ok(after.results === 2, `${width}: 晚到讲解后当前题仍可正常提交`);
  } finally {
    stub.aiDelay = 0;
    stub.aiTag = '桩讲解';
  }
}

// 7) 反馈嵌套在答题弹窗上 + 断网失败保留草稿 + 恢复后去重提交，关闭后回到原题
async function testNestedFeedbackOffline(page, origin, width, stub) {
  await gotoMap(page, origin);
  const ids = await pickChoiceIds(page, 2);
  await startQuizWithIds(page, ids, '反馈嵌套');
  await chooseOption(page, true);
  await submitAnswer(page);
  const before = await readQuizState(page);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#quiz-dialog button')].find(x => /反馈此题/.test(x.textContent || ''));
    if (!b) throw new Error('未找到反馈此题按钮');
    b.click();
  });
  await page.waitForSelector('#cquest-bug-dialog[open]', { timeout: 8000 });
  ok(await page.evaluate(() => document.querySelector('#quiz-dialog').open), `${width}: 打开反馈时答题弹窗应保持打开`);

  stub.mode = 'offline';
  const desc = '集成测试：微信弱网下提交失败，草稿必须保留并可重试。';
  await page.fill('#cquest-bug-desc', desc);
  await page.click('#cquest-bug-submit');
  await page.waitForFunction(() => {
    const s = document.querySelector('#cquest-bug-status');
    return s && s.textContent.trim().length > 0;
  }, null, { timeout: 15000 });
  const statusText = clean(await page.locator('#cquest-bug-status').innerText());
  ok(statusText.length > 0 && !/已提交/.test(statusText), `${width}: 断网提交应显示失败原因而不是成功，实际: ${statusText}`);
  const draft = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('cquest-bug-draft-v1') || 'null'); } catch { return null; }
  });
  ok(draft && String(draft.description || '').includes('弱网'), `${width}: 断网失败应保留反馈草稿`);
  const reportId = draft && draft.reportId;
  ok(typeof reportId === 'string' && reportId.length > 0, `${width}: 草稿应带 reportId 以便去重`);
  ok(stub.submits.length === 0, `${width}: 断网时不应记录成功的提交`);

  await page.click('#cquest-bug-cancel');
  await page.waitForFunction(() => !document.querySelector('#cquest-bug-dialog').open, null, { timeout: 8000 });
  const afterCancel = await readQuizState(page);
  ok(afterCancel.dialogOpen && afterCancel.index === before.index, `${width}: 关闭反馈后应回到原题原进度`);
  ok(afterCancel.results === before.results, `${width}: 关闭反馈后作答进度不应丢失`);
  ok(await page.evaluate(() => document.body.style.position === '' || document.body.style.position === 'static'), `${width}: 反馈关闭后应解除页面滚动锁`);

  // 恢复网络：重新打开，草稿与 reportId 恢复，提交沿用同一 reportId（服务端幂等去重）
  stub.mode = 'ok';
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#quiz-dialog button')].find(x => /反馈此题/.test(x.textContent || ''));
    b.click();
  });
  await page.waitForSelector('#cquest-bug-dialog[open]', { timeout: 8000 });
  const restored = await page.inputValue('#cquest-bug-desc');
  ok(restored.includes('弱网'), `${width}: 重新打开反馈应恢复草稿`);
  const submitCountBefore = stub.submits.length;
  const why = [];
  if (!stub.submits.length) why.push('无提交');
  await page.click('#cquest-bug-submit');
  await page.waitForFunction(() => !document.querySelector('#cquest-bug-dialog').open, null, { timeout: 15000 });
  ok(stub.submits.length === submitCountBefore + 1, `${width}: 恢复网络后应成功提交一次`);
  const sent = stub.submits[stub.submits.length - 1];
  ok(sent.report_id === reportId, `${width}: 重试应沿用同一 report_id 去重`);
  const sentCtx = sent.payload && sent.payload.context;
  ok(sentCtx && decodeQuestionId(sentCtx.questionId) === ids[0], `${width}: 反馈应带当前题号 ${ids[0]}，实际 ${JSON.stringify(sentCtx)}`);
  ok(sentCtx && sentCtx.position === 1 && sentCtx.mode === 'choice', `${width}: 反馈 position/mode 应正确，实际 ${JSON.stringify(sentCtx)}`);
  const afterSubmit = await readQuizState(page);
  ok(afterSubmit.dialogOpen && afterSubmit.results === before.results, `${width}: 反馈提交后应回到原题并保留作答`);
  // 反馈已成功，可继续下一题
  await clickNext(page);
  const nextState = await readQuizState(page);
  ok(nextState.index === 1, `${width}: 反馈流程后仍能正常下一题`);
}

// 8) 刷新恢复：答题中途刷新 → 继续上次练习 → 回到同一题且作答记录保留
async function testResumeAfterReload(page, origin, width) {
  await gotoMap(page, origin);
  const ids = await pickChoiceIds(page, 3);
  await startQuizWithIds(page, ids, '刷新恢复');
  await chooseOption(page, true);
  await submitAnswer(page);
  await clickNext(page);
  let st = await readQuizState(page);
  ok(st.index === 1, `${width}: 刷新前应处于第 2 题`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.chapters').waitFor({ timeout: 15000 });
  const continueBtn = page.locator('#app button', { hasText: '继续上次练习' }).first();
  await continueBtn.waitFor({ timeout: 8000 });
  await continueBtn.click();
  await waitQuiz(page);
  st = await readQuizState(page);
  ok(st.index === 1, `${width}: 刷新恢复后应回到第 2 题，实际 index=${st.index}`);
  ok(st.results >= 1, `${width}: 刷新恢复后已完成作答应保留，实际 ${st.results}`);
  const hasFirstResult = await page.evaluate(id => {
    try { return !!quiz.results[0] && quiz.results[0].id === id; } catch { return false; }
  }, ids[0]);
  ok(hasFirstResult, `${width}: 刷新恢复后第 1 题的作答记录应属于该题`);
  await page.click('#quiz-dialog button[aria-label="保存并关闭练习"]');
  await waitQuizClosed(page);
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
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cquest-ai-config-v1', JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash', automatic: true, thinking: false }));
      sessionStorage.setItem('cquest-deepseek-key-v1', 'sk-test-integration-0123456789abcdef');
    } catch {}
  });
  const stub = makeStub();
  const { page, errors } = await newPage(context, origin, stub);
  try {
    await testMapFlow(page, origin, width);
    await testRandomChallenge(page, origin, width);
    await testPracticeUnit(page, origin, width);
    await testLongQuestionLayout(page, origin, width);
    await testRapidClicks(page, origin, width);
    await testLateTeaching(page, origin, width, stub);
    await testNestedFeedbackOffline(page, origin, width, stub);
    await testResumeAfterReload(page, origin, width);
    assert.deepEqual(errors, [], `${width}: 全流程不应有 JS 错误: ` + errors.join(' | '));
    console.log(`PASS ${width}px: 闯关/随机/自练/长题干/连点/异步讲解/反馈断网/刷新恢复`);
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
        try { console.error(e.stack.split('\n').slice(0, 5).join('\n')); } catch {}
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n微信端跨域集成测试：通过 ${results.pass} 项，失败 ${results.fail} 项`);
  if (results.fail) {
    console.error(results.errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
}

run().catch(e => { console.error(e); process.exitCode = 1; });
