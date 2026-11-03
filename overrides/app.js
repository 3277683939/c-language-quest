/**
 * C 语言闯关营 · 核心控制器与闯关地图
 * 支持客观选择题闯关与非选择题自练关卡双轨模式
 */
'use strict';

const BANK = window.QUESTION_BANK;
const Q = BANK.questions;
const PU = () => (window.PRACTICE_UNITS ? (Array.isArray(window.PRACTICE_UNITS) ? window.PRACTICE_UNITS : (window.PRACTICE_UNITS.units || [])) : []);
const $ = s => document.querySelector(s);
const KEY = 'c-quest-progress-v1';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blank = () => ({
  version: 1,
  answers: {},
  wrong: [],
  favorites: [],
  levels: {},
  days: [],
  session: null,
  drafts: {},
  selfChecks: {},
  teaching: {}
});

let state = blank(), storageOK = true, selectedChapter = 1, mapSource = 'h', listLimit = 30, quiz = null, practiceQuiz = null, selected = [], view = 'map';

try {
  const raw = JSON.parse((window.CQuestAccount ? window.CQuestAccount.readLocalProgress() : localStorage.getItem(KEY)) || 'null');
  if (raw && raw.version === 1) state = { ...blank(), ...raw };
} catch (e) {
  storageOK = false;
}

if (!state.drafts) state.drafts = {};
if (!state.selfChecks) state.selfChecks = {};
if (!state.teaching) state.teaching = {};

const validIds = new Set([...Q.map(q => q.id), ...PU().map(u => u.id)]);
// Keep records for rolled-back imports, so re-importing restores their history.
const retainedId = id => validIds.has(id) || (typeof id === 'string' && /^import:u[0-9a-f]{12}:[0-9a-f]{20}$/.test(id));
state.wrong = state.wrong.filter(retainedId);
state.favorites = state.favorites.filter(retainedId);

function save() {
  try {
    if (window.CQuestAccount) window.CQuestAccount.saveLocalProgress(state);
    else localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    storageOK = false;
    toast('浏览器无法保存记录，可以在学习记录页导出备份。');
  }
}

function toast(s) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = s;
  el.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function day() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function material(id) {
  return BANK.materials.find(m => m.id === id);
}

async function openMaterial(id, page = 1) {
  const m = material(id);
  if (!m) return;
  page = Math.min(m.pages, Math.max(1, Number(page) || 1));
  $('#reader-title').textContent = m.name + ' · 第 ' + page + ' 页';
  $('#reader-link').href = m.url + '#page=' + page;
  $('#reader-content').innerHTML = `
    <div class="reader-controls">
      <button class="quiet" onclick="openMaterial('${esc(id)}',${page - 1})" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${page} / ${m.pages} 页</span>
      <button class="quiet" onclick="openMaterial('${esc(id)}',${page + 1})" ${page >= m.pages ? 'disabled' : ''}>下一页</button>
    </div>
    <p class="reader-loading">正在打开第 ${page} 页…</p>
    <canvas id="reader-canvas" aria-label="原资料第 ${page} 页"></canvas>
  `;
  if (!$('#material-dialog').open) $('#material-dialog').showModal();
  try {
    const pdf = await getPracticePDF(id);
    const pg = await pdf.getPage(page);
    const canvas = $('#reader-canvas');
    if (!canvas) return;
    const v = pg.getViewport({ scale: 1.5 });
    canvas.width = v.width;
    canvas.height = v.height;
    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: v }).promise;
    $('#reader-content .reader-loading')?.remove();
  } catch (e) {
    $('#reader-content .reader-loading').textContent = '无法在此处显示 PDF，请使用右上角“新窗口阅读”。原因：' + String(e.message || e);
  }
}

function openQuestionSource(id) {
  const q = Q.find(x => x.id === id);
  if (!q) return;
  const m = material(q.source);
  $('#reader-title').textContent = `${m.name} · 第 ${q.page} 页 · 原题 ${esc(q.number)}`;
  $('#reader-link').href = m.url + '#page=' + q.page;
  const text = `<div class="source-text"><h3>${esc(q.stem)}</h3>${q.options.map((o, i) => `<p>${String.fromCharCode(65 + i)}. ${esc(o)}</p>`).join('')}</div>`;
  $('#reader-content').innerHTML = `
    <div class="reader-question-heading">当前题目的原始版面 <button class="quiet" onclick="openMaterial('${q.source}',${q.page})">查看所在整页</button></div>
    ${q.sourceImage ? `<img class="source-question-image" src="${esc(q.sourceImage)}" alt="当前题目的原始版面" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="source-fallback" hidden>${text}</div>` : text}
  `;
  if (!$('#material-dialog').open) $('#material-dialog').showModal();
}

/* 动态章节与关卡管理系统 */
const KNOWN_CHAPTER_TITLES = {
  h: [
    "C 语言概述与开发环境", "数据类型与运算符", "顺序结构程序设计", "选择结构程序设计",
    "循环结构程序设计", "数组", "指针", "字符串处理", "函数与模块化", "结构体与共用体", "文件操作与位运算"
  ],
  x: {
    1: "C语言概述", 2: "数据类型、运算符与表达式", 3: "简单的C程序设计", 4: "逻辑运算和判断选择",
    5: "循环控制", 6: "数组", 7: "函数", 8: "指针", 9: "结构体与共用体", 10: "文件",
    11: "编译预处理", 12: "位运算"
  }
};

function getAllSources() {
  const qSources = Q.map(q => q.source);
  const pSources = PU().map(u => u.source);
  return [...new Set([...qSources, ...pSources])];
}

function getSourceTotalQuestions(sid) {
  const qc = Q.filter(q => q.source === sid).length;
  const pc = PU().filter(u => u.source === sid).length;
  return qc + pc;
}

function getSourceChapters(sid) {
  const choiceList = Q.filter(q => q.source === sid);
  const practiceList = PU().filter(u => u.source === sid);
  const chapSet = new Set([...choiceList.map(q => q.chapter), ...practiceList.map(u => u.chapter)]);
  const chapNumbers = [...chapSet].sort((a, b) => a - b);

  return chapNumbers.map(c => {
    const qCount = choiceList.filter(q => q.chapter === c).length;
    const pCount = practiceList.filter(u => u.chapter === c).length;
    let name = '';
    if (sid === 'h' && KNOWN_CHAPTER_TITLES.h && KNOWN_CHAPTER_TITLES.h[c - 1]) {
      name = KNOWN_CHAPTER_TITLES.h[c - 1];
    } else if (sid === 'x' && KNOWN_CHAPTER_TITLES.x && KNOWN_CHAPTER_TITLES.x[c]) {
      name = KNOWN_CHAPTER_TITLES.x[c];
    } else {
      const pu = practiceList.find(u => u.chapter === c && u.chapterName);
      if (pu && pu.chapterName) {
        name = pu.chapterName;
      } else {
        const q = choiceList.find(q => q.chapter === c && q.section);
        if (q && q.section) {
          name = q.section;
        } else {
          name = `第 ${c} 章`;
        }
      }
    }
    return {
      chapter: c,
      name,
      choiceCount: qCount,
      practiceCount: pCount,
      totalCount: qCount + pCount
    };
  });
}

function getLevels(source, chapter) {
  const choiceList = Q.filter(q => q.source === source && q.chapter === chapter);
  const practiceList = PU().filter(u => u.source === source && u.chapter === chapter);
  const levels = [];

  // 客观选择题关卡（保留既有 ID 命名兼容已有学习通关记录）
  for (let i = 0; i < choiceList.length; i += 10) {
    const slice = choiceList.slice(i, i + 10);
    const idx = Math.floor(i / 10);
    levels.push({
      id: `${source}-${chapter}-${idx}`,
      type: 'choice',
      title: `${idx === 0 ? '起步热身' : i + 10 >= choiceList.length ? '章节冲刺' : '进阶练习'} (${slice.length}题)`,
      section: slice[0]?.section || '客观选择题',
      questions: slice,
      index: idx
    });
  }

  // 非选择题自练关卡（每关 6 题大题，适宜深度代码阅读与练习）
  const pChunk = 6;
  for (let i = 0; i < practiceList.length; i += pChunk) {
    const slice = practiceList.slice(i, i + pChunk);
    const pIdx = Math.floor(i / pChunk);
    const kinds = [...new Set(slice.map(u => u.kind))].join(' / ');
    levels.push({
      id: `${source}-${chapter}-p${pIdx}`,
      type: 'practice',
      title: `${kinds || '自练大题'} (${slice.length}题)`,
      section: slice[0]?.section || '自练大题',
      questions: slice,
      index: pIdx
    });
  }

  return levels;
}

