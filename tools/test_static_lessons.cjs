'use strict';
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
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(data);
  });
});
async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = process.env.TEST_BASE_URL || `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1200]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      try {
        const page = await context.newPage();
        let requests = 0, paidRequests = 0, shouldFail = true;
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
          const requested = new URL(route.request().url());
          if (requested.hostname === 'api.deepseek.com') paidRequests++;
          if (requested.origin !== new URL(url).origin) return route.abort();
          if (requested.pathname.includes('/static-lessons/')) {
            requests++;
            if (shouldFail) { shouldFail = false; return route.fulfill({ status: 503, body: 'test failure' }); }
          }
          return route.continue();
        });
        await page.goto(url + '#map');
        await page.waitForSelector('.chapters');
        assert.equal(requests, 0, 'no lesson downloads during startup');
        const answer = await page.evaluate(() => {
          const q = Q.find(q => q.id === 'h-1-综合拓展篇-1');
          practiceOne(q.id);
          return q.answer;
        });
        assert.equal(requests, 0, 'no lesson spoilers or downloads before submission');
        for (const letter of answer) await page.locator('#quiz-dialog .option').filter({ has: page.locator('.letter', { hasText: letter }) }).click();
        await page.locator('#submit-answer').click();
        await page.getByRole('button', { name: '重新加载讲解', exact: true }).waitFor();
        assert.equal(requests, 1, 'failed load does not auto-retry');
        await page.getByRole('button', { name: '重新加载讲解', exact: true }).click();
        await page.locator('[data-static-lesson][data-lesson-state="loaded"]').waitFor();
        const text = await page.locator('.static-lesson').textContent();
        assert.ok(text.includes('逐题讲解') && text.includes('&'), 'concrete lesson visible even after a correct answer');
        const loadedRequests = requests;
        await page.evaluate(() => renderQuiz());
        await page.locator('[data-static-lesson][data-lesson-state="loaded"]').waitFor();
        assert.equal(requests, loadedRequests, 're-render reuses cached public lesson');
        await page.locator('.static-lesson').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(root, `.question-import/qa/static-choice-${width}.png`) });
        await page.locator('#quiz-dialog [aria-label="保存并关闭练习"]').click();
        await page.evaluate(() => practiceOneUnit('self:h:1:基础篇:填空题:1'));
        assert.equal(requests, loadedRequests, 'hidden practice answer makes no request');
        await page.getByRole('button', { name: '查看参考答案', exact: true }).click();
        await page.locator('[data-static-lesson][data-lesson-state="loaded"]').waitFor();
        assert.ok((await page.locator('.static-lesson').textContent()).includes('main'));
        await page.locator('.static-lesson').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(root, `.question-import/qa/static-practice-${width}.png`) });
        assert.equal(paidRequests, 0, 'viewing prewritten lessons makes zero model API calls');
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: correct-answer lesson, no key/API, deferred loading, explicit retry, caching, practice lesson`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
