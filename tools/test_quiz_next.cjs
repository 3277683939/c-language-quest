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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const width of [390,430,1200]) {
      const context = await browser.newContext({viewport:{width,height:844},isMobile:width<760,hasTouch:width<760});
      try {
        const page = await context.newPage(); const errors=[];
        page.on('pageerror',e => errors.push(e.message));
        await page.route('**/*',r => new URL(r.request().url()).origin===origin ? r.continue() : r.abort());
        await page.goto(origin+'/#map'); await page.locator('.chapters').waitFor();
        await page.evaluate(() => startQuiz([Q.find(q=>q.id==='n7-1'),Q.find(q=>q.id==='n7-2')],'下一题回归'));
        const option=page.locator('#quiz-dialog .option').nth(1);
        if(width<760) await option.tap(); else await option.click();
        await page.locator('#submit-answer').click();
        assert.deepEqual(errors,[], 'submitting a legacy numeric answer must not throw');
        const next=page.getByRole('button',{name:'下一题 →',exact:true});
        await next.waitFor();
        if(width<760) await next.tap(); else await next.click();
        assert.ok((await page.locator('#quiz-dialog .quiz-meta').innerText()).includes('02 / 02'));
        await page.locator('#quiz-dialog .option').nth(1).click();await page.locator('#submit-answer').click();
        await page.getByRole('button',{name:'查看本次成绩 →',exact:true}).click();
        assert.equal(await page.locator('.result-score').isVisible(),true);
        assert.deepEqual(errors,[]);
        console.log('PASS '+width+'px: tap answer, next, next answer and finish');
        if (width === 390) {
          assert.equal(await page.evaluate(() => QUESTION_BANK.questions.find(q => q.id === 'n7-1').answer), 1,
            'raw source data must remain unchanged');
          const total = await page.evaluate(() => {startQuiz(Q, '全库切换检查');return Q.length;});
          for (let offset = 0; offset < total; offset += 50) {
            const problems = await page.evaluate(count => {
              const problems = [];
              for (let i = 0; i < count && !quiz.finished; i++) {
                const id = currentQ()?.id;
                try {
                  for (const letter of currentQ().answer) choose(letter);
                  submitAnswer();
                  const before = quiz.index;
                  document.querySelector('.quiz-foot .primary').click();
                  if (!quiz.finished && quiz.index !== before + 1) problems.push({id,error:'index unchanged'});
                } catch (error) {problems.push({id,error:error.message});break;}
              }
              return problems;
            }, Math.min(50,total-offset));
            assert.deepEqual(problems,[], 'every choice must submit and advance');
          }
          assert.equal(await page.evaluate(() => quiz.finished),true);
          assert.deepEqual(errors,[]);
          console.log('PASS all '+total+' choices: answer, feedback, next and final result without JS errors');
        }
      } finally {await context.close();}
    }
  } finally {await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
