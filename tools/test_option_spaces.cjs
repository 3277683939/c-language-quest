'use strict';
// Guard against OCR joining identifiers whose separating space changes the answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.argv.slice(2).find(arg => arg !== '--browser') || path.join(root, 'overrides'));
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(directory, 'bank.js'), 'utf8'), context);
const question = context.window.QUESTION_BANK.questions.find(q => q.id === 'x-1-2');
assert.ok(question, 'identifier question x-1-2 exists');
assert.equal(question.options[2], 'a b', 'C must contain the source space: ab would also be a legal identifier');
assert.equal(question.answer, 'A', 'preserve the source answer');
console.log('PASS: x-1-2 preserves the meaningful space between a and b');

async function checkBrowser() {
  const http = require('node:http');
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { ({ chromium } = require('D:/npm-global/node_modules/playwright')); }
  const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'))).path;
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(build, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(build + path.sep)) { res.writeHead(403).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    fs.readFile(file, (error, bytes) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(bytes);
    });
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = process.env.TEST_BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    // Launch a fresh isolated browser; never attach to a real user profile.
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const width of [390, 430, 1200]) {
      const ctx = await browser.newContext({ viewport: { width, height: 844 } });
      try {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
        await page.goto(url + '#map');
        await page.waitForSelector('.chapters');
        await page.evaluate(() => practiceOne('x-1-2'));
        const option = page.locator('#quiz-dialog .option').nth(2);
        assert.equal(await option.locator('.option-text').textContent(), 'a□b');
        assert.equal(await option.locator('.option-space').getAttribute('aria-label'), '空格');
        assert.equal(await option.locator('.option-text').evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
        assert.equal(await page.locator('.option-space-note').textContent(), '□ 表示一个空格。');
        assert.equal(await page.evaluate(() => Q.find(q => q.id === 'x-1-2').options[2]), 'a b');
        await option.click();
        await page.locator('#submit-answer').click();
        await page.locator('[data-static-lesson][data-lesson-state="loaded"]').waitFor();
        assert.ok(await option.evaluate(el => el.classList.contains('incorrect')));
        assert.ok(await page.locator('#quiz-dialog .option').first().evaluate(el => el.classList.contains('correct')));
        assert.ok((await page.locator('.static-lesson').textContent()).includes('空格'));
        assert.equal(await option.locator('.option-text').textContent(), 'a□b');
        assert.equal(await page.locator('#quiz-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        fs.mkdirSync(path.join(root, '.question-import/qa'), { recursive: true });
        await page.screenshot({ path: path.join(root, `.question-import/qa/option-spaces-${width}.png`) });
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: visible space, accessible label, preserved source, grading and matching lesson`);
        const auditFile = path.join(root, 'question-imports/audits/option-whitespace-2026-11-04.json');
        if (fs.existsSync(auditFile)) {
          const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
          const failures = await page.evaluate(records => {
            const failures = [];
            for (const record of records) {
              practiceOne(record.questionId);
              const options = [...document.querySelectorAll('#quiz-dialog .option-text')];
              if (JSON.stringify(options.map(el => el.textContent)) !== JSON.stringify(record.options)) failures.push(record.questionId);
              if (options.some(el => getComputedStyle(el).whiteSpace !== 'pre-wrap')) failures.push(record.questionId + ': collapsed whitespace');
            }
            return failures;
          }, audit.corrections);
          assert.deepEqual(failures, [], 'all restored options reach the real quiz UI intact');
          for (const id of ['h-5-基础篇-23', 'x-8-24']) {
            await page.evaluate(id => practiceOne(id), id);
            if (id === 'h-5-基础篇-23') assert.equal(await page.locator('.question-stem > .practice-code').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(30, 41, 59)', 'code must be readable on a dark background');
            await page.screenshot({ path: path.join(root, `.question-import/qa/option-audit-${id === 'x-8-24' ? 'string' : 'multiline'}-${width}.png`) });
          }
          console.log(`PASS ${width}px: all ${audit.corrections.length} repaired questions preserve option spaces and line breaks`);
        }
      } finally { await ctx.close(); }
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
if (process.argv.includes('--browser')) checkBrowser().catch(error => { console.error(error); process.exitCode = 1; });
