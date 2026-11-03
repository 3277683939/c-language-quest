'use strict';
// Fresh browser and contexts only; never connect to a user's browser/profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('D:/npm-global/node_modules/playwright')); }
const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'))).path;
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(build, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(build + path.sep)) { res.writeHead(403).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = process.env.TEST_BASE_URL || `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 430, 760, 820, 1200]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width <= 760, hasTouch: width <= 760 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      // No external API calls or real accounts in a layout test.
      await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
      try {
        await page.goto(url + '#map');
        await page.waitForSelector('.chapters');
        assert.equal(await page.locator('#quiz-dialog').isVisible(), false, `${width}: closed dialog must be hidden`);
        if (width <= 760) {
          const chapters = page.locator('.chapters');
          await chapters.scrollIntoViewIfNeeded();
          const rect = await chapters.boundingBox();
          await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.mouse.wheel(100000, 0);
          await page.waitForFunction(() => document.querySelector('.chapters').scrollLeft > 0);
          await page.locator('.chapter').last().click();
          assert.ok((await page.locator('.chapter-head h3').textContent()).includes('11'));
          const scroll = await chapters.evaluate(el => el.scrollLeft);
          assert.ok(scroll > 0, `${width}: selecting chapter 11 preserves horizontal position`);
          await page.mouse.wheel(-100000, 0);
          await page.locator('.chapter').first().click();
        }
        const result = await page.evaluate(() => {
          const units = Array.isArray(window.PRACTICE_UNITS) ? window.PRACTICE_UNITS : window.PRACTICE_UNITS.units;
          const unit = units.filter(u => u.code && u.answer).sort((a, b) => b.code.length - a.code.length)[0];
          startPracticeLevel({ id: 'layout-fixture', title: '程序题排版测试', questions: [unit, unit] });
          return { id: unit.id, code: unit.code };
        });
        await page.waitForSelector('#quiz-dialog[open] .practice-code');
        assert.equal(await page.locator('#quiz-dialog .practice-code code').first().textContent(), result.code, `${width}: visible C code preserves source`);
        const geometry = await page.evaluate(() => {
          const d = document.querySelector('#quiz-dialog');
          const b = d.querySelector('.quiz-body');
          const foot = d.querySelector('.quiz-foot').getBoundingClientRect();
          return { height: d.getBoundingClientRect().height, vh: innerHeight, bodyHeight: b.clientHeight, scrollHeight: b.scrollHeight, footBottom: foot.bottom, overflow: d.scrollWidth > d.clientWidth + 1 };
        });
        assert.ok(geometry.height <= geometry.vh + 1, `${width}: dialog fits viewport`);
        assert.ok(geometry.bodyHeight > 80 && geometry.scrollHeight > geometry.bodyHeight, `${width}: long quiz body has a scroll range`);
        assert.ok(geometry.footBottom <= geometry.vh + 1, `${width}: next button stays on screen`);
        assert.equal(geometry.overflow, false, `${width}: no horizontal dialog overflow`);
        await page.screenshot({ path: path.join(root, `.question-import/qa/quiz-verified-${width}.png`) });
        const box = await page.locator('#quiz-dialog .quiz-body').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 100000);
        await page.waitForFunction(() => document.querySelector('#quiz-dialog .quiz-body').scrollTop > 0);
        await page.getByRole('button', { name: '查看参考答案', exact: true }).click();
        assert.ok(await page.locator('#practice-quiz-answer-section').isVisible());
        await page.getByRole('button', { name: '下一题 →', exact: true }).click();
        assert.ok((await page.locator('#quiz-dialog .quiz-meta').textContent()).includes('02 / 02'));
        await page.locator('#quiz-dialog [aria-label="保存并关闭"]').click();
        assert.equal(await page.locator('#quiz-dialog').isVisible(), false, `${width}: close releases page`);
        // Exercise actual choice submission too.
        await page.locator('.level').first().click();
        await page.locator('#quiz-dialog .option').first().click();
        await page.locator('#submit-answer').click();
        await page.waitForSelector('#quiz-dialog .feedback');
        await page.locator('#quiz-dialog [aria-label="保存并关闭练习"]').click();
        assert.equal(await page.locator('#quiz-dialog').isVisible(), false);
        await page.goto(url + '#practice');
        await page.waitForSelector('.practice-card');
        assert.equal(await page.locator('#quiz-dialog').isVisible(), false);
        await page.getByRole('button', { name: '查看参考答案', exact: true }).click();
        assert.ok(await page.locator('#practice-answer-section').isVisible());
        await page.screenshot({ path: path.join(root, `.question-import/qa/practice-verified-${width}.png`) });
        assert.deepEqual(errors, [], `${width}: no runtime JS errors`);
        console.log(`PASS ${width}px: closed/open/scroll/answer/next/close, choice submission, practice page`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
