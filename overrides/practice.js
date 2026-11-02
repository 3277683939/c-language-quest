/* 纯结构化自练题库模块：直接显示题干、代码、选项与精准答案，免去翻 PDF 与截图 */
let practiceFilterKind = 'all';
let practiceFilterSource = 'all';
let practiceSearchTerm = '';
let currentPracticeIndex = 0;
let showCurrentAnswer = false;

function getFilteredPracticeUnits() {
  const units = (window.PRACTICE_UNITS ? (Array.isArray(window.PRACTICE_UNITS) ? window.PRACTICE_UNITS : (window.PRACTICE_UNITS.units || [])) : []);
  return units.filter(u => {
    if (practiceFilterKind !== 'all' && u.kind !== practiceFilterKind) return false;
    if (practiceFilterSource !== 'all' && u.source !== practiceFilterSource) return false;
    if (practiceSearchTerm) {
      const term = practiceSearchTerm.toLowerCase();
      const matchStem = (u.stem || '').toLowerCase().includes(term);
      const matchCode = (u.code || '').toLowerCase().includes(term);
      const matchAns = (u.answer || '').toLowerCase().includes(term);
      const matchId = (u.id || '').toLowerCase().includes(term);
      if (!matchStem && !matchCode && !matchAns && !matchId) return false;
    }
    return true;
  });
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPracticeStem(rawStem) {
  if (!rawStem) return '';
  let escaped = escapeHTML(rawStem);
  // 渲染下划线为醒目的试卷填空槽位
  escaped = escaped.replace(/(_{3,})/g, '<span class="practice-blank-slot" title="填空横线">______</span>');
  
  // 区分段落与题干换行
  const paragraphs = escaped.split(/\n{2,}/);
  const htmlParts = paragraphs.map(p => {
    p = p.trim();
    if (!p) return '';
    const formattedP = p.replace(/\n(?=([（(]\d+[)）]|[①②③④⑤⑥⑦⑧⑨⑩]|【))/g, '<br>');
    return `<p class="stem-paragraph">${formattedP}</p>`;
  });
  return htmlParts.join('');
}

function renderCodeBlock(code) {
  if (!code) return '';
  return `<div class="practice-code-wrapper"><div class="code-header"><span class="code-lang">C CODE</span><button type="button" class="copy-code-btn" onclick="copyPracticeCode(this)">复制</button></div><pre class="practice-code"><code>${escapeHTML(code)}</code></pre></div>`;
}

function copyPracticeCode(btn) {
  const pre = btn.closest('.practice-code-wrapper')?.querySelector('pre code');
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent).then(() => {
    const old = btn.textContent;
    btn.textContent = '已复制！';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }).catch(() => {
    toast('复制失败，请手动选取');
  });
}

