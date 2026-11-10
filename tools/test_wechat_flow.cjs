'use strict';
// 域 1 练习流程健壮性回归（微信端适配）。
// 全新浏览器与全新 context，不连接用户浏览器资料目录；外部请求统一 abort。
// 覆盖：反馈上下文字段、键盘作答、切题/同题重渲染滚动、长题干与长解析、
//       触摸连点保护、自练流程（草稿/AI 异步讲解/题号校验/进度恢复）、
//       反馈弹窗嵌套与 ESC 关闭恢复、云端事件、刷新恢复、结果页完整可见。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('D:/npm-global/node_modules/playwright')); }

const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'))).path;
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

const WIDTHS = [360, 390, 430, 768, 1200];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHOICE_IDS = ['n7-1', 'n7-2'];

function noPageErrors(errors, label) {
  assert.deepEqual(errors, [], label + '：不应出现 pageerror：' + errors.join(' | '));
}

async function startChoiceQuiz(page, label) {
  await page.evaluate(({ ids, label }) => {
    startQuiz(ids.map(id => Q.find(q => q.id === id)), label);
  }, { ids: CHOICE_IDS, label });
  await page.locator('#quiz-dialog[open] .quiz-body').waitFor();
}

// 1) 反馈上下文：上一轮 quiz 残留时，自练必须上报 practice 模式与当前题号。
async function runFeedbackContext(page, errors) {
  const first = await page.evaluate(ids => {
    startQuiz(ids.map(id => Q.find(q => q.id === id)), '上一轮闯关');
    pauseQuiz();
    const level = allLevels().filter(l => l.type === 'practice' && (l.questions || []).length).find(l => l.questions.length > 1);
    startPracticeLevel(level);
    return {
      quizCleared: quiz === null,
      practiceCleared: practiceQuiz === null,
      firstId: currentPracticeQ().id,
      context: getBugReportContext()
    };
  }, CHOICE_IDS);
  assert.equal(first.quizCleared, true, 'startPracticeLevel 必须清空上一轮 quiz');
  assert.equal(first.context.mode, 'practice', '自练中反馈上下文 mode 必须是 practice');
  assert.equal(first.context.questionId, first.firstId, '自练中反馈上下文应指向当前自练题');
  assert.equal(first.context.position, 1);

  const reverse = await page.evaluate(ids => {
    pausePracticeQuiz();
    startQuiz(ids.map(id => Q.find(q => q.id === id)), '反向闯关');
    return { practiceCleared: practiceQuiz === null, context: getBugReportContext() };
  }, CHOICE_IDS);
  assert.equal(reverse.practiceCleared, true, 'startQuiz 必须清空上一轮 practiceQuiz');
  assert.deepEqual(
    { mode: reverse.context.mode, id: reverse.context.questionId, pos: reverse.context.position },
    { mode: 'choice', id: CHOICE_IDS[0], pos: 1 },
    '闯关中反馈上下文必须是 choice + 当前题号'
  );
  await page.evaluate(() => pauseQuiz());
  noPageErrors(errors, '反馈上下文');
}

// 2) 键盘作答：A–E / Enter 与自练 ←/→ 不得因 #material-dialog 不存在而抛错。
async function runKeyboard(page, errors) {
  await startChoiceQuiz(page, '键盘作答');
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => selected.join('')), 'B', '键盘 B 应选中 B');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => quiz.results.length), 1, 'Enter 应提交答案');
  assert.equal(await page.evaluate(() => !!document.querySelector('#quiz-dialog .feedback')), true, '提交后应出现答案反馈');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => quiz.index), 1, 'Enter 应进入下一题');
  await page.keyboard.press('b');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => quiz.finished), true, '最后一题 Enter 应出成绩');
  await page.evaluate(() => closeQuiz());

  await page.evaluate(() => {
    const level = allLevels().filter(l => l.type === 'practice' && (l.questions || []).length >= 3)[0];
    startPracticeLevel(level);
  });
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => practiceQuiz.index), 1, '自练 ArrowRight 应下一题');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => practiceQuiz.index), 0, '自练 ArrowLeft 应上一题');
  await page.keyboard.press('n');
  assert.equal(await page.evaluate(() => practiceQuiz.index), 1, '自练 n 应下一题');
  await page.evaluate(() => pausePracticeQuiz());
  noPageErrors(errors, '键盘作答');
}