function allLevels() {
  const levels = [];
  for (const sid of getAllSources()) {
    const chaps = getSourceChapters(sid);
    for (const ch of chaps) {
      levels.push(...getLevels(sid, ch.chapter));
    }
  }
  return levels;
}

function stats() {
  const a = Object.values(state.answers);
  const attempts = a.reduce((s, x) => s + x.attempts, 0);
  const correct = a.reduce((s, x) => s + x.correct, 0);

  const checks = Object.values(state.selfChecks || {});
  const masteredChecks = checks.filter(c => c && c.mastered === true).length;

  const allLevs = allLevels();
  const passedLevels = allLevs.filter(l => state.levels[l.id]?.passed).length;

  const doneChoiceCount = a.length;
  const donePracticeCount = Object.keys(state.drafts || {}).filter(k => (state.drafts[k] || '').trim()).length;
  const totalDone = doneChoiceCount + donePracticeCount;

  const totalAttempts = attempts + checks.length;
  const totalSuccess = correct + masteredChecks;
  const accuracy = totalAttempts ? Math.round(totalSuccess / totalAttempts * 100) : 0;

  return {
    done: totalDone,
    doneChoice: doneChoiceCount,
    donePractice: donePracticeCount,
    attempts: totalAttempts,
    accuracy,
    passed: passedLevels,
    totalLevels: allLevs.length
  };
}

function statCards() {
  const s = stats();
  const totalQ = Q.length + PU().length;
  return `
    <div class="stats">
      <div class="stat"><span class="stat-icon">▤</span><div><strong>${totalQ}<small>全量题库（${Q.length}选 + ${PU().length}大题）</small></strong></div></div>
      <div class="stat"><span class="stat-icon">⚑</span><div><strong>${s.passed}<small>已通关 / ${s.totalLevels} 关</small></strong></div></div>
      <div class="stat"><span class="stat-icon">✓</span><div><strong>${s.done}<small>累计已练题数</small></strong></div></div>
      <div class="stat"><span class="stat-icon">◎</span><div><strong>${s.accuracy}<span style="font-size:14px">%</span><small>综合正确/掌握率</small></strong></div></div>
    </div>
  `;
}

const names = {
  map: '闯关地图',
  random: '随机挑战',
  wrong: '我的错题',
  favorites: '收藏夹',
  library: '题库与资料',
  progress: '学习记录',
  account: '账户与云存档',
  practice: '原题自练',
  coach: 'AI 教练',
  teach: 'Agent 教学'
};

function title(k, heading, desc) {
  return `
    <div class="page-title">
      <div><h1>${heading}</h1><p>${desc}</p></div>
      <span class="date-label">${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span>
    </div>
  `;
}

function render() {
  view = location.hash.slice(1).split('?')[0] || 'map';
  if (!names[view]) view = 'map';
  $('#breadcrumb').innerHTML = `学习空间 <span>/</span> ${names[view]}`;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  $('#wrong-count').textContent = state.wrong.length;
  $('#streak').textContent = state.days.includes(day()) ? '✦ 今日已完成练习' : '✦ 今天也要进步一点';

  const fn = {
    map: renderMap,
    random: renderRandom,
    wrong: renderList,
    favorites: renderList,
    library: renderLibrary,
    progress: renderProgress,
    account: () => window.CQuestAccount ? window.CQuestAccount.render() : renderProgress(),
    practice: renderPractice,
    coach: renderCoach,
    teach: renderCoach
  };
  fn[view]();
  if (!storageOK) {
    $('#app').insertAdjacentHTML('afterbegin', '<div class="storage-warning">当前浏览器的存储不可用，请在“学习记录”中导出进度备份。</div>');
  }
}

