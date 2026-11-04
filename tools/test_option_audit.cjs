'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const dir = process.argv[2] || path.join(root, 'overrides');
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(dir, 'bank.js'), 'utf8'), ctx);
const rows = ctx.window.QUESTION_BANK.questions;
const audit = JSON.parse(fs.readFileSync(path.join(root, 'question-imports/audits/option-whitespace-2026-11-04.json'), 'utf8'));
assert.equal(rows.length, 1096);
for (const record of audit.corrections) {
  const q = rows.find(q => q.id === record.questionId);
  assert.ok(q, record.questionId);
  assert.equal(JSON.stringify(q.options), JSON.stringify(record.options), `${q.id}: must match visually verified source options`);
  assert.equal(q.answer, record.answer, `${q.id}: preserve source grading`);
}
console.log(`PASS: ${audit.corrections.length} source-verified option corrections, original question IDs retained`);