// 3) 长题干 + 长 AI 解析：同题重渲染保持滚动、主按钮可触摸、切题回顶、内容可滚到底。
async function runLongContent(page, errors) {
  const info = await page.evaluate(() => {
    const sorted = [...Q].sort((a, b) => (b.stem.length + b.options.join('').length) - (a.stem.length + a.options.join('').length));
    startQuiz([sorted[0], sorted[1]], '长题干滚动');
    const body = document.querySelector('#quiz-dialog .quiz-body');
    body.scrollTop = body.scrollHeight;
    return { id: sorted[0].id, scrollable: body.scrollHeight - body.clientHeight > 80, prev: body.scrollTop };
  });
  assert.ok(info.scrollable, '最长选择题应出现滚动（宽度下仍应可滚）');
  assert.ok(info.prev > 0);
  // 同题重渲染（选择答案）后滚动位置保持
  await page.evaluate(() => {
    const q = currentQ();
    const wrong = q.options.map((_, i) => String.fromCharCode(65 + i)).find(l => l !== q.answer.slice(0, 1));
    choose(wrong);
  });
  let after = await page.evaluate(() => document.querySelector('#quiz-dialog .quiz-body').scrollTop);
  assert.ok(Math.abs(after - info.prev) <= 8, '同题选择重渲染后滚动应保持（' + info.prev + ' → ' + after + '）');
  // 提交后长解析 + AI 讲解异步到达（同一题重渲染）：滚动保持且主按钮可触摸
  await page.evaluate(() => submitAnswer());
  await page.evaluate(() => submitTeaching({
    questionId: currentQ().id,
    explanation: 'AI 补充解析：'.repeat(150),
    provider: 'deepseek'
  }));
  await sleep(80);
  after = await page.evaluate(() => document.querySelector('#quiz-dialog .quiz-body').scrollTop);
  assert.ok(Math.abs(after - info.prev) <= 8, 'AI 讲解到达后滚动应保持（' + info.prev + ' → ' + after + '）');
  const reach = await page.evaluate(() => {
    const body = document.querySelector('#quiz-dialog .quiz-body');
    body.scrollTop = body.scrollHeight;
    const btn = document.querySelector('#quiz-dialog .quiz-foot .primary');
    const rect = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const max = body.scrollHeight - body.clientHeight;
    return {
      inView: rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1,
      hit: !!hit && (hit === btn || btn.contains(hit)),
      atBottom: body.scrollTop === max,
      max
    };
  });
  assert.equal(reach.atBottom, true, '长内容应能滚到底');
  assert.equal(reach.inView, true, '长解析后主按钮应完整留在视口内');
  assert.equal(reach.hit, true, '长解析后主按钮不应被遮挡');
  await page.evaluate(() => nextQuestion());
  assert.equal(await page.evaluate(() => document.querySelector('#quiz-dialog .quiz-body').scrollTop), 0, '切题后应回到顶部');
  await page.evaluate(() => pauseQuiz());
  noPageErrors(errors, '长题干滚动');
}

// 4) 触摸连点：提交后第二次触摸不得落到“下一题”；最后一题连点不得重开。
async function runTouchGuards(page, errors, touch) {
  if (!touch) {
    // 桌面/宽屏：quiz 没有遮罩点击关闭逻辑，点遮罩不应改变状态。
    await startChoiceQuiz(page, '遮罩点击');
    await page.mouse.click(6, 300);
    await sleep(80);
    const stateAfter = await page.evaluate(() => ({ open: $('#quiz-dialog').open, ids: quiz.ids.length, results: quiz.results.length }));
    assert.equal(stateAfter.open, true, '点击 quiz 遮罩不应关闭练习');
    assert.equal(stateAfter.ids, 2);
    await page.evaluate(() => pauseQuiz());
    noPageErrors(errors, '桌面遮罩');
    return;
  }
  await startChoiceQuiz(page, '连点提交');
  await page.locator('#quiz-dialog .option').first().tap();
  const submit = await page.locator('#submit-answer').boundingBox();
  const sx = submit.x + submit.width / 2;
  const sy = submit.y + submit.height / 2;
  await page.touchscreen.tap(sx, sy);
  await sleep(90);
  await page.touchscreen.tap(sx, sy);
  await sleep(150);
  const st = await page.evaluate(() => ({ index: quiz.index, results: quiz.results.length, feedback: !!document.querySelector('#quiz-dialog .feedback'), finished: quiz.finished }));
  assert.equal(st.results, 1, '第一次触摸应提交');
  assert.equal(st.index, 0, '第二次触摸不得误触新的“下一题”');
  assert.equal(st.feedback, true, '答案反馈不应被连点跳过');
  assert.equal(st.finished, false);
  await sleep(700);
  await page.touchscreen.tap(sx, sy);
  await sleep(150);
  assert.equal(await page.evaluate(() => quiz.index), 1, '单击“下一题”应前进一题');

  // 最后一题连点“查看本次成绩”：结果页不应被误触重开/重练。
  await page.locator('#quiz-dialog .option').first().tap();
  await page.locator('#submit-answer').tap();
  const last = await page.locator('#quiz-dialog .quiz-foot .primary').boundingBox();
  const lx = last.x + last.width / 2;
  const ly = last.y + last.height / 2;
  await page.touchscreen.tap(lx, ly);
  await sleep(90);
  await page.touchscreen.tap(lx, ly);
  await sleep(200);
  const fin = await page.evaluate(() => ({
    finished: quiz.finished,
    results: quiz.results.length,
    resultVisible: !!document.querySelector('#quiz-dialog .result'),
    dialogOpen: $('#quiz-dialog').open
  }));
  assert.equal(fin.finished, true, '最后一题应出成绩');
  assert.equal(fin.results, 2);
  assert.equal(fin.resultVisible, true, '结果页应正常显示');
  assert.equal(fin.dialogOpen, true);
  await page.evaluate(() => closeQuiz());
  noPageErrors(errors, '触摸连点');
}

