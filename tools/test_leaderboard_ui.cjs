'use strict';
// Isolated browser contexts only; no real signup, account changes, or paid calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let chromium;
try { ({chromium} = require('playwright')); } catch { ({chromium} = require('D:/npm-global/node_modules/playwright')); }
const root = path.resolve(__dirname, '..');
const build = JSON.parse(fs.readFileSync(path.join(root, '.question-import/preview-location.json'))).path;
const server = http.createServer((req,res) => {
  const file = path.resolve(build, '.' + (new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(new URL(req.url,'http://localhost').pathname)));
  if (!file.startsWith(build+path.sep)) return res.writeHead(403).end();
  fs.readFile(file,(err,data) => { if(err) return res.writeHead(404).end(); res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)] || 'application/octet-stream'); res.end(data); });
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({channel:'msedge',headless:true});
    for (const width of [390,430,1200]) {
      const context = await browser.newContext({viewport:{width,height:844}});
      try {
        const page = await context.newPage(); const errors=[]; const rpc=[];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*',route => { if(route.request().url().includes('/cquest_rank_')) rpc.push(route.request().url()); return new URL(route.request().url()).origin === origin ? route.continue() : route.abort(); });
        await page.goto(origin+'/#map'); await page.locator('.chapters').waitFor();
        assert.equal(rpc.length,0,'leaderboard must not fetch at startup');
        await page.evaluate(() => {
          window.rankTest = {auth:{configured:true,loggedIn:false,pendingMerge:false},profile:{joined:false,nickname:''},rows:[],calls:[],mode:'ok'};
          CQuestAccount.leaderboardSession=()=>({...rankTest.auth});
          CQuestAccount.leaderboardRpc=async(action,params={})=>{
            rankTest.calls.push({action,params});
            if(rankTest.mode==='fail') throw new Error('排行榜暂时无法连接，请稍后重试。');
            if(rankTest.mode==='delay') await new Promise(resolve=>rankTest.resolve=resolve);
            if(action==='join') {rankTest.profile={joined:true,nickname:params.nickname};rankTest.rows=[{rank:1,nickname:params.nickname,solved:12,mine:true}];}
            if(action==='leave') {rankTest.profile={joined:false,nickname:''};rankTest.rows=[];}
            return action==='list' ? structuredClone(rankTest.rows) : {...rankTest.profile};
          };
          location.hash='leaderboard';
        });
        await page.locator('.rank-empty').waitFor();
        assert.equal(await page.locator('#rank-profile a').getAttribute('href'),'#account');
        if(width<760) {
          await page.evaluate(()=>openMoreNavigation());
          await page.locator('#more-dialog a[href="#leaderboard"]').click();
          assert.equal(await page.locator('#more-dialog').evaluate(el=>el.open),false);
        }
        await page.evaluate(()=>{ rankTest.rows=[{rank:1,nickname:'<img src=x onerror=alert(1)>',solved:25,mine:false}]; });
        await page.locator('#rank-refresh').click(); await page.locator('.rank-row').waitFor();
        assert.equal(await page.locator('.rank-name img').count(),0,'nickname cannot inject markup');
        await page.evaluate(()=>{ rankTest.auth.loggedIn=true;window.dispatchEvent(new CustomEvent('cquest:account-status')); });
        await page.locator('#rank-form').waitFor();
        assert.equal(await page.locator('#rank-save').isDisabled(),true);
        await page.locator('#rank-nickname').fill('认真学C'); await page.locator('#rank-consent').check();
        await page.locator('#rank-save').click(); await page.locator('.rank-mine').waitFor();
        assert.equal(await page.locator('.rank-name').innerText(),'认真学C我');
        assert.deepEqual(await page.evaluate(()=>rankTest.calls.find(c=>c.action==='join').params),{nickname:'认真学C'});
        await page.locator('#rank-nickname').fill('新昵称'); await page.locator('#rank-consent').check(); await page.locator('#rank-save').click();
        await page.waitForFunction(()=>document.querySelector('.rank-name')?.textContent==='新昵称我');
        await page.locator('#rank-leave').click(); await page.locator('.rank-empty').waitFor();
        assert.match(await page.locator('#rank-message').innerText(),/存档已保留/);
        await page.evaluate(()=>rankTest.mode='fail'); await page.locator('#rank-refresh').click(); await page.locator('#rank-retry').waitFor();
        await page.evaluate(()=>rankTest.mode='ok'); await page.locator('#rank-retry').click(); await page.locator('.rank-empty').waitFor();
        // A profile response from the old account cannot reinsert its nickname after logout.
        await page.evaluate(()=>{rankTest.mode='delay';rankTest.profile={joined:true,nickname:'OLD_PRIVATE_NAME'};CQuestLeaderboard.render();});
        await page.waitForFunction(()=>typeof rankTest.resolve==='function');
        await page.evaluate(()=>{const release=rankTest.resolve;rankTest.mode='ok';rankTest.auth.loggedIn=false;window.dispatchEvent(new CustomEvent('cquest:account-status'));release();});
        await page.locator('#rank-profile a').waitFor();
        assert.ok(!(await page.locator('#rank-profile').innerText()).includes('OLD_PRIVATE_NAME'));
        await page.evaluate(()=>{rankTest.rows=[{rank:1,nickname:'每日进步一点',solved:128,mine:false},{rank:2,nickname:'C语言学习者',solved:96,mine:false},{rank:2,nickname:'一起学C',solved:96,mine:false}];});
        await page.locator('#rank-refresh').click(); await page.locator('.rank-row').first().waitFor();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'no horizontal overflow');
        await page.locator('.rank-rules').scrollIntoViewIfNeeded(); assert.equal(await page.locator('.rank-rules').isVisible(),true);
        await page.evaluate(()=>scrollTo(0,0));
        fs.mkdirSync(path.join(root,'.question-import/qa'),{recursive:true});
        await page.screenshot({path:path.join(root,`.question-import/qa/leaderboard-${width}.png`),fullPage:true});
        assert.deepEqual(errors,[]);
        console.log(`PASS ${width}px: guest/empty/list, consent, join/edit/leave, retry, stale logout, escaping and mobile layout (mock RPC)`);
      } finally {await context.close();}
    }
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(err=>{console.error(err);process.exitCode=1;});
