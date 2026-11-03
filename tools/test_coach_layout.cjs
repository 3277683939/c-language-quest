'use strict';
// Layout fixtures run in a new, empty browser context; no user profiles or keys.
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
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = process.env.TEST_BASE_URL || `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [320, 360, 390, 430, 760, 820, 1200]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width <= 760, hasTouch: width <= 760 });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
        await page.goto(url + '#coach');
        await page.waitForSelector('.deepseek-settings');
        const geometry = await page.evaluate(() => {
          const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
          const settings = rect('.deepseek-settings');
          const guide = rect('.coach-guide');
          return { settings, guide, input: rect('#deepseek-key'), viewport: innerWidth, pageWidth: document.documentElement.scrollWidth };
        });
        console.log(`${width}px: settings=${Math.round(geometry.settings.width)}px, guideTop=${Math.round(geometry.guide.top)}, settingsBottom=${Math.round(geometry.settings.bottom)}`);
        assert.ok(geometry.settings.width >= Math.min(width - 50, 440), `${width}: form has useful reading width`);
        if (width <= 1100) assert.ok(geometry.guide.top >= geometry.settings.bottom, `${width}: guide must stack below settings`);
        assert.ok(geometry.input.width >= Math.min(width - 100, 320), `${width}: key input is usable`);
        assert.ok(geometry.pageWidth <= width, `${width}: no page overflow`);
        assert.ok(geometry.settings.height < 1100, `${width}: settings must not become a tall strip`);
        await page.locator('.ai-advanced summary').click();
        assert.ok(await page.locator('#ai-provider').isVisible());
        await page.locator('.ai-advanced summary').click();
        await page.evaluate(() => {
          const choices = Q.filter(q => /(?:^|\n)\s*(?:#include|int\s+|main\s*\(|void\s+main)/.test(q.stem)).slice(0, 3);
          for (const q of choices) state.teaching[q.id] = { id: q.id, kind: 'choice', status: 'pending', picked: ['A'] };
          const units = Array.isArray(window.PRACTICE_UNITS) ? window.PRACTICE_UNITS : window.PRACTICE_UNITS.units;
          const u = units.find(u => u.code && u.kind !== 'choice');
          state.teaching[u.id] = { id: u.id, kind: u.kind, status: 'pending' };
          renderCoach();
        });
        await page.waitForSelector('.agent-question');
        const cards = await page.locator('.agent-question').evaluateAll(els => els.map(el => ({ width: el.clientWidth, scroll: el.scrollWidth, options: el.querySelectorAll('.agent-option').length, code: el.querySelectorAll('pre code').length })));
        assert.equal(cards.length, 4);
        assert.ok(cards.every(c => c.scroll <= c.width + 1), `${width}: question card overflow`);
        assert.ok(cards[0].options >= 2, `${width}: choice options use readable rows`);
        assert.ok(cards[0].code > 0, `${width}: choice program is shown as code`);
        const codeStyle = await page.locator('.agent-question').first().locator('pre').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
        assert.notEqual(codeStyle.background, 'rgba(0, 0, 0, 0)', `${width}: code needs a readable background`);
        assert.notEqual(codeStyle.background, codeStyle.color, `${width}: code text must contrast with its background`);
        assert.ok(cards[3].code > 0, `${width}: practice program is visible`);
        await page.screenshot({ path: path.join(root, `.question-import/qa/coach-settings-${width}.png`) });
        await page.locator('.agent-question').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(root, `.question-import/qa/coach-question-${width}.png`) });
        await page.locator('.agent-question').last().getByRole('button', { name: '返回题目作答', exact: true }).click();
        await page.waitForSelector('#quiz-dialog[open] .practice-code');
        assert.deepEqual(errors, [], `${width}: no JavaScript runtime errors`);
        console.log(`PASS ${width}px: settings, guide, choices, code, practice navigation`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
