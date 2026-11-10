/* Public, prewritten lessons. No credentials, paid calls or learner data. */
(() => {
  'use strict';
  const base = new URL('static-lessons/', document.currentScript?.src || location.href);
  const manifestFile = '__LESSON_MANIFEST_VERSION__.json';
  const coverage = Object.freeze(__LESSON_COVERAGE__);
  const chunks = new Map();
  let manifestPromise;
  async function read(file) {
    if (!/^[a-f0-9]{20}\.json$/.test(file)) throw Error('讲解文件地址无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(new URL(file, base), { signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw Error('讲解暂时无法加载');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  async function get(id) {
    if (!manifestPromise) manifestPromise = read(manifestFile).catch(error => { manifestPromise = null; throw error; });
    const manifest = await manifestPromise;
    const name = manifest.index?.[id];
    if (!name) return null;
    if (!chunks.has(name)) chunks.set(name, read(name).catch(error => { chunks.delete(name); throw error; }));
    const chunk = await chunks.get(name);
    return chunk[id] || null;
  }
  function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  // 讲解里的 C 代码按代码块排版：保留换行/缩进/等宽字体，关键字轻微着色，窄屏内部横向滚动。
  const KEYWORDS = new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool bool true false NULL'.split(' '));
  const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|^[ \t]*#[ \t]*[A-Za-z_]+|\b(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?[fFuUlL]*)\b|\b[A-Za-z_]\w*\b)/gm;
  function codeNode(text) {
    const pre = node('pre', '', 'static-lesson-code');
    const code = document.createElement('code');
    let last = 0;
    TOKEN.lastIndex = 0;
    let match;
    while ((match = TOKEN.exec(text))) {
      if (match.index > last) code.append(document.createTextNode(text.slice(last, match.index)));
      const token = match[0];
      const span = document.createElement('span');
      span.textContent = token;
      if (token.startsWith('//') || token.startsWith('/*')) span.className = 'tok-com';
      else if (token.startsWith('"') || token.startsWith("'")) span.className = 'tok-str';
      else if (/^[ \t]*#/.test(token)) span.className = 'tok-pp';
      else if (/^\d|^0[xX]/.test(token)) span.className = 'tok-num';
      else if (KEYWORDS.has(token)) span.className = 'tok-kw';
      code.append(span);
      last = match.index + token.length;
    }
    if (last < text.length) code.append(document.createTextNode(text.slice(last)));
    pre.append(code);
    return pre;
  }
  const CODE_LINE = /^(?:\s*(?:#[ \t]*(?:include|define|if|ifdef|ifndef|else|elif|endif|pragma|undef)\b|(?:int|void|char|float|double|long|short|unsigned|signed|const|static|struct|typedef|union|enum|register|volatile)\s+[A-Za-z_]|int\s+main|void\s+main|main\s*\(|for\s*\(|while\s*\(|do\s*\{|if\s*\(|else\b|switch\s*\(|case\s|default\s*:|break\s*;|continue\s*;|return\b|printf\s*\(|scanf\s*\(|puts\s*\(|gets\s*\(|putchar\s*\(|getchar\s*\(|\}|\{|[A-Za-z_]\w*(?:\[[^\]]*\])*\s*=[^=]|[A-Za-z_]\w*\+\+|--[A-Za-z_]))/;
  function appendMixed(parent, text) {
    const lines = text.split('\n');
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const body = buffer.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
      if (body.trim()) parent.append(node('div', body, 'static-lesson-prose'));
      buffer = [];
    };
    let index = 0;
    while (index < lines.length) {
      if (CODE_LINE.test(lines[index])) {
        let end = index;
        let blanks = 0;
        while (end < lines.length) {
          if (CODE_LINE.test(lines[end])) { blanks = 0; end++; continue; }
          if (!lines[end].trim() && blanks < 1) { blanks++; end++; continue; }
          break;
        }
        while (end > index && !lines[end - 1].trim()) end--;
        if (end - index >= 3) {
          flush();
          parent.append(codeNode(lines.slice(index, end).join('\n')));
          index = end;
          continue;
        }
      }
      buffer.push(lines[index]);
      index++;
    }
    flush();
  }
  function appendRich(parent, text) {
    const value = String(text || '');
    const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let match;
    while ((match = fence.exec(value))) {
      if (match.index > last) appendMixed(parent, value.slice(last, match.index));
      const code = match[2].replace(/\n$/, '');
      if (code.trim()) parent.append(codeNode(code));
      last = match.index + match[0].length;
    }
    if (last < value.length) appendMixed(parent, value.slice(last));
  }
  async function load(el) {
    if (el.dataset.lessonState) return;
    el.dataset.lessonState = 'loading';
    el.replaceChildren(node('p', '正在加载逐题讲解…', 'save-note'));
    try {
      const lesson = await get(el.dataset.staticLesson);
      if (!el.isConnected) return;
      if (!lesson) {
        el.replaceChildren(node('p', '这道题的预写讲解尚未补齐，当前可先对照参考答案。', 'save-note'));
        el.dataset.lessonState = 'missing';
        return;
      }
      el.replaceChildren(node('h3', '逐题讲解'));
      el.append(node('p', lesson.origin + (lesson.answerReview ? ' · 讲解内注明核验方式' : ''), 'save-note'));
      appendRich(el, lesson.explanation);
      if (lesson.steps?.length) {
        const list = node('ol', '', 'static-lesson-steps');
        lesson.steps.forEach(step => {
          const item = document.createElement('li');
          appendRich(item, step);
          list.append(item);
        });
        el.append(list);
      }
      if (lesson.answerReview && lesson.answerReview.status !== 'consistent') {
        const review = node('div', '', 'static-lesson-review');
        review.append(node('strong', '资料答案核对意见'));
        review.append(node('p', lesson.answerReview.answer));
        review.append(node('p', lesson.answerReview.reason));
        review.append(node('small', '此核对意见不改变原有判分答案。'));
        el.append(review);
      }
      if (lesson.takeaway) el.append(node('p', '记住这一点：' + lesson.takeaway, 'takeaway'));
      el.dataset.lessonState = 'loaded';
    } catch {
      if (!el.isConnected) return;
      el.replaceChildren(node('p', '讲解加载失败，可以重试。参考答案仍可正常查看。', 'save-note'));
      const retry = node('button', '重新加载讲解', 'secondary');
      retry.type = 'button';
      retry.onclick = () => { delete el.dataset.lessonState; load(el); };
      el.append(retry);
      el.dataset.lessonState = 'error';
    }
  }
  function mount() {
    setTimeout(() => document.querySelectorAll('[data-static-lesson]').forEach(el => {
      if (el.getClientRects().length) load(el);
    }), 0);
  }
  function html(id) {
    const safe = String(id).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<section class="static-lesson" data-static-lesson="${safe}" aria-live="polite"></section>`;
  }
  window.CQuestLessons = Object.freeze({ get, mount, html, coverage });
})();
