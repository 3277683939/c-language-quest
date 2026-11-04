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
      el.append(node('p', lesson.origin + (lesson.answerReview ? ' · 尚未执行程序验证' : ''), 'save-note'));
      el.append(node('div', lesson.explanation, 'static-lesson-prose'));
      if (lesson.steps?.length) {
        const list = node('ol', '', 'static-lesson-steps');
        lesson.steps.forEach(step => list.append(node('li', step)));
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
