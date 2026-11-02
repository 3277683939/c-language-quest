'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = process.argv[2];
const context = vm.createContext({window: {}});
for (const name of ['bank.js', 'practice-units.js', 'explanations.js', 'quality.js', 'imported-data.js', 'imports.js']) {
  new vm.Script(fs.readFileSync(path.join(root, name), 'utf8'), {filename: name}).runInContext(context);
}
const bank = context.window.QUESTION_BANK;
const units = context.window.PRACTICE_UNITS.units;
const rows = [...bank.questions, ...units];
new vm.Script(fs.readFileSync(path.join(root, 'imports.js'), 'utf8')).runInContext(context);
assert.equal(bank.questions.length + units.length, rows.length, '重复加载导入脚本导致重复题目');
assert.ok(context.window.getImportedAIHTML({aiAnswer:'<script>',aiExplanation:'<img src=x onerror=alert(1)>'}).includes('&lt;img'), 'AI内容未正确转义');
assert.equal(new Set(rows.map(q => q.id)).size, rows.length, '全题库ID有冲突');
for (const q of context.window.CQUEST_IMPORTED_DATA.questions) {
  assert.ok(q.stem && q.options.length >= 2 && /^[A-H]+$/.test(q.answer));
  assert.ok(!q.reviewPending, '待核对题不能自动判分');
}
assert.equal(units.length, context.window.PRACTICE_UNITS.total);
// Browser controller builds its map directly from the merged data.
assert.ok(bank.questions.some(q => q.source === 'x' && q.chapter === 12), '贤彬第12章题目丢失');
// Exercise the actual controller with a tiny DOM/storage fixture. No network/API key.
const importedHistory = 'import:u0123456789ab:0123456789abcdef0123';
const legacyId = bank.questions[0].id;
const elements = new Map();
const element = selector => {
  if (!elements.has(selector)) elements.set(selector, {innerHTML: '', textContent: '', value: '', open: false, addEventListener() {}, insertAdjacentHTML() {}, classList: {toggle() {}, add() {}, remove() {}}});
  return elements.get(selector);
};
Object.assign(context, {
  location: {hash: '#map'},
  localStorage: {getItem() {return JSON.stringify({version: 1, wrong: [legacyId, importedHistory], favorites: [legacyId, importedHistory], drafts: {[importedHistory]: '保存的草稿'}, levels: {'h-1-0': {passed: true, stars: 3}}});}, setItem() {}},
  document: {querySelector: element, querySelectorAll() {return [];}, addEventListener() {}},
  renderCoach() {}, renderPractice() {},
});
context.window.addEventListener = () => {};
new vm.Script(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {filename: 'app.js'}).runInContext(context);
assert.ok(vm.runInContext('state.favorites.includes(' + JSON.stringify(importedHistory) + ')', context), '撤销导入后收藏被删除');
assert.ok(vm.runInContext('state.wrong.includes(' + JSON.stringify(importedHistory) + ')', context), '撤销导入后错题记录被删除');
assert.equal(vm.runInContext('state.drafts[' + JSON.stringify(importedHistory) + ']', context), '保存的草稿');
assert.ok(vm.runInContext('allLevels().some(l=>l.id==="h-1-0")', context), '旧关卡ID被改变');
for (const q of [...context.window.CQUEST_IMPORTED_DATA.questions, ...context.window.CQUEST_IMPORTED_DATA.units]) {
  context.__testSource = q.source;
  context.__testChapter = q.chapter;
  assert.ok(vm.runInContext('getSourceChapters(__testSource).some(c=>c.chapter===__testChapter)', context), '新增来源或章节未进入地图');
}
console.log(`实际发布数据验证通过：选择 ${bank.questions.length}，自练 ${units.length}。`);
