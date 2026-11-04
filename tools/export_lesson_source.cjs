'use strict';
// Execute only the repository's own data adapters in an empty VM.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const directory = path.resolve(process.argv[2]);
const ctx = vm.createContext({ window: {} });
for (const name of ['bank.js', 'practice-units.js', 'explanations.js', 'quality.js', 'imported-data.js', 'imports.js']) {
  const file = path.join(directory, name);
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 10000 });
}
const reviewed = vm.runInContext('typeof reviewedExplanations === "undefined" ? {} : reviewedExplanations', ctx);
const choices = ctx.window.QUESTION_BANK.questions.map(q => ({ ...q, kind: '选择题' }));
const practice = ctx.window.PRACTICE_UNITS;
const units = Array.isArray(practice) ? practice : practice.units;
const rows = [...choices, ...units].map(q => {
  const row = { id: q.id, kind: q.kind, stem: q.stem, code: q.code || '', options: q.options || [], answer: q.answer || '', originalAnswer: q.originalAnswer || '', qualityNote: q.qualityNote || '', reviewPending: !!q.reviewPending, ocrPending: !!q.ocrPending, warnings: q.warnings || [] };
  const ordered = Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]));
  row.sourceHash = crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  return { ...row, chapter: q.chapter, chapterName: q.chapterName || '', source: q.source, reviewedExplanation: reviewed[q.id] || '' };
});
process.stdout.write(JSON.stringify(rows));