function renderPractice() {
  if (!state.drafts) state.drafts = {};
  if (!state.selfChecks) state.selfChecks = {};

  const allUnits = (window.PRACTICE_UNITS ? (Array.isArray(window.PRACTICE_UNITS) ? window.PRACTICE_UNITS : (window.PRACTICE_UNITS.units || [])) : []);
  const filtered = getFilteredPracticeUnits();

  // Restore last practiced unit if found
  if (state.lastPracticeUnitId && currentPracticeIndex === 0) {
    const lastIdx = filtered.findIndex(u => u.id === state.lastPracticeUnitId);
    if (lastIdx >= 0) {
      currentPracticeIndex = lastIdx;
    }
  }

  if (currentPracticeIndex >= filtered.length) {
    currentPracticeIndex = Math.max(0, filtered.length - 1);
  }

  const currentUnit = filtered[currentPracticeIndex];
  if (currentUnit) {
    state.lastPracticeUnitId = currentUnit.id;
    save();
  }

  // Collect available sources and kinds for dropdowns
  const availableKinds = [...new Set(allUnits.map(u => u.kind))];
  const sourceNames = {
    'all': '全部题库来源',
    'h': '好老师《基础过关600题》',
    'x': '贤彬《C语言程序设计习题集》',
    'n11': '高频核心简答100题',
    'n4': '程序改错专项精练138题',
    'n8': '全真模拟考试卷',
    'n9': '经典算法与程序设计16例',
    'n10': '综合练习卷',
    'n7': '期末全真考卷（三）',
    'n5': '程序阅读与设计精选详解',
    'n2': '东华理工《C语言习题集》'
  };
  const availableSources = ['all', ...new Set(allUnits.map(u => u.source))];

  const kindOptions = ['all', ...availableKinds].map(k => {
    const label = k === 'all' ? '全部题型' : k;
    return `<option value="${escapeHTML(k)}" ${practiceFilterKind === k ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const sourceOptions = availableSources.map(s => {
    const label = sourceNames[s] || s;
    return `<option value="${escapeHTML(s)}" ${practiceFilterSource === s ? 'selected' : ''}>${label}</option>`;
  }).join('');

  // Draft and self-check state
  const draftText = currentUnit ? (state.drafts[currentUnit.id] || '') : '';
  const selfCheck = currentUnit ? state.selfChecks[currentUnit.id] : null;
  const isMastered = selfCheck && selfCheck.mastered === true;
  const isNeedsReview = selfCheck && selfCheck.mastered === false;

  // Question body
  let questionHTML = '';
  if (!currentUnit) {
    questionHTML = `
      <div class="empty-state">
        <p>没有匹配的题目，请尝试更换题型或清空搜索关键词。</p>
        <button class="primary" onclick="resetPracticeFilter()">重置筛选</button>
      </div>
    `;
  } else {
    // Process stem: proper typography without crude newline breaking
    const stemHTML = formatPracticeStem(currentUnit.stem);

    // Code block
    const codeBlockHTML = currentUnit.code ? renderCodeBlock(currentUnit.code) : '';

    // Answer block
    let answerContent = '';
    if (currentUnit.answer) {
      answerContent = `<div class="practice-answer-body"><div class="answer-badge">参考答案</div><pre class="answer-pre"><code>${escapeHTML(currentUnit.answer)}</code></pre></div>`;
    } else {
      answerContent = `<div class="practice-answer-body pending"><div class="answer-badge pending">待核对</div><p class="answer-tip">原题未附带单题独立标准答案，请参考教材对应章节或点击下方“DeepSeek 辅导”获取智能解析。</p></div>`;
    }

    const answerOriginHTML = currentUnit.answerOrigin ? `<div class="answer-origin"><span>来源：${escapeHTML(currentUnit.answerOrigin)}</span></div>` : '';

    // Check if AI lesson exists for this question
    const teachingEntry = state.teaching ? state.teaching[currentUnit.id] : null;
    let aiLessonHTML = '';
    if (teachingEntry && teachingEntry.lesson) {
      const lesson = teachingEntry.lesson;
      aiLessonHTML = `
        <div class="practice-ai-card">
          <div class="ai-card-header">
            <strong>✦ AI 专属题解</strong>
            <span class="ai-provider-tag">${escapeHTML(lesson.provider || 'DeepSeek')}</span>
          </div>
          ${lesson.hint ? `<div class="ai-hint"><b>提示：</b>${escapeHTML(lesson.hint)}</div>` : ''}
          <div class="ai-explanation">${formatTeaching(lesson.explanation)}</div>
          ${lesson.steps && lesson.steps.length ? `<div class="ai-steps"><b>解题步骤：</b><ol>${lesson.steps.map(s => `<li>${escapeHTML(s)}</li>`).join('')}</ol></div>` : ''}
          ${lesson.code ? `<div class="ai-code"><pre><code>${escapeHTML(lesson.code)}</code></pre></div>` : ''}
          ${lesson.takeaway ? `<div class="ai-takeaway"><b>记忆要点：</b>${escapeHTML(lesson.takeaway)}</div>` : ''}
        </div>
      `;
    }

    questionHTML = `
      <article class="practice-card" id="practice-unit-card">
        <div class="practice-meta">
          <span class="unit-source-badge">${escapeHTML(currentUnit.sourceTitle || currentUnit.source)}</span>
          <span class="unit-chapter-badge">${escapeHTML(currentUnit.chapterName || ('第' + currentUnit.chapter + '章'))} ${escapeHTML(currentUnit.section || '')}</span>
          <span class="unit-kind-badge">${escapeHTML(currentUnit.kind)}</span>
          <span class="unit-num-badge">第 ${currentUnit.number} 题</span>
        </div>

        <div class="practice-stem">${stemHTML}</div>

        ${codeBlockHTML}

        <div class="practice-draft-zone">
          <div class="draft-header">
            <label for="practice-draft-input">我的作答 / 思路草稿：</label>
            <span class="draft-status" id="draft-status-indicator">自动保存中</span>
          </div>
          <textarea id="practice-draft-input" class="practice-draft-textarea" placeholder="在此输入你的作答、代码或分析过程，切换题目自动保存草稿..." rows="4" oninput="onPracticeDraftInput(this.value)">${escapeHTML(draftText)}</textarea>
        </div>

        <div class="practice-action-bar">
          <button type="button" class="action-btn toggle-answer-btn ${showCurrentAnswer ? 'active' : ''}" onclick="togglePracticeAnswer()">
            ${showCurrentAnswer ? '收起参考答案' : '查看参考答案'}
          </button>
          <button type="button" class="action-btn mark-master-btn ${isMastered ? 'active' : ''}" onclick="markPracticeSelfCheck(true)">
            ${isMastered ? '✓ 已掌握' : '标为已掌握'}
          </button>
          <button type="button" class="action-btn mark-review-btn ${isNeedsReview ? 'active' : ''}" onclick="markPracticeSelfCheck(false)">
            ${isNeedsReview ? '↺ 需复习' : '标为需复习'}
          </button>
          <button type="button" class="action-btn ask-deepseek-btn" onclick="requestPracticeUnitAI()">
            ✦ DeepSeek 讲解
          </button>
        </div>

        <div id="practice-answer-section" class="practice-answer-section" style="${showCurrentAnswer ? '' : 'display:none;'}">
          ${answerContent}
          ${answerOriginHTML}
        </div>

        <div id="practice-ai-section">
          ${aiLessonHTML}
        </div>
      </article>
    `;
  }

  $('#app').innerHTML = `
    <div class="practice-page-container">
      <div class="page-title">
        <div>
          <h1>原题自练</h1>
          <p>全题库纯文本题目，保留代码缩进与排版，支持逐题作答、查看答案与 AI 深度讲解。</p>
        </div>
      </div>

      <div class="practice-controls-card">
        <div class="filter-row">
          <label class="control-group">
            <span class="control-label">来源</span>
            <select class="control-select" onchange="onPracticeSourceChange(this.value)">
              ${sourceOptions}
            </select>
          </label>

          <label class="control-group">
            <span class="control-label">题型</span>
            <select class="control-select" onchange="onPracticeKindChange(this.value)">
              ${kindOptions}
            </select>
          </label>

          <div class="search-group">
            <span class="control-label">搜索题目</span>
            <input type="search" class="control-input" placeholder="输入题干、代码或答案关键词..." value="${escapeHTML(practiceSearchTerm)}" oninput="onPracticeSearch(this.value)">
          </div>
        </div>

        <div class="nav-row">
          <button type="button" class="secondary nav-btn" onclick="goPrevPractice()" ${currentPracticeIndex <= 0 ? 'disabled' : ''}>← 上一题</button>
          <div class="index-display">
            <span>第 <b>${filtered.length > 0 ? (currentPracticeIndex + 1) : 0}</b> / ${filtered.length} 题</span>
            ${currentUnit ? `<span class="unit-id-tip">${escapeHTML(currentUnit.id)}</span>` : ''}
          </div>
          <button type="button" class="secondary nav-btn" onclick="goNextPractice()" ${currentPracticeIndex >= filtered.length - 1 ? 'disabled' : ''}>下一题 →</button>
        </div>
      </div>

      <div class="practice-main-content">
        ${questionHTML}
      </div>
    </div>
  `;
}

// Event Handlers
function onPracticeSourceChange(val) {
  practiceFilterSource = val;
  currentPracticeIndex = 0;
  showCurrentAnswer = false;
  renderPractice();
}

function onPracticeKindChange(val) {
  practiceFilterKind = val;
  currentPracticeIndex = 0;
  showCurrentAnswer = false;
  renderPractice();
}

let searchDebounceTimer = null;
function onPracticeSearch(val) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    practiceSearchTerm = val.trim();
    currentPracticeIndex = 0;
    showCurrentAnswer = false;
    renderPractice();
  }, 300);
}

function resetPracticeFilter() {
  practiceFilterKind = 'all';
  practiceFilterSource = 'all';
  practiceSearchTerm = '';
  currentPracticeIndex = 0;
  showCurrentAnswer = false;
  renderPractice();
}

function goPrevPractice() {
  if (currentPracticeIndex > 0) {
    currentPracticeIndex--;
    showCurrentAnswer = false;
    renderPractice();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function goNextPractice() {
  const filtered = getFilteredPracticeUnits();
  if (currentPracticeIndex < filtered.length - 1) {
    currentPracticeIndex++;
    showCurrentAnswer = false;
    renderPractice();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

let draftSaveTimeout = null;
function onPracticeDraftInput(val) {
  const filtered = getFilteredPracticeUnits();
  const currentUnit = filtered[currentPracticeIndex];
  if (!currentUnit) return;

  const indicator = $('#draft-status-indicator');
  if (indicator) indicator.textContent = '保存中...';

  clearTimeout(draftSaveTimeout);
  draftSaveTimeout = setTimeout(() => {
    if (!state.drafts) state.drafts = {};
    state.drafts[currentUnit.id] = val;
    save();
    if (indicator) indicator.textContent = '已保存 ✓';
  }, 400);
}

function togglePracticeAnswer() {
  showCurrentAnswer = !showCurrentAnswer;
  const section = $('#practice-answer-section');
  const btn = $('.toggle-answer-btn');
  if (section) {
    section.style.display = showCurrentAnswer ? 'block' : 'none';
  }
  if (btn) {
    btn.textContent = showCurrentAnswer ? '收起参考答案' : '查看参考答案';
    btn.classList.toggle('active', showCurrentAnswer);
  }
}

function markPracticeSelfCheck(ok) {
  const filtered = getFilteredPracticeUnits();
  const currentUnit = filtered[currentPracticeIndex];
  if (!currentUnit) return;

  if (!state.selfChecks) state.selfChecks = {};
  const current = state.selfChecks[currentUnit.id];

  if (current && current.mastered === ok) {
    // Unmark
    delete state.selfChecks[currentUnit.id];
    toast('已取消标记');
  } else {
    state.selfChecks[currentUnit.id] = { mastered: ok, time: Date.now() };
    toast(ok ? '已标为已掌握 ✓' : '已标为需复习 ↺');
  }
  save();
  renderPractice();
}

function requestPracticeUnitAI() {
  const filtered = getFilteredPracticeUnits();
  const currentUnit = filtered[currentPracticeIndex];
  if (!currentUnit) return;

  ensureTeaching();
  const draft = state.drafts ? (state.drafts[currentUnit.id] || '') : '';
  state.teaching[currentUnit.id] = {
    unit: currentUnit,
    kind: currentUnit.kind,
    draft: draft,
    status: 'working'
  };

  toast('正在向 DeepSeek 请求当前题解...');
  requestTutor(currentUnit.id, { force: true });
}

// Backward compatibility export
window.renderPractice = renderPractice;
window.markPracticeSelfCheck = markPracticeSelfCheck;