// 5) 自练：长题滚动、标记重渲染、反馈嵌套、草稿保留、AI 异步到达、题号校验、session 恢复、连点、完成关卡。
async function runPracticeSuite(page, errors, touch) {
  const info = await page.evaluate(() => {
    const levels = allLevels().filter(l => l.type === 'practice' && (l.questions || []).length >= 2);
    let best = levels[0];
    let bestLen = -1;
    let bestIdx = 0;
    for (const l of levels) {
      for (let i = 0; i < (l.questions || []).length - 1; i++) {
        const u = l.questions[i];
        const len = (u.stem || '').length + (u.code || '').length;
        if (len > bestLen) { bestLen = len; best = l; bestIdx = i; }
      }
    }
    startPracticeLevel(best);
    practiceQuiz.index = bestIdx;
    renderPracticeLevelQuiz();
    const body = document.querySelector('#quiz-dialog .quiz-body');
    body.scrollTop = body.scrollHeight;
    return { unit0: currentPracticeQ().id, idx: practiceQuiz.index, units: best.questions.length, scrollable: body.scrollHeight - body.clientHeight > 8, prev: body.scrollTop };
  });
  assert.ok(info.units >= 2);
  if (!info.scrollable) {
    // 宽屏（768/1200）下最长自练题可能一屏放得下：保证主按钮完整可见，且没有超出太多（.quiz-body 本身可滚，不算裁切）。
    const fit = await page.evaluate(() => {
      const btn = document.querySelector('.quiz-step-actions .primary');
      const r = btn.getBoundingClientRect();
      const body = document.querySelector('#quiz-dialog .quiz-body');
      return { inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.width > 0, fits: body.scrollHeight <= body.clientHeight + 80 };
    });
    assert.equal(fit.inView, true, '宽屏下自练主按钮应完整可见');
    assert.equal(fit.fits, true, '宽屏下自练内容不应被裁切');
  }

  // 标记掌握（同题重渲染）后滚动不跳（内容可滚时校验）
  const marked = await page.evaluate(() => {
    const body = document.querySelector('#quiz-dialog .quiz-body');
    body.scrollTop = body.scrollHeight;
    document.querySelector('.mark-master-btn').click();
    return { top: document.querySelector('#quiz-dialog .quiz-body').scrollTop, mastered: !!state.selfChecks[currentPracticeQ().id]?.mastered };
  });
  if (info.scrollable) {
    assert.ok(Math.abs(marked.top - info.prev) <= 8, '标记掌握重渲染后滚动应保持（' + info.prev + ' → ' + marked.top + '）');
  }
  assert.equal(marked.mastered, true);
  await page.evaluate(() => document.querySelector('.mark-master-btn').click());

  // 查看参考答案不重渲染
  await page.evaluate(() => document.querySelector('.toggle-answer-btn').click());
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#practice-quiz-answer-section')).display), 'none');
  await page.evaluate(() => document.querySelector('.toggle-answer-btn').click());

  // 草稿输入后，从自练内打开反馈弹窗，关闭后回到原题并保留草稿
  await page.locator('#practice-quiz-draft-input').fill('微信端草稿ABC');
  const practiceCtx = await page.evaluate(() => getBugReportContext());
  assert.equal(practiceCtx.mode, 'practice', '自练中反馈上下文 mode 必须是 practice');
  assert.equal(practiceCtx.questionId, info.unit0, '自练中反馈上下文应指向当前自练题');
  assert.equal(practiceCtx.position, info.idx + 1);
  await page.getByRole('button', { name: '反馈此题' }).click();
  await page.locator('#cquest-bug-dialog[open]').waitFor();
  const bugText = await page.locator('#cquest-bug-dialog').innerText();
  assert.ok(/模式[:：]\s*practice/.test(bugText), '自练反馈应为 practice 模式：' + bugText.slice(0, 120));
  assert.ok(bugText.includes('位置: ' + (info.idx + 1)), '自练反馈应带当前进度位置');
  await page.locator('#cquest-bug-cancel').click();
  await sleep(80);
  assert.equal(await page.evaluate(() => $('#quiz-dialog').open), true, '关闭反馈后应回到练习');
  assert.equal(await page.locator('#practice-quiz-draft-input').inputValue(), '微信端草稿ABC', '反馈弹窗关闭后草稿应保留');
  assert.equal(await page.evaluate(() => currentPracticeQ().id), info.unit0);

  // AI 讲解异步到达：就地出现卡片，且不打断草稿输入
  const ai = await page.evaluate(() => {
    submitTeaching({ questionId: currentPracticeQ().id, explanation: '异步到达讲解：' + '内容'.repeat(200), provider: 'deepseek' });
    return {
      card: !!document.querySelector('#practice-quiz-ai-section .practice-ai-card'),
      draft: document.querySelector('#practice-quiz-draft-input').value
    };
  });
  assert.equal(ai.card, true, '自练 AI 讲解异步到达后应就地出现卡片');
  assert.equal(ai.draft, '微信端草稿ABC', 'AI 到达不应打断草稿输入');

  // 切到下一题：旧题讲解不得串台；返回后草稿仍在且滚动回顶
  await page.evaluate(() => nextPracticeQuestion());
  const unit1 = await page.evaluate(() => currentPracticeQ().id);
  assert.notEqual(unit1, info.unit0);
  const stale = await page.evaluate(oldId => {
    submitTeaching({ questionId: oldId, explanation: '过期讲解：不得出现在新题上', provider: 'deepseek' });
    const card = document.querySelector('#practice-quiz-ai-section .practice-ai-card');
    return card ? card.textContent : '';
  }, info.unit0);
  assert.equal(stale.includes('过期讲解'), false, '旧题 AI 讲解不得串到新题');
  await page.evaluate(() => prevPracticeQuestion());
  assert.equal(await page.locator('#practice-quiz-draft-input').inputValue(), '微信端草稿ABC', '返回上一题应恢复草稿');
  assert.equal(await page.evaluate(() => document.querySelector('#quiz-dialog .quiz-body').scrollTop), 0, '自练切题后应回到顶部');

  // state.session 被云端清空时，下一题仍应可用（不得抛 null）
  const recover = await page.evaluate(() => {
    state.session = null;
    save();
    const before = practiceQuiz.index;
    document.querySelector('.quiz-step-actions .primary').click();
    return { before, after: practiceQuiz.index, session: !!state.session, type: state.session && state.session.type };
  });
  assert.equal(recover.after, recover.before + 1, 'session 丢失时“下一题”仍应前进');
  assert.equal(recover.session, true, '“下一题”应重建练习进度');
  assert.equal(recover.type, 'practice');

  // 触摸连点：连续两次点“下一题”只能前进一题
  if (touch) {
    await page.evaluate(() => {
      pausePracticeQuiz();
      const level = allLevels().filter(l => l.type === 'practice' && (l.questions || []).length >= 3)[0];
      startPracticeLevel(level);
    });
    const nextBtn = await page.locator('.quiz-step-actions .primary').boundingBox();
    const nx = nextBtn.x + nextBtn.width / 2;
    const ny = nextBtn.y + nextBtn.height / 2;
    await page.touchscreen.tap(nx, ny);
    await sleep(90);
    await page.touchscreen.tap(nx, ny);
    await sleep(150);
    assert.equal(await page.evaluate(() => practiceQuiz.index), 1, '自练连续两次点“下一题”只能前进一题');
    await sleep(700);
    await page.touchscreen.tap(nx, ny);
    await sleep(150);
    assert.equal(await page.evaluate(() => practiceQuiz.index), 2, '单击“下一题”应前进一题');
  }

  // 完成关卡：结果页可见、按钮完整可见，可返回地图
  await page.evaluate(() => {
    practiceQuiz.index = practiceQuiz.units.length - 1;
    practiceQuiz.showAnswer = false;
    renderPracticeLevelQuiz();
  });
  const finishLabel = await page.evaluate(() => document.querySelector('.quiz-step-actions .primary').textContent.trim());
  assert.ok(finishLabel.includes('完成'), '最后一题应显示“完成关卡”');
  await page.evaluate(() => document.querySelector('.quiz-step-actions .primary').click());
  assert.equal(await page.evaluate(() => practiceQuiz.finished), true, '完成关卡后应进入结果页');
  const geo = await page.evaluate(() => {
    const result = document.querySelector('#quiz-dialog .result');
    const buttons = [...document.querySelectorAll('#quiz-dialog .result-buttons button')];
    return {
      bottom: result.getBoundingClientRect().bottom,
      innerH: innerHeight,
      buttons: buttons.map(b => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, label: b.textContent.trim() }; })
    };
  });
  assert.ok(geo.buttons.length >= 2, '自练结果页应有两个按钮');
  assert.ok(geo.bottom <= geo.innerH + 1, '自练结果页不应被裁切');
  for (const b of geo.buttons) assert.ok(b.top >= -1 && b.bottom <= geo.innerH + 1, '自练结果页按钮应完整可见：' + b.label);
  await page.evaluate(() => closePracticeQuiz());
  assert.equal(await page.evaluate(() => $('#quiz-dialog').open), false, '返回地图应关闭练习弹窗');
  noPageErrors(errors, '自练流程');
}

