/* Additive import adapter. Existing question IDs and browser storage stay intact. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const data = window.CQUEST_IMPORTED_DATA || {sources: [], questions: [], units: [], lessons: {}};
  const bank = window.QUESTION_BANK;
  const practice = window.PRACTICE_UNITS;
  const units = Array.isArray(practice) ? practice : practice.units;
  const seen = new Set([...bank.questions, ...units].map(q => q.id));
  for (const source of data.sources) {
    if (!bank.materials.some(m => m.id === source.id)) bank.materials.push(source);
  }
  for (const [rows, target] of [[data.questions, bank.questions], [data.units, units]]) {
    for (const q of rows) {
      // Re-executing this adapter must not append a second copy. The publisher
      // checks conflicting IDs before this script ever reaches the website.
      if (seen.has(q.id)) continue;
      seen.add(q.id);
      target.push(q);
    }
  }
  for (const q of [...bank.questions, ...units]) {
    const lesson = data.lessons[q.id];
    if (lesson) {
      q.aiAnswer = lesson.answer;
      q.aiExplanation = lesson.explanation;
      q.aiModel = lesson.model;
      q.aiVerification = 'AI生成，未执行程序验证';
    }
  }
  if (!Array.isArray(practice)) practice.total = units.length;
  window.getImportedAIHTML = q => q.aiExplanation ? `<section class="practice-ai-card"><strong>✦ AI生成的参考答案与讲解</strong><p class="save-note">${escape(q.aiModel || 'DeepSeek')} · 未执行程序验证，请结合题干核对</p>${q.aiAnswer ? `<pre class="answer-pre"><code>${escape(q.aiAnswer)}</code></pre>` : ''}<div style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(q.aiExplanation)}</div></section>` : '';
})();