/* 闯关地图渲染 */
function renderMap() {
  const allChaps = getSourceChapters(mapSource);
  if (!allChaps.some(c => c.chapter === selectedChapter)) {
    selectedChapter = allChaps[0]?.chapter || 1;
  }
  const currentChapterInfo = allChaps.find(c => c.chapter === selectedChapter) || { name: `第 ${selectedChapter} 章`, choiceCount: 0, practiceCount: 0, totalCount: 0 };
  const levels = getLevels(mapSource, selectedChapter);
  const choiceLevels = levels.filter(l => l.type === 'choice');
  const practiceLevels = levels.filter(l => l.type === 'practice');
  const totalQuestions = currentChapterInfo.totalCount;
  const passedCount = levels.filter(l => state.levels[l.id]?.passed).length;
  const sources = getAllSources();

  $('#app').innerHTML = title('YOUR LEARNING JOURNEY', '把 C 语言，一关一关拿下。', `选择题与自练题共 ${Q.length + PU().length} 道，按资料与章节练习。`) +
    `<section class="hero">
      <div class="hero-copy">
        <h2>${state.session ? '接着上一次，继续向前。' : '从第一行代码，\n开始你的闯关旅程。'}</h2>
        <p>选择题与自练大题双轨并行，答对或掌握 80% 即可通关。<br>不用一口气学会，今天比昨天多懂一点。</p>
        <button class="primary" onclick="continueLearning()">${state.session ? '继续上次练习' : '开始今日闯关'} <span>↗</span></button>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="orbit"></div><span class="spark">✧</span>
        <div class="code-window">
          <div class="window-top"><i></i><i></i><i></i></div>
          <div class="window-code"><b>#include</b> &lt;stdio.h&gt;<br>int main() {<br>&nbsp; printf(<b>"Hello, C!"</b>);<br>&nbsp; return <b>0</b>;<br>}</div>
        </div>
        <div class="terminal-badge">&lt; / &gt;</div>
      </div>
    </section>` +
    statCards() +
    `<div class="section-top">
      <div>
        <h2>你的闯关地图 <small style="margin-left:10px">${allChaps.length} 个章节/单元 · 循序渐进</small></h2>
      </div>
      <div class="segmented">
        <button class="${mapSource === 'h' ? 'active' : ''}" onclick="setMapSource('h')">主线闯关（${getSourceTotalQuestions('h')}题）</button>
        <button class="${mapSource !== 'h' ? 'active' : ''}" onclick="setMapSource(mapSource === 'h' ? 'x' : mapSource)">拓展挑战（${getAllSources().filter(s=>s!=='h').length}份资料）</button>
      </div>
    </div>
    ${mapSource !== 'h' ? `
      <div class="filters">
        <select aria-label="拓展题库" onchange="setMapSource(this.value)">
          ${sources.filter(s => s !== 'h').map(s => `
            <option value="${s}" ${s === mapSource ? 'selected' : ''}>
              ${esc(material(s)?.name || s)} · (${getSourceTotalQuestions(s)} 题)
            </option>
          `).join('')}
        </select>
      </div>
    ` : ''}
    <div class="chapter-area">
      <div class="chapters">
        ${allChaps.map(c => `
          <button class="chapter ${c.chapter === selectedChapter ? 'active' : ''}" onclick="selectChapter(${c.chapter})">
            <span class="num">${String(c.chapter).padStart(2, '0')}</span>
            <span class="chapter-name">${esc(c.name)}</span>
            <span class="chapter-count">${c.totalCount} 题</span>
          </button>
        `).join('')}
      </div>
      <div class="levels-pane">
        <div class="chapter-head">
          <div>
            <h3>第 ${String(selectedChapter).padStart(2, '0')} 章 · ${esc(currentChapterInfo.name)}</h3>
            <p>${totalQuestions} 道题（${currentChapterInfo.choiceCount} 道选择 + ${currentChapterInfo.practiceCount} 道自练大题） · ${levels.length} 个关卡 · 已通关 ${passedCount} / ${levels.length}</p>
          </div>
        </div>

        ${choiceLevels.length > 0 ? `
          <div class="level-section-title">
            <h4>🎯 客观选择题闯关（每关 10 题 · 自动判分）</h4>
            <span>${choiceLevels.length} 个关卡 · ${currentChapterInfo.choiceCount} 题</span>
          </div>
          <div class="levels choice-levels">
            ${choiceLevels.map((l, i) => {
              const done = state.levels[l.id];
              const unlocked = i === 0 || state.levels[choiceLevels[i - 1].id]?.passed;
              const current = unlocked && !done?.passed;
              return `
                <button class="level choice-level ${!unlocked ? 'locked' : current ? 'current' : ''}"
                        ${!unlocked ? 'disabled aria-label="请先通过上一关"' : ''}
                        onclick="startLevel('${l.id}')">
                  <div class="level-top">
                    <span class="level-icon">${done?.passed ? '✓' : unlocked ? '{ }' : '⌑'}</span>
                    <small>选择题 · LEVEL ${i + 1}</small>
                  </div>
                  <h3>第 ${i + 1} 关 · ${esc(l.title)}</h3>
                  <p>${l.questions.length} 道选择题 · ${esc(l.section)}</p>
                  <div class="level-bottom">
                    <span>${done?.passed ? `<span class="stars">${'★'.repeat(done.stars)}${'☆'.repeat(3 - done.stars)}</span>` : unlocked ? '准备好了，出发' : '通过上一关解锁'}</span>
                    <span>${unlocked ? '↗' : '⌑'}</span>
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        ` : ''}

        ${practiceLevels.length > 0 ? `
          <div class="level-section-title" style="${choiceLevels.length > 0 ? 'margin-top:32px;' : ''}">
            <h4>✎ 非选择题自练关卡（保留原题型 · 作答核对）</h4>
            <span>${practiceLevels.length} 个关卡 · ${currentChapterInfo.practiceCount} 题</span>
          </div>
          <div class="levels practice-levels">
            ${practiceLevels.map((l, i) => {
              const done = state.levels[l.id];
              const unlocked = i === 0 || state.levels[practiceLevels[i - 1].id]?.passed;
              const current = unlocked && !done?.passed;
              return `
                <button class="level practice-level ${!unlocked ? 'locked' : current ? 'current' : ''}"
                        ${!unlocked ? 'disabled aria-label="请先通过上一关"' : ''}
                        onclick="startLevel('${l.id}')">
                  <div class="level-top">
                    <span class="level-icon practice-icon">${done?.passed ? '✓' : '✎'}</span>
                    <small class="practice-badge">自练 · LEVEL ${i + 1}</small>
                  </div>
                  <h3>自练第 ${i + 1} 关 · ${esc(l.title)}</h3>
                  <p>${l.questions.length} 道大题 · ${esc(l.section)}</p>
                  <div class="level-bottom">
                    <span>${done?.passed ? `<span class="stars">${'★'.repeat(done.stars)}${'☆'.repeat(3 - done.stars)}</span>` : unlocked ? '准备好了，出发' : '通过上一关解锁'}</span>
                    <span>${unlocked ? '↗' : '⌑'}</span>
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        ` : ''}

        ${!levels.length ? `
          <div class="empty">
            <p>该资料在本章没有题目。<br>可以切换章节或查看原资料。</p>
          </div>
        ` : ''}
      </div>
    </div>
    <div class="mini-note">
      <strong>↗ 给学习留一点节奏</strong>选择题每关答对至少 80% 通关解锁下一关；自练大题作答后查看答案并标记“已掌握”达到 80% 即可通关。新题加入后原进度与错题均完全保留。
    </div>
  `;
}

function selectChapter(c) {
  selectedChapter = c;
  renderMap();
}

function setMapSource(s) {
  mapSource = s;
  const chaps = getSourceChapters(s);
  if (!chaps.some(c => c.chapter === selectedChapter)) {
    selectedChapter = chaps[0]?.chapter || 1;
  }
  renderMap();
}

function startLevel(id) {
  const levels = getLevels(mapSource, selectedChapter);
  const l = levels.find(x => x.id === id);
  if (!l) return;

  const isPractice = l.type === 'practice';
  const groupLevels = levels.filter(x => x.type === l.type);
  const groupIndex = groupLevels.findIndex(x => x.id === id);
  if (groupIndex > 0 && !state.levels[groupLevels[groupIndex - 1].id]?.passed) {
    toast('请先通过上一关');
    return;
  }

  if (isPractice) {
    startPracticeLevel(l);
  } else {
    startQuiz(l.questions, `第 ${selectedChapter} 章 · ${l.title}`, l.id);
  }
}

function continueLearning() {
  if (state.session) {
    if (state.session.type === 'practice') {
      resumePracticeQuiz();
    } else {
      resumeQuiz();
    }
    return;
  }

  const chaps = getSourceChapters(mapSource);
  for (const ch of chaps) {
    const levels = getLevels(mapSource, ch.chapter);
    const unpassed = levels.find(l => !state.levels[l.id]?.passed);
    if (unpassed) {
      selectedChapter = ch.chapter;
      renderMap();
      startLevel(unpassed.id);
      return;
    }
  }

  const firstLevels = getLevels(mapSource, chaps[0]?.chapter || 1);
  if (firstLevels.length) startLevel(firstLevels[0].id);
}

/* ========================================================
   非选择题自练关卡运行器 (Subjective Practice Runner)
   ======================================================== */
function startPracticeLevel(level) {
  practiceQuiz = {
    levelId: level.id,
    label: level.title,
    section: level.section,
    units: level.questions,
    index: 0,
    showAnswer: false,
    start: Date.now(),
    finished: false
  };
  state.session = { type: 'practice', levelId: level.id, index: 0 };
  save();
  renderPracticeLevelQuiz();
  if (!$('#quiz-dialog').open) $('#quiz-dialog').showModal();
}

function resumePracticeQuiz() {
  const s = state.session;
  if (!s || s.type !== 'practice' || !s.levelId) {
    state.session = null;
    save();
    continueLearning();
    return;
  }
  const levels = allLevels();
  const l = levels.find(x => x.id === s.levelId);
  if (!l) {
    state.session = null;
    save();
    continueLearning();
    return;
  }
  practiceQuiz = {
    levelId: l.id,
    label: l.title,
    section: l.section,
    units: l.questions,
    index: Math.min(s.index || 0, l.questions.length - 1),
    showAnswer: false,
    start: Date.now(),
    finished: false
  };
  renderPracticeLevelQuiz();
  if (!$('#quiz-dialog').open) $('#quiz-dialog').showModal();
}

function currentPracticeQ() {
  return practiceQuiz?.units[practiceQuiz.index];
}

function renderPracticeLevelQuiz() {
  if (!practiceQuiz) return;
  if (practiceQuiz.finished) {
    renderPracticeLevelResult();
    return;
  }
  const u = currentPracticeQ();
  if (!u) return;

  if (!state.drafts) state.drafts = {};
  if (!state.selfChecks) state.selfChecks = {};

  const fav = state.favorites.includes(u.id);
  const draftText = state.drafts[u.id] || '';
  const selfCheck = state.selfChecks[u.id];
  const isMastered = selfCheck && selfCheck.mastered === true;
  const isNeedsReview = selfCheck && selfCheck.mastered === false;

  // 使用通用格式化排版
  const stemHTML = (typeof formatPracticeStem === 'function' ? formatPracticeStem(u.stem) : esc(u.stem).replace(/\n/g, '<br>')) + (u.options?.length ? '<div class="practice-options">'+u.options.map((o,i)=>'<p><strong>'+String.fromCharCode(65+i)+'.</strong> '+esc(o)+'</p>').join('')+'</div>' : '');
  const codeBlockHTML = (u.code && typeof renderCodeBlock === 'function') ? renderCodeBlock(u.code) : (u.code ? `<pre class="practice-code"><code>${esc(u.code)}</code></pre>` : '');

  // AI 题解展示
  const teachingEntry = state.teaching ? state.teaching[u.id] : null;
  let aiLessonHTML = '';
  if (teachingEntry && teachingEntry.lesson) {
    const lesson = teachingEntry.lesson;
    aiLessonHTML = `
      <div class="practice-ai-card">
        <div class="ai-card-header">
          <strong>✦ AI 专属题解</strong>
          <span class="ai-provider-tag">${esc(lesson.provider === 'deepseek' ? 'DeepSeek' : 'Agent')} · AI生成</span>
        </div>
        ${lesson.hint ? `<div class="ai-hint"><b>提示：</b>${esc(lesson.hint)}</div>` : ''}
        <div class="ai-explanation">${formatTeaching(lesson.explanation)}</div>
        ${lesson.steps && lesson.steps.length ? `<div class="ai-steps"><b>解题步骤：</b><ol>${lesson.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}
        ${lesson.code ? `<div class="ai-code"><pre><code>${esc(lesson.code)}</code></pre></div>` : ''}
        ${lesson.takeaway ? `<div class="ai-takeaway"><b>记忆要点：</b>${esc(lesson.takeaway)}</div>` : ''}
      </div>
    `;
  }

  // 答案区域展示
  let answerContent = '';
  if (u.answer) {
    const ansBody = (typeof renderPracticeAnswer === 'function') ? renderPracticeAnswer(u.answer) : `<pre class="answer-pre"><code>${esc(u.answer)}</code></pre>`;
    answerContent = `<div class="practice-answer-body"><div class="answer-badge">原书参考答案</div>${ansBody}</div>`;
  } else {
    answerContent = `<div class="practice-answer-body pending"><div class="answer-badge pending">参考答案待补充</div><p class="answer-tip">${esc(u.answerOrigin || '参考答案尚未可靠匹配。')} 可使用 DeepSeek 获取AI参考答案与讲解。</p></div>`;
  }
  answerContent += getImportedAIHTML(u);
  const answerOriginHTML = u.answerOrigin ? `<div class="answer-origin"><span>来源：${esc(u.answerOrigin)}</span></div>` : '';

  $('#quiz-content').innerHTML = `
    <div class="quiz-head">
      <button class="quiz-back" onclick="pausePracticeQuiz()" aria-label="保存并返回">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 5-7 7 7 7"/></svg>返回地图
      </button>
      <div>
        <h2 id="quiz-title">${esc(practiceQuiz.label)}</h2>
        <small>${esc(material(u.source)?.name || u.source)} · ${esc(u.chapterName || ('第' + u.chapter + '章'))} · ${esc(u.section || '')}</small>
      </div>
      <button class="icon-button" onclick="pausePracticeQuiz()" aria-label="保存并关闭">✕</button>
    </div>

    <div class="quiz-progress">
      <i style="width:${((practiceQuiz.index + 1) / practiceQuiz.units.length) * 100}%"></i>
    </div>

    <div class="quiz-body practice-quiz-body">
      <div class="quiz-meta">
        <span>${String(practiceQuiz.index + 1).padStart(2, '0')} / ${String(practiceQuiz.units.length).padStart(2, '0')}</span>
        <span class="pill">${esc(u.kind)} · 第 ${esc(u.number)} 题</span>
        ${(u.ocrPending || (u.explanation && u.explanation.includes('[OCR')))
          ? '<span class="unit-badge ocr-pending" title="本题来自图片扫描件OCR，存疑符号已保留待核对">识别待核对</span>'
          : '<span class="unit-badge ocr-verified" title="文字版PDF直接提取">文本直提</span>'}
        ${u.answer
          ? '<span class="unit-badge ans-matched" title="已成功匹配原资料参考答案">已匹配答案</span>'
          : ((u.answerOrigin && (u.answerOrigin.includes('未附') || u.answerOrigin.includes('未提供')))
            ? '<span class="unit-badge ans-not-provided" title="原资料未提供单题答案">原资料无答案</span>'
            : '<span class="unit-badge ans-pending" title="答案待核对">答案待核对</span>')}
        <button class="text-button" onclick="toggleFavorite('${u.id}');renderPracticeLevelQuiz()" aria-label="${fav ? '取消收藏' : '收藏题目'}">${fav ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>

      ${u.reviewPending ? `<p class="answer-tip">题面待核对：${esc((u.warnings||[]).join('；'))}</p>` : ''}<div class="practice-stem">${stemHTML}</div>

      ${codeBlockHTML}

      <div class="practice-draft-zone">
        <div class="draft-header">
          <label for="practice-quiz-draft-input">我的作答 / 思路草稿：</label>
          <span class="draft-status" id="draft-status-indicator">自动保存中</span>
        </div>
        <textarea id="practice-quiz-draft-input" class="practice-draft-textarea" placeholder="在此输入你的作答、代码或分析思路，离开时自动保存草稿..." rows="4" oninput="onPracticeQuizDraftInput(this.value)">${esc(draftText)}</textarea>
      </div>

      <div class="practice-action-bar">
        <button type="button" class="action-btn toggle-answer-btn ${practiceQuiz.showAnswer ? 'active' : ''}" onclick="togglePracticeQuizAnswer()">
          ${practiceQuiz.showAnswer ? '收起参考答案' : '查看参考答案'}
        </button>
        <button type="button" class="action-btn mark-master-btn ${isMastered ? 'active' : ''}" onclick="markPracticeQuizSelfCheck(true)">
          ${isMastered ? '✓ 已掌握' : '标为已掌握'}
        </button>
        <button type="button" class="action-btn mark-review-btn ${isNeedsReview ? 'active' : ''}" onclick="markPracticeQuizSelfCheck(false)">
          ${isNeedsReview ? '↺ 需复习' : '标为需复习'}
        </button>
        <button type="button" class="action-btn ask-deepseek-btn" onclick="requestPracticeQuizAI()">
          ✦ DeepSeek 讲解
        </button>
      </div>

      <div id="practice-quiz-answer-section" class="practice-answer-section" style="${practiceQuiz.showAnswer ? '' : 'display:none;'}">
        ${answerContent}
        ${answerOriginHTML}
      </div>

      <div id="practice-quiz-ai-section">
        ${aiLessonHTML}
      </div>

      <div class="quiz-source">
        <span>原书出处：${esc(material(u.source)?.name || u.source)} · 第 ${u.page || u.number} 页/题</span>
      </div>
    </div>

    <div class="quiz-foot">
      <small>
        <span>作答后查看答案，自行评估并标记掌握情况</span>
      </small>
      <div class="quiz-step-actions">
        <button class="secondary" onclick="prevPracticeQuestion()" ${practiceQuiz.index === 0 ? 'disabled' : ''}>← 上一题</button>
        ${practiceQuiz.index === practiceQuiz.units.length - 1
          ? `<button class="primary" onclick="finishPracticeLevel()">完成关卡 ✓</button>`
          : `<button class="primary" onclick="nextPracticeQuestion()">下一题 →</button>`}
      </div>
    </div>
  `;
}

function onPracticeQuizDraftInput(val) {
  const u = currentPracticeQ();
  if (!u) return;
  if (!state.drafts) state.drafts = {};
  state.drafts[u.id] = val;
  save();
  const indicator = $('#draft-status-indicator');
  if (indicator) {
    indicator.textContent = '草稿已保存';
    indicator.style.color = '#10b981';
  }
}

function togglePracticeQuizAnswer() {
  if (!practiceQuiz) return;
  practiceQuiz.showAnswer = !practiceQuiz.showAnswer;
  const sec = $('#practice-quiz-answer-section');
  const btn = $('.toggle-answer-btn');
  if (sec) sec.style.display = practiceQuiz.showAnswer ? 'block' : 'none';
  if (btn) {
    btn.textContent = practiceQuiz.showAnswer ? '收起参考答案' : '查看参考答案';
    btn.classList.toggle('active', practiceQuiz.showAnswer);
  }
}

function markPracticeQuizSelfCheck(isMastered) {
  const u = currentPracticeQ();
  if (!u) return;
  if (!state.selfChecks) state.selfChecks = {};
  const current = state.selfChecks[u.id];
  if (current && current.mastered === isMastered) {
    delete state.selfChecks[u.id];
  } else {
    state.selfChecks[u.id] = { mastered: isMastered, date: day() };
  }
  save();
  renderPracticeLevelQuiz();
}

function requestPracticeQuizAI() {
  const u = currentPracticeQ();
  if (!u) return;
  if(u.aiExplanation){practiceQuiz.showAnswer=true;renderPracticeLevelQuiz();toast('已显示缓存的AI讲解，无需再次调用API。');return;}
  ensureTeaching();
  const draft = state.drafts ? (state.drafts[u.id] || '') : '';
  const context = {
    id: u.id,
    source: u.source,
    page: u.number,
    text: u.stem + (u.code ? '\n\n```c\n' + u.code + '\n```' : ''),
    draft
  };
  queuePracticeTeaching(context);
  toast('已请求 DeepSeek 讲解，请稍候…');
}

function prevPracticeQuestion() {
  if (!practiceQuiz || practiceQuiz.index <= 0) return;
  practiceQuiz.index--;
  practiceQuiz.showAnswer = false;
  state.session.index = practiceQuiz.index;
  save();
  renderPracticeLevelQuiz();
  $('#quiz-dialog').scrollTop = 0;
}

function nextPracticeQuestion() {
  if (!practiceQuiz) return;
  if (practiceQuiz.index >= practiceQuiz.units.length - 1) {
    finishPracticeLevel();
    return;
  }
  practiceQuiz.index++;
  practiceQuiz.showAnswer = false;
  state.session.index = practiceQuiz.index;
  save();
  renderPracticeLevelQuiz();
  $('#quiz-dialog').scrollTop = 0;
}

function finishPracticeLevel() {
  if (!practiceQuiz) return;
  practiceQuiz.finished = true;
  practiceQuiz.elapsed = Math.floor((Date.now() - practiceQuiz.start) / 1000);

  const units = practiceQuiz.units;
  const masteredCount = units.filter(u => state.selfChecks && state.selfChecks[u.id]?.mastered === true).length;
  const score = Math.round(masteredCount / units.length * 100);
  const passed = score >= 80; // 80% 掌握通关
  const stars = score === 100 ? 3 : score >= 80 ? 2 : 1;

  practiceQuiz.score = score;
  practiceQuiz.passed = passed;
  practiceQuiz.masteredCount = masteredCount;

  if (practiceQuiz.levelId) {
    const old = state.levels[practiceQuiz.levelId];
    if (!old || score > old.score) {
      state.levels[practiceQuiz.levelId] = { score, passed, stars };
    }
  }

  state.session = null;
  if (!state.days.includes(day())) state.days.push(day());
  save();
  renderPracticeLevelResult();
  render();
}

function renderPracticeLevelResult() {
  const total = practiceQuiz.units.length;
  const mastered = practiceQuiz.masteredCount;
  const review = total - mastered;
  const passed = practiceQuiz.passed;

  $('#quiz-content').innerHTML = `
    <div class="result">
      <div class="result-emblem">${passed ? '✦' : '↗'}</div>
      <div class="eyebrow">${passed ? 'WELL DONE. PRACTICE COMPLETE.' : 'KEEP PRACTICING.'}</div>
      <h2 id="quiz-title">${passed ? '自练通关成功，下一关见！' : '本关练习完成，多加巩固！'}</h2>
      <div class="result-score">${practiceQuiz.score}<small>分 · 掌握率</small></div>
      <p>
        ${passed ? '本关大题掌握率达到 80% 以上，顺利通关！' : '掌握率达到 80% 即可解锁通关勋章，先巩固需复习的题目再来试一次。'}<br>
        ${passed ? '已解锁本章节的后续自练关卡。' : ''}
      </p>
      <div class="result-breakdown">
        <span><strong>${mastered}</strong>标为已掌握</span>
        <span><strong>${review}</strong>待巩固复习</span>
        <span><strong>${Math.floor(practiceQuiz.elapsed / 60)}:${String(practiceQuiz.elapsed % 60).padStart(2, '0')}</strong>练习用时</span>
      </div>
      <div class="result-buttons">
        <button class="primary" onclick="retryPracticeLevel()">再练一次 ↻</button>
        <button class="secondary" onclick="closePracticeQuiz()">返回地图</button>
      </div>
    </div>
  `;
  $('#quiz-dialog').scrollTop = 0;
}

function retryPracticeLevel() {
  const l = practiceQuiz;
  startPracticeLevel({
    id: l.levelId,
    title: l.label,
    section: l.section,
    questions: l.units
  });
}

function pausePracticeQuiz() {
  if (practiceQuiz && !practiceQuiz.finished) {
    state.session = { type: 'practice', levelId: practiceQuiz.levelId, index: practiceQuiz.index };
    save();
    toast('已保存练习进度，随时可以继续。');
  }
  $('#quiz-dialog').close();
  render();
}

function closePracticeQuiz() {
  if (practiceQuiz?.finished) state.session = null;
  save();
  $('#quiz-dialog').close();
  location.hash = 'map';
  render();
}

/* ========================================================
   客观选择题关卡运行器 (Choice Quiz Runner)
   ======================================================== */
function startQuiz(questions, label, levelId = null) {
  if (!questions.length) {
    toast('暂无可练习题目。');
    return;
  }
  practiceQuiz = null;
  quiz = {
    ids: questions.map(q => q.id),
    label,
    levelId,
    index: 0,
    results: [],
    start: Date.now(),
    finished: false
  };
  state.session = quiz;
  selected = [];
  save();
  renderQuiz();
  if (!$('#quiz-dialog').open) $('#quiz-dialog').showModal();
}

function resumeQuiz() {
  const s = state.session;
  if (!s || !Array.isArray(s.ids) || !s.ids.length || s.ids.some(id => !validIds.has(id)) || s.index < 0 || s.index >= s.ids.length) {
    state.session = null;
    save();
    continueLearning();
    return;
  }
  practiceQuiz = null;
  quiz = s;
  selected = [];
  renderQuiz();
  if (!$('#quiz-dialog').open) $('#quiz-dialog').showModal();
}

function currentQ() {
  return Q.find(q => q.id === quiz.ids[quiz.index]);
}

function formatQuizStem(stem) {
  if (!stem) return '';
  const lines = stem.split(/\r?\n/);
  const stemLines = [];
  const codeLines = [];
  let inCode = false;
  for (const l of lines) {
    if (/^\s*(?:#include|void\s+main|int\s+main|main\s*\(|char\s+|int\s+|float\s+|double\s+|struct\s+|typedef\s+|for\s*\(|while\s*\(|if\s*\()/.test(l)) {
      inCode = true;
    }
    if (inCode) {
      codeLines.push(l);
    } else {
      stemLines.push(l);
    }
  }
  let html = '<div class="stem-text">' + esc(stemLines.join('\n')).replace(/\n/g, '<br>') + '</div>';
  if (codeLines.length > 0) {
    html += '<pre class="practice-code"><code>' + esc(codeLines.join('\n')) + '</code></pre>';
  }
  return html;
}

function renderQuiz() {
  if (quiz.finished) {
    renderResult();
    return;
  }
  const q = currentQ();
  const result = quiz.results[quiz.index];
  const fav = state.favorites.includes(q.id);
  const multi = q.answer.length > 1;
  const analysis = typeof explanationFor === 'function' ? explanationFor(q) : null;
  selected = result ? [...result.selected] : selected;

  // 检查是否已有 AI 缓存讲解
  const teachingEntry = state.teaching ? state.teaching[q.id] : null;

  $('#quiz-content').innerHTML = `
    <div class="quiz-head">
      <button class="quiz-back" onclick="pauseQuiz()" aria-label="保存并返回">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 5-7 7 7 7"/></svg>返回地图
      </button>
      <div>
        <h2 id="quiz-title">${esc(quiz.label)}</h2>
        <small>${esc(material(q.source)?.name || q.source)} · ${esc(q.section)}</small>
      </div>
      <button class="icon-button" onclick="pauseQuiz()" aria-label="保存并关闭练习">✕</button>
    </div>
    <div class="quiz-progress">
      <i style="width:${(quiz.index + (result ? 1 : 0)) / quiz.ids.length * 100}%"></i>
    </div>
    <div class="quiz-body">
      <div class="quiz-meta">
        <span>${String(quiz.index + 1).padStart(2, '0')} / ${String(quiz.ids.length).padStart(2, '0')}</span>
        <span class="pill">${multi ? '多选题 · 选出全部正确项' : '单选题'}</span>
        <button class="text-button" onclick="toggleFavorite('${q.id}');renderQuiz()" aria-label="${fav ? '取消收藏' : '收藏题目'}">${fav ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>
      <div class="question-stem">${formatQuizStem(q.stem)}</div>
      <div class="options" role="group" aria-label="答案选项">
        ${q.options.map((o, i) => {
          const l = String.fromCharCode(65 + i);
          const chosen = selected.includes(l);
          const cls = result ? (q.answer.includes(l) ? 'correct' : chosen ? 'incorrect' : '') : chosen ? 'selected' : '';
          return `<button class="option ${cls}" ${result ? 'disabled' : ''} data-answered="${!!result}" aria-pressed="${chosen}" onclick="choose('${l}')"><span class="letter">${l}</span><span class="option-text">${esc(o)}</span></button>`;
        }).join('')}
      </div>

      ${result ? `
        <div class="feedback ${result.correct ? '' : 'bad'}">
          <strong>${result.correct ? '✓ 回答正确，继续保持！' : `这次选了 ${esc(result.selected.join('、'))}，再看一下`}</strong>
          <div>${q.originalAnswer ? "纠正后答案" : "资料参考答案"}：<b>${esc(q.answer)}</b>${!result.correct ? ` · 你的选择：${esc(result.selected.join(''))}` : ''}</div>
          
          ${analysis ? `
            <div class="feedback-explanation" style="margin-top:10px;">
              <b>${esc(analysis.label)}：</b>${esc(analysis.text)}
            </div>
          ` : ''}

          ${teachingEntry && teachingEntry.lesson ? `
            <div class="ai-cached-explanation">
              <div class="ai-cached-tag">✦ AI 生成解析 · ${esc(teachingEntry.lesson.provider === 'deepseek' ? 'DeepSeek' : 'Agent')}</div>
              ${teachingEntry.lesson.hint ? `<p class="ai-hint"><b>提示：</b>${esc(teachingEntry.lesson.hint)}</p>` : ''}
              <div class="ai-body">${formatTeaching(teachingEntry.lesson.explanation)}</div>
              ${teachingEntry.lesson.takeaway ? `<p class="ai-takeaway"><b>记忆要点：</b>${esc(teachingEntry.lesson.takeaway)}</p>` : ''}
            </div>
          ` : (!result.correct ? `
            <div class="ai-trigger-row">
              <button type="button" class="secondary" style="font-size:12px;padding:6px 14px;min-height:36px;" onclick="requestAIForCurrentQuestion()">
                ✦ 由 AI 补充解析（DeepSeek）
              </button>
            </div>
          ` : '')}

          ${q.qualityNote ? `<p class="quality-note" style="margin-top:8px;"><b>题目勘误与提醒：</b>${esc(q.qualityNote)}${q.originalAnswer ? ` 资料原答案：${esc(q.originalAnswer)}。` : ""}</p>` : ""}
          <small class="answer-origin">判分依据：${esc(q.answerOrigin)} · 旧版资料可能含特定编译环境约定</small>${!teachingEntry?.lesson ? getImportedAIHTML(q) : ''}
        </div>
      ` : ''}

      <div class="quiz-source">
        <span>来源：${esc(material(q.source)?.name)} · 第 ${q.page} 页 · 原题 ${esc(q.number)}</span>
      </div>
    </div>
    <div class="quiz-foot">
      <small>
        <span class="desktop-quiz-hint">${result ? '认真理解，比一次答对更重要。' : '键盘 A–E 选择，Enter 提交。'}</span>
        <span class="mobile-quiz-hint">${result ? '进度已保存' : '选择答案后点击确认'}</span>
      </small>
      ${result ? `<button class="primary" onclick="nextQuestion()">${quiz.index === quiz.ids.length - 1 ? '查看本次成绩' : '下一题'} →</button>` : `<button class="primary" id="submit-answer" ${selected.length ? '' : 'disabled'} onclick="submitAnswer()">确认答案 →</button>`}
    </div>
  `;
  if (typeof renderTeachingPanel === 'function') renderTeachingPanel();
}

function requestAIForCurrentQuestion() {
  const q = currentQ();
  if (!q) return;
  toast('正在请求 DeepSeek 补充解析…');
  ensureTeaching();
  queueTeaching(q, selected);
}

function questionImageReady(img) {
  const group = img.closest('.quiz-body')?.querySelector('.options');
  if (group) group.querySelectorAll('button').forEach(b => { if (b.dataset.answered === 'false') b.disabled = false; });
}

function questionImageFailed(img) {
  img.hidden = true;
  img.nextElementSibling.hidden = false;
}

function choose(l) {
  if (!quiz || quiz.results[quiz.index]) return;
  const q = currentQ();
  if (q.answer.length > 1) {
    selected = selected.includes(l) ? selected.filter(x => x !== l) : [...selected, l].sort();
  } else {
    selected = [l];
  }
  renderQuiz();
}

function submitAnswer() {
  if (!quiz || !selected.length || quiz.results[quiz.index]) return;
  const q = currentQ();
  const correct = selected.join('') === q.answer;
  quiz.results[quiz.index] = { id: q.id, selected: [...selected], correct };
  const old = state.answers[q.id] || { attempts: 0, correct: 0 };
  state.answers[q.id] = { attempts: old.attempts + 1, correct: old.correct + (correct ? 1 : 0), last: correct, date: day() };

  if (!correct && typeof queueTeaching === 'function') queueTeaching(q, selected);
  if (!correct && !state.wrong.includes(q.id)) state.wrong.push(q.id);
  if (correct) state.wrong = state.wrong.filter(id => id !== q.id);
  if (!state.days.includes(day())) state.days.push(day());

  state.session = quiz;
  save();
  renderQuiz();
  $('#wrong-count').textContent = state.wrong.length;
}

function nextQuestion() {
  if (!quiz.results[quiz.index]) return;
  if (quiz.index === quiz.ids.length - 1) {
    finishQuiz();
    return;
  }
  quiz.index++;
  selected = [];
  state.session = quiz;
  save();
  renderQuiz();
  $('#quiz-dialog').scrollTop = 0;
}

function finishQuiz() {
  quiz.finished = true;
  const correct = quiz.results.filter(r => r.correct).length;
  const score = Math.round(correct / quiz.ids.length * 100);
  const passed = correct >= Math.ceil(quiz.ids.length * .8);
  quiz.score = score;
  quiz.passed = passed;
  quiz.elapsed = Math.floor((Date.now() - quiz.start) / 1000);

  if (quiz.levelId) {
    const old = state.levels[quiz.levelId];
    if (!old || score > old.score) {
      state.levels[quiz.levelId] = { score, passed, stars: score === 100 ? 3 : score >= 90 ? 2 : 1 };
    }
  }
  state.session = null;
  save();
  renderResult();
  render();
}

function renderResult() {
  const correct = quiz.results.filter(r => r.correct).length;
  const wrong = quiz.ids.length - correct;
  const level = !!quiz.levelId;

  $('#quiz-content').innerHTML = `
    <div class="result">
      <div class="result-emblem">${quiz.passed ? '✦' : '↗'}</div>
      <div class="eyebrow">${quiz.passed ? 'WELL DONE. KEEP GOING.' : 'EVERY TRY COUNTS.'}</div>
      <h2 id="quiz-title">${level ? (quiz.passed ? '通关成功，下一关见！' : '就差一点，再来一次。') : '本次练习完成！'}</h2>
      <div class="result-score">${quiz.score}<small> / 100</small></div>
      <p>
        ${level ? (quiz.passed ? '这一小步，值得为自己打个勾。' : '正确率达到 80% 即可通关，先复习错题再试一次。') : '练过的题，都在成为你的知识。'}<br>
        ${quiz.passed && level ? '已解锁本章节的下一关。' : ''}
      </p>
      <div class="result-breakdown">
        <span><strong>${correct}</strong>回答正确</span>
        <span><strong>${wrong}</strong>需要巩固</span>
        <span><strong>${Math.floor(quiz.elapsed / 60)}:${String(quiz.elapsed % 60).padStart(2, '0')}</strong>练习用时</span>
      </div>
      <div class="result-buttons">
        ${wrong ? '<button class="secondary" onclick="retryMistakes()">巩固本次错题</button>' : ''}
        ${level && quiz.passed ? '<button class="primary" onclick="nextLevel()">继续闯关 →</button>' : '<button class="primary" onclick="retryQuiz()">再练一次 ↻</button>'}
        <button class="quiet" onclick="closeQuiz()">返回地图</button>
      </div>
    </div>
  `;
  $('#quiz-dialog').scrollTop = 0;
}

function retryQuiz() {
  const old = quiz;
  startQuiz(old.ids.map(id => Q.find(q => q.id === id)), old.label, old.levelId);
}

function retryMistakes() {
  const a = quiz.results.filter(r => !r.correct).map(r => Q.find(q => q.id === r.id));
  startQuiz(a, '本次错题巩固');
}

function nextLevel() {
  const levels = allLevels().filter(l => l.type === 'choice');
  const idx = levels.findIndex(l => l.id === quiz.levelId);
  const next = levels[idx + 1];
  if (next && next.id.split('-')[0] === quiz.levelId.split('-')[0]) {
    const parts = next.id.split('-');
    mapSource = parts[0];
    selectedChapter = Number(parts[1]);
    closeQuiz();
    location.hash = 'map';
    render();
    startQuiz(next.questions, `第 ${selectedChapter} 章 · ${next.title}`, next.id);
  } else {
    closeQuiz();
    toast('本资料的选择题已全部通关，快去挑战自练大题吧！');
  }
}

function pauseQuiz() {
  if (quiz && !quiz.finished) {
    state.session = quiz;
    save();
    toast('已保存练习，下次可以接着答。');
  }
  $('#quiz-dialog').close();
  render();
}

function closeQuiz() {
  if (quiz?.finished) state.session = null;
  save();
  $('#quiz-dialog').close();
  location.hash = 'map';
  render();
}

function toggleFavorite(id) {
  if (state.favorites.includes(id)) {
    state.favorites = state.favorites.filter(x => x !== id);
    toast('已取消收藏');
  } else {
    state.favorites.push(id);
    toast('已加入收藏夹');
  }
  save();
}

/* ========================================================
   其他功能页面视图（随机挑战、错题与收藏、资料库、学习记录）
   ======================================================== */
function renderRandom() {
  const allChaps = getSourceChapters(mapSource);
  $('#app').innerHTML = title('MIX IT UP', '随机出题，检验真正的掌握。', '换个顺序，再遇见熟悉的知识点。') +
    `<div class="panel random-hero">
      <div>
        <span class="pill">混合练习 · 不影响关卡解锁</span>
        <h2 style="margin-top:20px">准备接受一点小挑战？</h2>
        <p class="save-note">自由选择范围，题目每次随机抽取。答错的题会自动进入错题本。</p>
        <div class="random-form">
          <label>练习章节
            <select id="random-chapter">
              <option value="all">全部章节</option>
              ${allChaps.map(c => `<option value="${c.chapter}">${c.chapter}. ${esc(c.name)}</option>`).join('')}
            </select>
          </label>
          <label>题目来源
            <select id="random-source">
              <option value="all">全部已整理题库</option>
              ${BANK.materials.filter(m => Q.some(q => q.source === m.id)).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
            </select>
          </label>
          <label>挑战长度
            <select id="random-size">
              <option value="10">10 道 · 轻松热身</option>
              <option value="20">20 道 · 专注练习</option>
              <option value="30">30 道 · 深度挑战</option>
            </select>
          </label>
          <button class="primary" onclick="randomChallenge()">生成挑战 <span>⤨</span></button>
        </div>
      </div>
      <div class="big-code" aria-hidden="true">{ ? }</div>
    </div>` +
    statCards();
}

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function randomChallenge() {
  const c = $('#random-chapter').value;
  const s = $('#random-source').value;
  const n = Number($('#random-size').value);
  const pool = Q.filter(q => (c === 'all' || q.chapter === Number(c)) && (s === 'all' || q.source === s));
  if (!pool.length) {
    toast('这个范围暂无已整理的选择题，请换个范围。');
    return;
  }
  startQuiz(shuffle(pool).slice(0, n), '随机挑战');
}

function renderList() {
  const wrong = view === 'wrong';
  const ids = wrong ? state.wrong : state.favorites;
  $('#app').innerHTML = title(
    wrong ? 'LEARN FROM EVERY MISTAKE' : 'KEEP THE GOOD QUESTIONS',
    wrong ? '错过的题，再学会一次。' : '值得回看的题，留在这里。',
    wrong ? '在复习中答对后，题目会自动移出错题本。' : '在答题时点击星标，就能收藏这道题。'
  ) +
  `<div class="toolbar">
    <span class="save-note">共 ${ids.length} 道题</span>
    ${ids.length ? `<button class="primary" onclick="practiceList('${wrong ? 'wrong' : 'favorites'}')">${wrong ? '开始错题复习' : '练习收藏题'} <span>↗</span></button>` : ''}
  </div>
  <div class="filters">
    <input id="list-search" type="search" placeholder="搜索题干、选项或知识点…" aria-label="搜索题目" oninput="filterList()">
  </div>
  <div id="question-results"></div>`;
  filterList();
}

function practiceList(type) {
  const ids = type === 'wrong' ? state.wrong : state.favorites;
  const questions = Q.filter(q => ids.includes(q.id));
  if (questions.length) {
    startQuiz(questions, type === 'wrong' ? '错题复习' : '收藏练习');
  } else {
    toast('当前列表暂无可选的选择题，可直接查看自练大题。');
  }
}

function questionRow(id) {
  const q = Q.find(x => x.id === id);
  if (q) {
    return `
      <article class="question-item">
        <div class="q-copy">
          <p>${esc(q.stem)}</p>
          <small>${esc(material(q.source)?.name || q.source)} · 第 ${q.page} 页 · 原题 ${esc(q.number)} · 客观选择题</small>
        </div>
        <div class="list-actions">
          <button class="secondary" onclick="practiceOne('${q.id}')">练习</button>
          ${view === 'favorites' ? `<button class="quiet" onclick="toggleFavorite('${q.id}');filterList()">移除收藏</button>` : ''}
        </div>
      </article>
    `;
  }
  const u = PU().find(x => x.id === id);
  if (u) {
    return `
      <article class="question-item">
        <div class="q-copy">
          <p>${esc(u.stem)}</p>
          <small>${esc(material(u.source)?.name || u.source)} · 第 ${u.page || u.number} 题 · ${esc(u.kind)}</small>
        </div>
        <div class="list-actions">
          <button class="secondary" onclick="practiceOneUnit('${u.id}')">练习</button>
          ${view === 'favorites' ? `<button class="quiet" onclick="toggleFavorite('${u.id}');filterList()">移除收藏</button>` : ''}
        </div>
      </article>
    `;
  }
  return '';
}

function filterList() {
  const term = ($('#list-search')?.value || '').trim().toLowerCase();
  const ids = view === 'wrong' ? state.wrong : state.favorites;
  const pool = ids.filter(id => {
    const q = Q.find(x => x.id === id);
    if (q) return `${q.stem} ${q.options.join(' ')}`.toLowerCase().includes(term);
    const u = PU().find(x => x.id === id);
    if (u) return `${u.stem} ${u.code || ''} ${u.answer || ''}`.toLowerCase().includes(term);
    return false;
  });

  $('#question-results').innerHTML = pool.length ? `
    <div class="question-list">
      ${pool.slice(0, listLimit).map(questionRow).join('')}
    </div>
    ${pool.length > listLimit ? `<button class="quiet load-more" onclick="listLimit+=30;filterList()">显示更多</button>` : ''}
  ` : `
    <div class="panel empty">
      <div class="empty-icon">${view === 'wrong' ? '✓' : '☆'}</div>
      <h2>${term ? '没有找到匹配的题目' : view === 'wrong' ? '这里暂时没有错题' : '把想回看的题收藏起来'}</h2>
      <p>${term ? '试试其他关键词。' : view === 'wrong' ? '每次认真作答，都在让知识更牢固。' : '答题时点击 ☆，就会出现在这里。'}</p>
      <a class="secondary" href="#map">去闯一关 ↗</a>
    </div>
  `;
}

function practiceOne(id) {
  const q = Q.find(q => q.id === id);
  if (q) startQuiz([q], '单题练习');
}

function practiceOneUnit(id) {
  const u = PU().find(x => x.id === id);
  if (!u) return;
  startPracticeLevel({
    id: `single-${u.id}`,
    title: `自练单题 · ${u.kind}`,
    section: u.section || '自练',
    questions: [u],
    index: 0
  });
}

function renderLibrary() {
  $('#app').innerHTML = title('THE QUESTION LIBRARY', '你的题库，都在这里。', `${Q.length} 道客观选择题 · ${PU().length} 道自练大题 · ${getAllSources().length} 份题库`) +
    `<div class="mini-note" style="margin:0 0 25px">
      <strong>资料整理说明</strong>当前题库共 ${Q.length + PU().length} 道题目；新增资料的完整性以导入核对报告为准。选择题在闯关地图中自动判分；填空、阅读、改错和编程大题在地图提供专属自练关卡与原题自练区，可直接作答并核对原书标准答案。
    </div>
    <div class="section-top">
      <h2>选择题检索</h2>
      <small>找到某一题，再练一次</small>
    </div>
    <div class="filters">
      <input id="bank-search" type="search" placeholder="搜索题干或代码，例如：printf、指针…" aria-label="搜索全部题目" oninput="searchBank()">
      <select id="bank-quality" aria-label="筛选解析与勘误" onchange="listLimit=30;searchBank()">
        <option value="all">全部题目</option>
        <option value="reviewed">有详细解析（${BANK.quality?.reviewed || 0} 题）</option>
        <option value="issues">勘误／争议题（${(BANK.quality?.corrected || 0) + (BANK.quality?.flagged || 0)} 题）</option>
      </select>
      <select id="bank-source" aria-label="筛选题库" onchange="listLimit=30;searchBank()">
        <option value="all">全部来源</option>
        ${BANK.materials.filter(m => Q.some(q => q.source === m.id)).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
      </select>
    </div>
    <div id="bank-results"></div>
    <div class="section-top" style="margin-top:36px">
      <h2>资料来源（${BANK.materials.length} 份）</h2>
      <small>完整保留原书题型、代码与题序</small>
    </div>
    <div class="material-grid">
      ${BANK.materials.map(m => {
        const qc = Q.filter(q => q.source === m.id).length;
        const pc = PU().filter(u => u.source === m.id).length;
        return `
          <article class="material-card">
            <span class="doc-icon">PDF</span>
            <h3>${esc(m.name)}</h3>
            <p>${m.pages} 页 · ${qc} 道选择题 + ${pc} 道自练大题<br>${esc(m.note)}</p>
            <div class="material-actions">
              <button class="secondary" onclick="setMapSource('${m.id}');location.hash='map'">进入关卡 ↗</button>
              ${qc ? `<button class="quiet" onclick="practiceFromSource('${m.id}')">随机练习</button>` : ''}
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
  searchBank();
}

function searchBank() {
  const term = $('#bank-search').value.trim().toLowerCase();
  const s = $('#bank-source').value;
  const quality = $('#bank-quality').value;
  const pool = Q.filter(q => (quality === 'all' || (quality === 'reviewed' ? q.hasReviewedExplanation : !!q.qualityNote)) && (s === 'all' || q.source === s) && `${q.stem} ${q.options.join(' ')}`.toLowerCase().includes(term));
  $('#bank-results').innerHTML = `
    <p class="save-note">找到 ${pool.length} 道题</p>
    <div class="question-list">
      ${pool.slice(0, (term || quality !== 'all') ? listLimit : 5).map(q => questionRow(q.id)).join('')}
    </div>
    ${(term || quality !== 'all') && pool.length > listLimit ? `<button class="quiet load-more" onclick="listLimit+=30;searchBank()">显示更多</button>` : ''}
  `;
}

function practiceFromSource(s) {
  startQuiz(shuffle(Q.filter(q => q.source === s)).slice(0, 10), '题库随机练习');
}

function renderProgress() {
  const chaps = getSourceChapters('h');
  $('#app').innerHTML = title('SMALL STEPS ADD UP', '看得见的进步。', '每一次练习与作答，都有真实记录。') +
    statCards() +
    `<div class="panel">
      <div class="section-top">
        <h2>主线章节掌握（好老师 612 题）</h2>
        <small>客观选择题 + 自练大题综合完成度</small>
      </div>
      <div class="progress-bars">
        ${chaps.map(ch => {
          const choiceQs = Q.filter(q => q.source === 'h' && q.chapter === ch.chapter);
          const practiceQs = PU().filter(u => u.source === 'h' && u.chapter === ch.chapter);
          const choiceDone = choiceQs.filter(q => state.answers[q.id]).length;
          const practiceDone = practiceQs.filter(u => (state.drafts && state.drafts[u.id]) || (state.selfChecks && state.selfChecks[u.id])).length;
          const totalDone = choiceDone + practiceDone;
          const totalCount = ch.totalCount;
          const percent = totalCount ? Math.round(totalDone / totalCount * 100) : 0;
          return `
            <div class="progress-row">
              <span>${String(ch.chapter).padStart(2, '0')} ${esc(ch.name)}</span>
              <div class="bar"><i style="width:${percent}%"></i></div>
              <small>${totalDone} / ${totalCount}（选 ${choiceDone}/${choiceQs.length} · 练 ${practiceDone}/${practiceQs.length}）</small>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    <div class="panel">
      <h2>带走你的学习进度</h2>
      <p class="save-note">进度保存在当前设备和浏览器，不会自动跨设备同步。导出 JSON 备份，可在另一台设备导入恢复。</p>
      <div class="list-actions">
        <button class="secondary" onclick="exportProgress()">导出学习记录 ↓</button>
        <button class="quiet" onclick="document.querySelector('#import-file').click()">导入学习记录 ↑</button>
      </div>
      <p class="save-note">累计学习 ${state.days.length} 天 · 错题 ${state.wrong.length} 道 · 收藏 ${state.favorites.length} 道 · 自练草稿 ${Object.keys(state.drafts || {}).length} 篇</p>
    </div>`;
}

function exportProgress() {
  const u = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = u;
  a.download = `C语言闯关营-学习记录-${day()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (f.size > 1e7) throw Error();
    const d = JSON.parse(await f.text());
    if (d.version !== 1 || !d.answers || typeof d.answers !== 'object' || !Array.isArray(d.wrong) || !Array.isArray(d.favorites) || !Array.isArray(d.days) || !d.levels || typeof d.levels !== 'object') {
      throw Error();
    }
    for (const [id, a] of Object.entries(d.answers)) {
      if (validIds.has(id) && Number.isInteger(a.attempts) && a.attempts >= 0 && Number.isInteger(a.correct) && a.correct >= 0 && a.correct <= a.attempts) {
        const old = state.answers[id];
        if (!old || a.attempts > old.attempts) state.answers[id] = a;
      }
    }
    state.wrong = [...new Set([...state.wrong, ...d.wrong.filter(id => validIds.has(id))])];
    state.favorites = [...new Set([...state.favorites, ...d.favorites.filter(id => validIds.has(id))])];
    state.days = [...new Set([...state.days, ...d.days.filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))])];
    if (d.drafts && typeof d.drafts === 'object') {
      state.drafts = { ...state.drafts, ...d.drafts };
    }
    if (d.selfChecks && typeof d.selfChecks === 'object') {
      state.selfChecks = { ...state.selfChecks, ...d.selfChecks };
    }
    if (d.teaching && typeof d.teaching === 'object') {
      state.teaching = { ...state.teaching, ...d.teaching };
    }
    for (const l of allLevels()) {
      const x = d.levels[l.id];
      if (x && Number.isFinite(x.score) && x.score >= 0 && x.score <= 100 && (!state.levels[l.id] || x.score > state.levels[l.id].score)) {
        state.levels[l.id] = { score: x.score, passed: x.score >= 80, stars: x.score === 100 ? 3 : x.score >= 90 ? 2 : 1 };
      }
    }
    save();
    toast('学习记录已合并。');
    render();
  } catch (err) {
    toast('无法识别这份记录，请导入本站导出的 JSON 文件。');
  }
  e.target.value = '';
});

$('#quiz-dialog').addEventListener('cancel', e => {
  e.preventDefault();
  if (practiceQuiz && !practiceQuiz.finished) {
    pausePracticeQuiz();
  } else {
    pauseQuiz();
  }
});

document.addEventListener('keydown', e => {
  if (!$('#quiz-dialog').open || $('#material-dialog').open || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (practiceQuiz && !practiceQuiz.finished) {
    if (e.key === 'ArrowRight' || e.key === 'n') {
      e.preventDefault();
      if (practiceQuiz.index === practiceQuiz.units.length - 1) finishPracticeLevel();
      else nextPracticeQuestion();
    } else if (e.key === 'ArrowLeft' || e.key === 'p') {
      e.preventDefault();
      prevPracticeQuestion();
    }
    return;
  }
  if (!quiz || quiz.finished) return;
  const l = e.key.toUpperCase();
  if (/^[A-E]$/.test(l) && currentQ() && l.charCodeAt(0) - 65 < currentQ().options.length) {
    e.preventDefault();
    choose(l);
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (quiz.results[quiz.index]) nextQuestion();
    else submitAnswer();
  }
});

window.addEventListener('hashchange', () => {
  listLimit = 30;
  render();
  window.scrollTo(0, 0);
});

render();

function refreshAccountStatus() {
  const label = document.querySelector('#account-status');
  if (label) label.textContent = window.CQuestAccount ? window.CQuestAccount.statusLabel() : '本机存档';
}
window.addEventListener('cquest:account-status', refreshAccountStatus);
if (window.CQuestAccount) {
  window.CQuestAccount.attach({
    getState: () => state,
    replaceState: next => {
      state = { ...blank(), ...next, version: 1 };
      state.drafts ||= {};
      state.selfChecks ||= {};
      state.teaching ||= {};
      render();
    },
    render: () => render(),
    toast: message => toast(message)
  });
}
refreshAccountStatus();