// 6) 反馈弹窗嵌套 + ESC：只关当前弹窗；关闭 quiz 后进度保存，刷新可恢复。
async function runFeedbackDialog(page, errors) {
  await startChoiceQuiz(page, '反馈嵌套');
  await page.evaluate(() => { choose('B'); submitAnswer(); });
  await page.getByRole('button', { name: '反馈此题' }).click();
  await page.locator('#cquest-bug-dialog[open]').waitFor();
  const bugText = await page.locator('#cquest-bug-dialog').innerText();
  assert.ok(/模式[:：]\s*choice/.test(bugText), '闯关反馈应为 choice 模式：' + bugText.slice(0, 120));
  assert.ok(bugText.includes(CHOICE_IDS[0]), '闯关反馈题号应为当前题');
  await page.locator('#cquest-bug-cancel').click();
  await sleep(80);
  assert.equal(await page.locator('#cquest-bug-dialog[open]').count(), 0, '取消应关闭反馈弹窗');
  const kept = await page.evaluate(() => ({
    open: $('#quiz-dialog').open,
    results: quiz.results.length,
    meta: document.querySelector('#quiz-dialog .quiz-meta').innerText,
    answered: document.querySelectorAll('#quiz-dialog .option.selected, #quiz-dialog .option.correct, #quiz-dialog .option.incorrect').length
  }));
  assert.equal(kept.open, true, '反馈弹窗关闭后练习仍在');
  assert.equal(kept.results, 1);
  assert.ok(kept.meta.includes('01 / 02'));
  assert.ok(kept.answered > 0, '已作答样式应保留');

  // ESC 只关闭最上层反馈弹窗；再 ESC 关闭 quiz 并保存进度
  await page.getByRole('button', { name: '反馈此题' }).click();
  await page.locator('#cquest-bug-dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await sleep(80);
  assert.equal(await page.locator('#cquest-bug-dialog[open]').count(), 0, 'ESC 应先关闭反馈弹窗');
  assert.equal(await page.evaluate(() => $('#quiz-dialog').open), true, 'ESC 关反馈后练习仍在');
  await page.keyboard.press('Escape');
  await sleep(120);
  const closed = await page.evaluate(() => ({
    open: $('#quiz-dialog').open,
    quizAlive: !!quiz,
    finished: quiz && quiz.finished,
    sessionIds: state.session && state.session.ids ? state.session.ids.length : 0,
    sessionIndex: state.session ? state.session.index : -1
  }));
  assert.equal(closed.open, false, 'ESC 应关闭练习弹窗');
  assert.equal(closed.quizAlive, true, 'ESC 关闭后 quiz 不应被清空');
  assert.equal(closed.finished, false);
  assert.equal(closed.sessionIds, 2, 'ESC 关闭应保存可恢复的进度');
  assert.equal(closed.sessionIndex, 0);

  // 刷新后恢复：继续练习回到原题并保留已作答结果
  await page.reload();
  await page.locator('.chapters').waitFor();
  await page.evaluate(() => continueLearning());
  await page.locator('#quiz-dialog[open] .quiz-meta').waitFor();
  const resumed = await page.evaluate(() => ({
    open: $('#quiz-dialog').open,
    meta: document.querySelector('#quiz-dialog .quiz-meta').innerText,
    results: quiz.results.length,
    index: quiz.index
  }));
  assert.equal(resumed.open, true, '刷新后“继续练习”应恢复练习');
  assert.equal(resumed.index, 0);
  assert.equal(resumed.results, 1, '刷新后应保留已作答结果');
  assert.ok(resumed.meta.includes('01 / 02'));
  await page.evaluate(() => pauseQuiz());
  noPageErrors(errors, '反馈嵌套与 ESC 恢复');
}

// 7) 云端状态事件、session 被清空、结果页完整性与数字答案格式。
async function runCloudResumeResult(page, errors) {
  await startChoiceQuiz(page, '云端事件');
  await page.evaluate(() => choose('B'));
  const before = await page.evaluate(() => ({ index: quiz.index, selected: selected.join('') }));
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('cquest:account-status', { detail: { status: 'signed-in' } }));
    window.dispatchEvent(new CustomEvent('cquest:teaching-received', { detail: { questionId: 'n7-1' } }));
  });
  await sleep(120);
  const after = await page.evaluate(() => ({ open: $('#quiz-dialog').open, index: quiz.index, selected: selected.join(''), results: quiz.results.length }));
  assert.equal(after.open, true, '云端状态事件不应关闭练习');
  assert.deepEqual({ index: after.index, selected: after.selected }, before, '云端状态事件不应改动当前选择');

  await page.evaluate(() => { state.session = null; save(); });
  const recover = await page.evaluate(() => {
    submitAnswer();
    const first = { results: quiz.results.length, session: !!state.session };
    nextQuestion();
    choose(currentQ().answer[0]);
    submitAnswer();
    nextQuestion();
    return { first, finished: quiz.finished };
  });
  assert.equal(recover.first.results, 1, 'session 被清空后提交仍应成功');
  assert.equal(recover.first.session, true, '提交后应重建可恢复进度');
  assert.equal(recover.finished, true, '最后一题后应显示成绩');

  const geo = await page.evaluate(() => {
    const result = document.querySelector('#quiz-dialog .result');
    const buttons = [...document.querySelectorAll('#quiz-dialog .result-buttons button')];
    return {
      resultBottom: result.getBoundingClientRect().bottom,
      innerH: innerHeight,
      buttons: buttons.map(b => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, label: b.textContent.trim() }; })
    };
  });
  assert.ok(geo.buttons.length >= 2, '结果页应至少有两个按钮');
  assert.ok(geo.resultBottom <= geo.innerH + 1, '结果页内容不应被裁切');
  for (const b of geo.buttons) assert.ok(b.top >= -1 && b.bottom <= geo.innerH + 1, '结果页按钮应完整可见：' + b.label);
  await page.evaluate(() => closeQuiz());

  const fmt = await page.evaluate(() => ({
    raw: QUESTION_BANK.questions.find(q => q.id === 'n7-1').answer,
    normalized: Q.find(q => q.id === 'n7-1').answer
  }));
  assert.equal(fmt.raw, 1, '题库原始数字答案格式不得回退');
  assert.equal(fmt.normalized, 'B', '运行时应把数字答案归一化为字母');
  noPageErrors(errors, '云端事件与结果页');
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of WIDTHS) {
      const mobile = width < 760;
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
        await page.goto(origin + '/#map');
        await page.locator('.chapters').waitFor();

        await runFeedbackContext(page, errors);
        await runKeyboard(page, errors);
        await runLongContent(page, errors);
        await runTouchGuards(page, errors, mobile);
        await runPracticeSuite(page, errors, mobile);
        await runFeedbackDialog(page, errors);
        await runCloudResumeResult(page, errors);
        noPageErrors(errors, width + 'px 全流程');
        console.log('PASS ' + width + 'px：练习流程域 7 组场景全部通过（pageerror 0）');
      } finally {
        await context.close();
      }
    }
    console.log('ALL PASS：' + WIDTHS.join('/') + ' 视口练习流程健壮性检查通过');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
