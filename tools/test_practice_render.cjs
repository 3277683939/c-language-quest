'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(root, 'overrides/practice.js'), 'utf8'), ctx);
const api = ctx.window;
const decode = html => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const codeText = html => [...html.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => decode(m[1])).join('');
let count = 0;
function check(name, fn) { fn(); console.log('PASS ' + name); count++; }
check('C code round trip: strings, comments, replacement tokens and FOUND', () => {
  const code = '#include <stdio.h>\nint main(void) {\n  char *s = "https://example.com /* text */ ___TOK_0___";\n  /**********FOUND**********/\n  printf("$& %s", s); /* 中文注释 */\n  return 0;\n}\n/* 保留末尾中文注释 */\n';
  assert.equal(codeText(api.renderCodeBlock(code)), code);
});
check('Stem preserves figures, punctuation, decimal numbers and blank lengths', () => {
  const stem = '图 2.1 链表结构\n【功能要求】\n输入 1.5 与 2.75；（1）保留标点；（2）填写 ___ 和 ________。';
  const rendered = decode(api.formatPracticeStem(stem));
  assert.equal(rendered.replace(/\s/g, ''), stem.replace(/\s/g, ''));
});
check('Answer formatting preserves multiline numbered C output', () => {
  const answer = '1). if (a > 0) {\n  printf("a\\nb");\n}\n2). return 0;';
  assert.equal(decode(api.renderPracticeAnswer(answer)).replace(/\s/g, ''), answer.replace(/\s/g, ''));
  assert.ok(api.renderPracticeAnswer(answer).includes('\n'), 'keep code line breaks');
});
check('Untrusted source text is escaped', () => {
  for (const render of [api.formatPracticeStem, api.renderCodeBlock, api.renderPracticeAnswer]) {
    const html = render('<img src=x onerror=alert(1)> & "hello"');
    assert.ok(!html.includes('<img'));
    assert.ok(decode(html).includes('<img src=x onerror=alert(1)>'));
  }
});
vm.runInContext(fs.readFileSync(path.join(root, 'overrides/practice-units.js'), 'utf8'), ctx);
const units = Array.isArray(ctx.window.PRACTICE_UNITS) ? ctx.window.PRACTICE_UNITS : ctx.window.PRACTICE_UNITS.units;
check('All imported stems, code and answers survive rendering', () => {
  for (const u of units) {
    assert.equal(decode(api.formatPracticeStem(u.stem)).replace(/\s/g, ''), String(u.stem || '').replace(/\s/g, ''), u.id + ' stem');
    if (u.code) assert.equal(codeText(api.renderCodeBlock(u.code)), u.code, u.id + ' code');
    if (u.answer) assert.equal(codeText(api.renderPracticeAnswer(u.answer)), u.answer, u.id + ' answer');
  }
});
console.log(`${count} checks passed; ${units.length} real practice items verified.`);
