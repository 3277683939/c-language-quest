'use strict';

/**
 * 域 3（注册登录与云存档）韧性回归测试
 *
 * 覆盖：
 *  A. 游客本机保存 / 刷新恢复 / 不触发云端请求
 *  B. 登录错误分类（账号密码错、邮箱未验证、5xx、429、断网、超时）文案互不相同、输入保留、无自动重试
 *  C. 注册错误分类（断网、超时、发信限流、邮箱未授权）
 *  D. 防重复：登录/注册/同步 双击与并发点击只发一次请求，在途按钮禁用
 *  E. 断网答题 → 本机保存 → 刷新 → 手动重试 → 网络恢复单次同步（不循环）
 *  F. 首屏/做题不被挂起的云端请求阻塞
 *  G. 多设备 409 冲突重试有界（≤4 次）且本机进度不丢
 *  H. 退出登录清 token 但保留本机进度，并提示未同步
 *  I. emailCodeEnabled 默认关闭：无验证码区块、handleEmailCode 不发出任何请求
 *
 * 约束：
 *  - 所有 supabase 请求用 Playwright route stub 拦截，绝不真实注册/发信/调用云端；
 *  - 不记录邮箱完整值之外的敏感信息，不写密码/Token 到任何产物；
 *  - 覆盖 390（手机）与 1200（桌面）两个视口。
 *
 * 运行：node tools/test_account_resilience.cjs
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  playwright = require('D:/npm-global/node_modules/playwright');
}

const ROOT = path.resolve(__dirname, '..');
const PREVIEW_LOCATION = path.join(ROOT, '.question-import', 'preview-location.json');
const BUILD = JSON.parse(fs.readFileSync(PREVIEW_LOCATION, 'utf8')).path;
const APP_URL = pathToFileURL(path.join(BUILD, 'index.html')).href;
const SUPABASE_GLOB = '**/*supabase.co/**';
const SESSION_KEY = 'cquest_auth_session_rhfuhksreqlbniwskqgr';
const USER_KEY = 'c-quest-progress_rhfuhksreqlbniwskqgr_u_11111111-1111-4111-8111-111111111111';
const UID = '11111111-1111-4111-8111-111111111111';
const USER = { id: UID, email: 'student@example.com' };
const LOGIN_EMAIL = 'student@example.com';
const LOGIN_PASSWORD = 'secret123';

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '1200', width: 1200, height: 800, mobile: false }
];

let passCount = 0;
let failCount = 0;
const failures = [];

function check(cond, label, detail) {
  if (cond) {
    passCount++;
    console.log('  PASS  ' + label);
  } else {
    failCount++;
    const extra = detail === undefined ? '' : '  [' + detail + ']';
    failures.push(label + extra);
    console.log('  FAIL  ' + label + extra);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function poll(fn, predicate, timeout = 10000, interval = 100) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch (e) {
      last = { error: String(e && e.message ? e.message : e) };
    }
    if (predicate(last)) return last;
    if (Date.now() - start > timeout) {
      throw new Error('等待超时，最后状态：' + JSON.stringify(last));
    }
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ */
/* Supabase route stub：所有请求都走这里，按场景返回不同响应           */
/* ------------------------------------------------------------------ */

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  });
}

function createStub(overrides = {}) {
  const state = Object.assign({
    offline: false,
    delay: 0,
    token: null, // (route) => Promise
    signup: null,
    verify: null,
    resend: null,
    getProgress: null,
    save: null,
    revision: 1
  }, overrides);
  state.counts = { token: 0, signup: 0, verify: 0, resend: 0, getProgress: 0, save: 0, user: 0, logout: 0, other: 0 };
  state.requests = [];

  const handler = async (route) => {
    const url = route.request().url();
    const pathPart = url.replace(/^https:\/\/[^/]+/, '');
    state.requests.push(pathPart);
    try {
      if (route.request().method() === 'OPTIONS') {
        return await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': '*',
            'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS'
          }
        });
      }
      if (state.offline) {
        return await route.abort('internetdisconnected');
      }
      if (state.delay > 0) {
        await sleep(state.delay);
      }
      if (pathPart.indexOf('/auth/v1/user') === 0) {
        state.counts.user++;
        return await json(route, 200, USER);
      }
      if (pathPart.indexOf('/auth/v1/logout') === 0) {
        state.counts.logout++;
        return await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (pathPart.indexOf('/auth/v1/token') === 0) {
        state.counts.token++;
        if (state.token) return await state.token(route, state);
        return await json(route, 200, {
          access_token: 'test-token',
          refresh_token: 'test-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          user: USER
        });
      }
      if (pathPart.indexOf('/auth/v1/signup') === 0) {
        state.counts.signup++;
        if (state.signup) return await state.signup(route, state);
        return await json(route, 200, { id: UID, email: USER.email, confirmation_sent_at: new Date().toISOString() });
      }
      if (pathPart.indexOf('/auth/v1/verify') === 0) {
        state.counts.verify++;
        if (state.verify) return await state.verify(route, state);
        return await json(route, 200, { access_token: 'verified-token', user: USER });
      }
      if (pathPart.indexOf('/auth/v1/resend') === 0) {
        state.counts.resend++;
        if (state.resend) return await state.resend(route, state);
        return await json(route, 200, {});
      }
      if (pathPart.indexOf('/auth/v1/health') === 0) {
        return await json(route, 200, { name: 'GoTrue' });
      }
      if (pathPart.indexOf('/rest/v1/cquest_progress') === 0) {
        state.counts.getProgress++;
        if (state.getProgress) return await state.getProgress(route, state);
        return await json(route, 200, []);
      }
      if (pathPart.indexOf('/rest/v1/rpc/cquest_save_progress') === 0) {
        state.counts.save++;
        if (state.save) return await state.save(route, state);
        return await json(route, 200, [{ revision: state.revision }]);
      }
      if (pathPart.indexOf('/rest/v1/rpc/') === 0) {
        state.counts.other++;
        return await json(route, 200, {});
      }
      state.counts.other++;
      return await json(route, 200, []);
    } catch (e) {
      // 页面关闭 / fetch 已被 abort 时 route 会抛错，忽略即可
    }
  };

  return { state, handler };
}

async function seedSession(context) {
  const payload = JSON.stringify({
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_at: Date.now() + 3600 * 1000,
    user: USER
  });
  await context.addInitScript(([key, value]) => {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {}
  }, [SESSION_KEY, payload]);
}

async function openApp(browser, viewport, options = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(20000);

  const stub = createStub(options.stub || {});
  await context.route(SUPABASE_GLOB, route => stub.handler(route));
  if (options.seed) await seedSession(context);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err && err.message ? err.message : String(err)));

  if (options.offlineFirst) await context.setOffline(true);
  await page.goto(APP_URL + (options.hash || '#account'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 15000 });

  return { context, page, stub, pageErrors };
}

/* ------------------------------------------------------------------ */
/* 页面操作辅助                                                        */
/* ------------------------------------------------------------------ */

async function gotoAccount(page) {
  await page.evaluate(() => { window.location.hash = 'account'; });
  await page.waitForSelector('.account-container', { timeout: 10000 });
}

async function gotoMap(page) {
  await page.evaluate(() => { window.location.hash = 'map'; });
  await page.waitForSelector('.level.choice-level', { timeout: 10000 });
}

async function answerOneQuestion(page) {
  const level = page.locator('.level.choice-level:not([disabled])').first();
  await level.waitFor({ state: 'visible', timeout: 10000 });
  await level.click();
  await page.waitForSelector('#quiz-dialog[open]', { timeout: 10000 });
  const option = page.locator('#quiz-dialog .option').first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.click();
  const submit = page.locator('#submit-answer');
  await submit.waitFor({ state: 'visible', timeout: 10000 });
  await poll(() => submit.isEnabled(), enabled => enabled === true, 5000);
  await submit.click();
  await page.waitForSelector('#quiz-dialog .feedback', { timeout: 10000 });
  await page.keyboard.press('Escape');
  await sleep(120);
}

async function readProgress(page) {
  return page.evaluate(() => {
    try {
      const raw = window.CQuestAccount.readLocalProgress();
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  });
}

async function accountState(page) {
  return page.evaluate(() => window.CQuestAccount._getState());
}

async function waitForState(page, predicate, timeout = 10000) {
  return poll(() => accountState(page), predicate, timeout);
}

function answerCount(state) {
  return state && state.answers ? Object.keys(state.answers).length : 0;
}

async function waitForSyncIdle(page) {
  return waitForState(page, s => s.status === 'idle' && s.lastSyncTime > 0, 12000);
}

async function fillLogin(page, email, password) {
  const form = page.locator('.account-grid-forms form').nth(0);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(password);
}

async function clickLogin(page) {
  await page.locator('.account-grid-forms form').nth(0).locator('.account-submit-btn').click();
}

async function fillSignup(page, email, password) {
  const form = page.locator('.account-grid-forms form').nth(1);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(password);
}

async function clickSignup(page) {
  await page.locator('.account-grid-forms form').nth(1).locator('.account-submit-btn').click();
}

async function waitNotice(page) {
  const notice = page.locator('.account-auth-notice');
  await notice.waitFor({ state: 'visible', timeout: 10000 });
  // authenticating 期间 statusMessage 也会显示成 notice（“正在验证登录信息...”），
  // 必须等请求真正结束（busyAction 清空且离开 authenticating）后再读最终文案。
  const pendingText = /正在验证登录信息|正在注册账号|正在验证邮箱|正在申请新的验证码/;
  return poll(async () => (await notice.textContent()) || '', text => !!text && !pendingText.test(text), 15000);
}

async function checkNoOverflow(page, viewport, label) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth
  }));
  check(m.sw <= m.iw + 1, label + ' 无横向溢出', 'scrollWidth=' + m.sw + ' innerWidth=' + m.iw);
}

async function localStorageDump(page) {
  return page.evaluate(() => {
    const out = {};
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        out[key] = window.localStorage.getItem(key);
      }
    } catch (e) {}
    try {
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        out['session:' + key] = window.sessionStorage.getItem(key);
      }
    } catch (e) {}
    return JSON.stringify(out);
  });
}

/* ------------------------------------------------------------------ */
/* 场景 A：游客本机保存 + 刷新恢复 + 零云端请求                        */
/* ------------------------------------------------------------------ */

async function scenarioGuestLocalSave(browser, viewport) {
  const { context, page, stub, pageErrors } = await openApp(browser, viewport, { hash: '#map' });
  try {
    await answerOneQuestion(page);
    const saved = await readProgress(page);
    check(answerCount(saved) >= 1, 'A 游客答题后本机已保存进度', 'answers=' + answerCount(saved));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.level.choice-level', { timeout: 10000 });
    const afterReload = await readProgress(page);
    check(answerCount(afterReload) >= 1, 'A 刷新后本机进度仍在', 'answers=' + answerCount(afterReload));

    await gotoAccount(page);
    const note = page.locator('.account-local-save-note');
    await note.waitFor({ state: 'visible', timeout: 10000 });
    const noteState = await note.getAttribute('data-local-state');
    const noteText = (await note.textContent()) || '';
    check(noteState === 'saved', 'A 游客显示本机已保存状态', 'data-local-state=' + noteState);
    check(noteText.indexOf('本机学习进度已保存') !== -1, 'A 本机保存提示文案明确', noteText);

    check(stub.state.requests.length === 0, 'A 游客模式不发起任何云端请求', JSON.stringify(stub.state.requests));
    check(pageErrors.length === 0, 'A 无页面 JS 错误', pageErrors.join(' | '));
    await checkNoOverflow(page, viewport, 'A 游客账号页');
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 场景 B：登录错误分类                                                */
/* ------------------------------------------------------------------ */

function loginFixtureCases() {
  return [
    {
      key: 'invalid_credentials',
      stub: {
        token: route => json(route, 400, {
          code: 'invalid_credentials',
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials'
        })
      },
      keywords: ['邮箱或密码不正确']
    },
    {
      key: 'email_not_confirmed',
      stub: {
        token: route => json(route, 400, {
          code: 'email_not_confirmed',
          error_code: 'email_not_confirmed',
          msg: 'Email not confirmed'
        })
      },
      keywords: ['未完成验证']
    },
    {
      key: 'server_500',
      stub: {
        token: route => json(route, 500, {})
      },
      keywords: ['HTTP 500']
    },
    {
      key: 'rate_limit_429',
      stub: {
        token: route => json(route, 429, { error_code: 'over_request_rate_limit' })
      },
      keywords: ['频繁']
    },
    {
      key: 'offline',
      stub: { offline: true },
      setOffline: true,
      keywords: ['断网']
    },
    {
      key: 'timeout',
      stub: {
        token: async route => {
          await sleep(1500);
          await json(route, 200, { access_token: 'late-token', user: USER });
        }
      },
      injectShortTimeout: true,
      keywords: ['超时']
    }
  ];
}

async function scenarioLoginErrorClassification(browser, viewport) {
  const texts = [];
  for (const c of loginFixtureCases()) {
    const { context, page, stub, pageErrors } = await openApp(browser, viewport, { stub: c.stub });
    try {
      await page.waitForSelector('.account-grid-forms form', { timeout: 10000 });
      if (c.injectShortTimeout) {
        await page.evaluate(() => {
          window.CQuestAccount._setInjectedDeps({ timeouts: { request: 500, health: 8000, emailCode: 12000 } });
        });
      }
      if (c.setOffline) await context.setOffline(true);

      await fillLogin(page, LOGIN_EMAIL, LOGIN_PASSWORD);
      await clickLogin(page);
      const text = await waitNotice(page);
      texts.push(text);

      for (const kw of c.keywords) {
        check(text.indexOf(kw) !== -1, 'B 登录[' + c.key + '] 文案含「' + kw + '」', text);
      }

      const form = page.locator('.account-grid-forms form').nth(0);
      const emailValue = await form.locator('input[name="email"]').inputValue();
      const passwordValue = await form.locator('input[name="password"]').inputValue();
      check(emailValue === LOGIN_EMAIL, 'B 登录[' + c.key + '] 失败后保留邮箱输入', emailValue);
      check(passwordValue === '', 'B 登录[' + c.key + '] 密码框不回填（不缓存密码）');

      const sendsAtNotice = stub.state.counts.token;
      check(sendsAtNotice <= 1, 'B 登录[' + c.key + '] 只提交一次登录请求', 'token=' + sendsAtNotice);
      await sleep(1200);
      check(stub.state.counts.token === sendsAtNotice, 'B 登录[' + c.key + '] 失败后无自动重试', 'token=' + stub.state.counts.token);
      check(pageErrors.length === 0, 'B 登录[' + c.key + '] 无页面 JS 错误', pageErrors.join(' | '));
    } finally {
      await context.close();
    }
  }
  check(new Set(texts).size === texts.length, 'B 登录 6 类错误文案互不相同', JSON.stringify(texts));
}

/* ------------------------------------------------------------------ */
/* 场景 C：注册错误分类                                                */
/* ------------------------------------------------------------------ */

function signupFixtureCases() {
  return [
    {
      key: 'offline',
      stub: { offline: true },
      setOffline: true,
      keywords: ['断网']
    },
    {
      key: 'timeout',
      stub: {
        signup: async route => {
          await sleep(1500);
          await json(route, 200, { id: UID, email: USER.email });
        }
      },
      injectShortTimeout: true,
      keywords: ['超时']
    },
    {
      key: 'email_send_rate_limit',
      stub: {
        signup: route => json(route, 429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' })
      },
      keywords: ['发送次数已达限制']
    },
    {
      key: 'email_address_not_authorized',
      stub: {
        signup: route => json(route, 400, { code: 'email_address_not_authorized', msg: 'Email address not authorized' })
      },
      keywords: ['邮件服务无法向此邮箱']
    }
  ];
}

async function scenarioSignupErrorClassification(browser, viewport) {
  const texts = [];
  for (const c of signupFixtureCases()) {
    const { context, page, stub, pageErrors } = await openApp(browser, viewport, { stub: c.stub });
    try {
      await page.waitForSelector('.account-grid-forms form', { timeout: 10000 });
      if (c.injectShortTimeout) {
        await page.evaluate(() => {
          window.CQuestAccount._setInjectedDeps({ timeouts: { request: 500, health: 8000, emailCode: 12000 } });
        });
      }
      if (c.setOffline) await context.setOffline(true);

      await fillSignup(page, LOGIN_EMAIL, LOGIN_PASSWORD);
      await clickSignup(page);
      const text = await waitNotice(page);
      texts.push(text);

      for (const kw of c.keywords) {
        check(text.indexOf(kw) !== -1, 'C 注册[' + c.key + '] 文案含「' + kw + '」', text);
      }

      const form = page.locator('.account-grid-forms form').nth(1);
      const emailValue = await form.locator('input[name="email"]').inputValue();
      const sends = stub.state.counts.signup;
      check(emailValue === LOGIN_EMAIL, 'C 注册[' + c.key + '] 失败后保留邮箱输入', emailValue);
      check(sends <= 1, 'C 注册[' + c.key + '] 只提交一次注册请求', 'signup=' + sends);
      await sleep(1200);
      check(stub.state.counts.signup === sends, 'C 注册[' + c.key + '] 失败后无自动重试', 'signup=' + stub.state.counts.signup);
      check(pageErrors.length === 0, 'C 注册[' + c.key + '] 无页面 JS 错误', pageErrors.join(' | '));
    } finally {
      await context.close();
    }
  }
  check(new Set(texts).size === texts.length, 'C 注册 4 类错误文案互不相同', JSON.stringify(texts));
}

/* ------------------------------------------------------------------ */
/* 场景 D：防重复提交                                                  */
/* ------------------------------------------------------------------ */

async function scenarioDoubleSubmitPrevention(browser, viewport) {
  // D1 登录双击
  {
    const { context, page, stub, pageErrors } = await openApp(browser, viewport, {
      stub: {
        token: async route => {
          await sleep(700);
          await json(route, 200, {
            access_token: 'test-token',
            refresh_token: 'test-refresh',
            expires_in: 3600,
            user: USER
          });
        }
      }
    });
    try {
      await page.waitForSelector('.account-grid-forms form', { timeout: 10000 });
      await fillLogin(page, LOGIN_EMAIL, LOGIN_PASSWORD);
      await page.evaluate(() => {
        const form = document.querySelectorAll('.account-grid-forms form')[0];
        form.requestSubmit();
        form.requestSubmit();
      });
      await sleep(150);
      const loginBtn = page.locator('.account-grid-forms form').nth(0).locator('.account-submit-btn');
      const disabled = await loginBtn.isDisabled();
      const btnText = (await loginBtn.textContent()) || '';
      check(disabled, 'D 登录在途时按钮禁用');
      check(btnText.indexOf('正在登录') !== -1, 'D 登录在途时按钮显示进度文案', btnText);

      await waitForState(page, s => Boolean(s.currentUser), 12000);
      check(stub.state.counts.token === 1, 'D 登录双击只发出 1 次请求', 'token=' + stub.state.counts.token);
      await sleep(1200);
      check(stub.state.counts.token === 1, 'D 登录成功后无重复请求', 'token=' + stub.state.counts.token);
      const storage = await localStorageDump(page);
      check(storage.indexOf(LOGIN_PASSWORD) === -1, 'D 密码未写入任何本地存储');
      check(pageErrors.length === 0, 'D1 无页面 JS 错误', pageErrors.join(' | '));
    } finally {
      await context.close();
    }
  }

  // D2 注册双击
  {
    const { context, page, stub, pageErrors } = await openApp(browser, viewport, {
      stub: {
        signup: async route => {
          await sleep(700);
          await json(route, 200, { id: UID, email: USER.email });
        }
      }
    });
    try {
      await page.waitForSelector('.account-grid-forms form', { timeout: 10000 });
      await fillSignup(page, LOGIN_EMAIL, LOGIN_PASSWORD);
      await page.evaluate(() => {
        const form = document.querySelectorAll('.account-grid-forms form')[1];
        form.requestSubmit();
        form.requestSubmit();
      });
      await sleep(150);
      const signupBtn = page.locator('.account-grid-forms form').nth(1).locator('.account-submit-btn');
      check(await signupBtn.isDisabled(), 'D 注册在途时按钮禁用');
      const btnText = (await signupBtn.textContent()) || '';
      check(btnText.indexOf('正在注册') !== -1, 'D 注册在途时按钮显示进度文案', btnText);
      await waitForState(page, s => s.status === 'signup_pending', 12000);
      check(stub.state.counts.signup === 1, 'D 注册双击只发出 1 次请求', 'signup=' + stub.state.counts.signup);
      check(pageErrors.length === 0, 'D2 无页面 JS 错误', pageErrors.join(' | '));
    } finally {
      await context.close();
    }
  }

  // D3 同步并发点击
  {
    const { context, page, stub, pageErrors } = await openApp(browser, viewport, { seed: true });
    try {
      await page.waitForSelector('.account-container', { timeout: 10000 });
      await waitForSyncIdle(page);
      const saveBefore = stub.state.counts.save;

      stub.state.delay = 400;
      await page.evaluate(() => {
        window.CQuestAccount.handleSyncNow();
        window.CQuestAccount.handleSyncNow();
        window.CQuestAccount.handleSyncNow();
      });
      await sleep(200);
      const syncBtn = page.locator('.account-actions-row .primary');
      check(await syncBtn.isDisabled(), 'D 同步在途时按钮禁用');
      await waitForState(page, s => s.status === 'idle' && !s.busyAction && !s.syncInFlight, 20000);
      check(stub.state.counts.save === saveBefore + 1, 'D 并发同步只发出 1 次保存', 'save=' + stub.state.counts.save + ' before=' + saveBefore);
      await sleep(1500);
      check(stub.state.counts.save === saveBefore + 1, 'D 同步完成后无重复请求', 'save=' + stub.state.counts.save);
      check(pageErrors.length === 0, 'D3 无页面 JS 错误', pageErrors.join(' | '));
    } finally {
      await context.close();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 场景 E：断网答题 → 刷新 → 手动重试 → 恢复单次同步                   */
/* ------------------------------------------------------------------ */

async function scenarioOfflineLifecycle(browser, viewport) {
  const { context, page, stub, pageErrors } = await openApp(browser, viewport, { seed: true });
  try {
    await page.waitForSelector('.account-container', { timeout: 10000 });
    await waitForSyncIdle(page);
    const getBefore = stub.state.counts.getProgress;
    const saveBefore = stub.state.counts.save;
    check(getBefore >= 1 && saveBefore >= 1, 'E 登录后自动完成一次云端同步', 'GET=' + getBefore + ' RPC=' + saveBefore);

    // 阶段 1：云端不可达（浏览器仍认为在线）→ 答题触发一次后台同步并失败
    stub.state.offline = true;
    await gotoMap(page);
    await answerOneQuestion(page);
    const failed = await waitForState(page, s => s.status === 'offline' && Boolean(s.lastSyncError), 12000);
    check(Boolean(failed.lastSyncError), 'E 云端不可达时后台同步失败并记录原因');
    check(['offline', 'network'].indexOf(failed.lastSyncError.kind) !== -1, 'E 云端不可达被归类为断网/网络错误', failed.lastSyncError.kind);
    check(failed.autoSyncPaused === true, 'E 同步失败后自动重试已暂停（避免循环）');
    const getAfterFail = stub.state.counts.getProgress;
    await sleep(1500);
    check(stub.state.counts.getProgress === getAfterFail, 'E 同步失败后不会自动循环重试', 'GET=' + stub.state.counts.getProgress + ' before=' + getAfterFail);

    // 阶段 2：账号页降级 UI（本机进度 + 手动重试入口）
    await gotoAccount(page);
    const alert = page.locator('.account-sync-alert');
    await alert.waitFor({ state: 'visible', timeout: 10000 });
    const alertKind = await alert.getAttribute('data-sync-error-kind');
    const alertText = (await alert.textContent()) || '';
    check(['offline', 'network'].indexOf(alertKind) !== -1, 'E 云不可达卡片分类正确', 'kind=' + alertKind);
    check(alertText.indexOf('本机') !== -1, 'E 云不可达卡片提示进度保存在本机', alertText.slice(0, 80));
    const note = page.locator('.account-local-save-note');
    check((await note.getAttribute('data-local-state')) === 'pending', 'E 本机保存状态显示待同步');
    check((await page.locator('.account-sync-alert button').count()) === 1, 'E 提供手动重试入口');
    check(await page.locator('.account-sync-alert button').first().isEnabled(), 'E 手动重试按钮可点击');

    if (viewport.mobile) {
      const statusEl = page.locator('#account-status');
      check(await statusEl.isVisible(), 'E 手机顶栏显示待同步状态');
      const statusText = ((await statusEl.textContent()) || '').trim();
      check(statusText.indexOf('等待同步') !== -1, 'E 手机顶栏待同步文案', statusText);
    }
    await checkNoOverflow(page, viewport, 'E 断网账号页');

    // 阶段 3：设备断网（浏览器 offline 事件）→ 刷新后仍保留本机进度与待同步提示
    await context.setOffline(true);
    await sleep(300);
    const deviceOffline = await accountState(page);
    check(deviceOffline.status === 'offline' && (deviceOffline.statusMessage || '').indexOf('断开') !== -1,
      'E 设备断网后给出断网提示', deviceOffline.statusMessage);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.account-container', { timeout: 15000 });
    await page.waitForSelector('.account-sync-alert', { timeout: 15000 });
    const progressAfterReload = await readProgress(page);
    check(answerCount(progressAfterReload) >= 1, 'E 断网刷新后本机进度仍在', 'answers=' + answerCount(progressAfterReload));
    check((await page.locator('.account-local-save-note').getAttribute('data-local-state')) === 'pending', 'E 刷新后仍提示待同步');
    check((await page.locator('.account-sync-alert button').count()) >= 1, 'E 刷新后仍保留手动重试入口');
    const reloadState = await accountState(page);
    check(reloadState.pendingLocalChanges === true, 'E 刷新后仍识别本机待同步改动');
    if (viewport.mobile) {
      check(await page.locator('#account-status').isVisible(), 'E 刷新后手机顶栏仍显示待同步状态');
    }
    await checkNoOverflow(page, viewport, 'E 刷新后账号页');

    // 阶段 4：手动重试一次（仍断网）→ 失败但不循环
    await page.locator('.account-sync-alert button').first().click();
    await sleep(700);
    const getAfterRetry = stub.state.counts.getProgress;
    await sleep(1500);
    check(stub.state.counts.getProgress === getAfterRetry, 'E 手动重试失败后不自动循环', 'GET=' + stub.state.counts.getProgress);
    const retriedState = await accountState(page);
    check(retriedState.autoSyncPaused === true, 'E 手动重试失败后再次暂停自动同步');

    // 阶段 5：网络恢复：online 事件只尝试一次并完成同步
    const getAtRecovery = stub.state.counts.getProgress;
    const saveAtRecovery = stub.state.counts.save;
    stub.state.offline = false;
    await context.setOffline(false);
    const recovered = await waitForState(page, s => s.status === 'idle' && s.lastSyncTime > 0 && !s.lastSyncError, 15000);
    check(Boolean(recovered), 'E 网络恢复后完成一次云端同步');
    check(stub.state.counts.getProgress === getAtRecovery + 1, 'E 恢复后只发起 1 次读取', 'GET=' + stub.state.counts.getProgress + ' before=' + getAtRecovery);
    check(stub.state.counts.save === saveAtRecovery + 1, 'E 恢复后只提交 1 次存档', 'RPC=' + stub.state.counts.save + ' before=' + saveAtRecovery);
    await sleep(2000);
    check(stub.state.counts.getProgress === getAtRecovery + 1, 'E 恢复后无重复自动同步循环', 'GET=' + stub.state.counts.getProgress);
    const finalState = await accountState(page);
    check(!finalState.lastSyncError, 'E 同步成功后清空失败记录');
    check(finalState.pendingLocalChanges === false, 'E 同步成功后清除待同步标记');
    const finalProgress = await readProgress(page);
    check(answerCount(finalProgress) >= 1, 'E 恢复后本机进度未丢失', 'answers=' + answerCount(finalProgress));
    check(pageErrors.length === 0, 'E 无页面 JS 错误', pageErrors.join(' | '));
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 场景 F：首屏/做题不被挂起的云端请求阻塞                             */
/* ------------------------------------------------------------------ */

async function scenarioFirstScreenNotBlocked(browser, viewport) {
  const { context, page, stub, pageErrors } = await openApp(browser, viewport, {
    seed: true,
    hash: '#map',
    stub: {
      delay: 5000,
      getProgress: null,
      save: null
    }
  });
  try {
    const t0 = Date.now();
    await page.waitForSelector('.level.choice-level', { timeout: 2500 });
    const renderMs = Date.now() - t0;
    check(renderMs < 2500, 'F 首屏地图未被云端请求阻塞', 'renderMs=' + renderMs);

    const answerStart = Date.now();
    await answerOneQuestion(page);
    const answerMs = Date.now() - answerStart;
    check(answerMs < 4000, 'F 云端请求挂起时仍可正常答题', 'answerMs=' + answerMs);
    const saved = await readProgress(page);
    check(answerCount(saved) >= 1, 'F 答题后本机进度已保存', 'answers=' + answerCount(saved));
    check(pageErrors.length === 0, 'F 无页面 JS 错误', pageErrors.join(' | '));
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 场景 G：409 多设备冲突有界重试                                      */
/* ------------------------------------------------------------------ */

async function scenarioConflictBoundedRetry(browser, viewport) {
  const { context, page, stub, pageErrors } = await openApp(browser, viewport, {
    seed: true,
    stub: {
      save: route => json(route, 409, { message: 'Progress changed; read and merge again' })
    }
  });
  try {
    await page.waitForSelector('.account-container', { timeout: 10000 });
    await poll(() => stub.state.counts.save, n => n >= 4, 15000);
    check(stub.state.counts.save === 4, 'G 冲突重试有上限（1 次 + 最多 3 次重试）', 'RPC=' + stub.state.counts.save);
    await sleep(2000);
    check(stub.state.counts.save === 4, 'G 冲突重试结束后不再自动重试', 'RPC=' + stub.state.counts.save);

    const st = await accountState(page);
    check(Boolean(st.lastSyncError), 'G 记录同步失败原因');
    check(st.lastSyncError && st.lastSyncError.kind === 'conflict', 'G 冲突被单独分类为版本冲突', st.lastSyncError && st.lastSyncError.kind);
    check(st.autoSyncPaused === true, 'G 冲突后暂停自动同步');

    await gotoAccount(page);
    const alert = page.locator('.account-sync-alert');
    check(await alert.count() === 1, 'G 账号页显示同步中断卡片');
    check((await alert.getAttribute('data-sync-error-kind')) === 'conflict', 'G 卡片标记版本冲突');
    check((await page.locator('.account-sync-alert button').count()) === 1, 'G 冲突时提供手动重试入口');
    const saveBeforeAnswer = stub.state.counts.save;
    await gotoMap(page);
    await answerOneQuestion(page);
    const progress = await readProgress(page);
    check(answerCount(progress) >= 1, 'G 冲突后本机存档仍可用', 'answers=' + answerCount(progress));
    const afterAnswer = await accountState(page);
    check(afterAnswer.pendingLocalChanges === true, 'G 冲突后答题标记为待同步');
    await sleep(800);
    check(stub.state.counts.save === saveBeforeAnswer, 'G 冲突暂停期间答题不会自动重试上传', 'RPC=' + stub.state.counts.save);
    check(pageErrors.length === 0, 'G 无页面 JS 错误', pageErrors.join(' | '));
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 场景 H：退出登录保留进度并提示未同步                                */
/* ------------------------------------------------------------------ */

async function scenarioLogoutKeepsProgress(browser, viewport) {
  const { context, page, stub, pageErrors } = await openApp(browser, viewport, { seed: true });
  try {
    await page.waitForSelector('.account-container', { timeout: 10000 });
    await waitForSyncIdle(page);

    stub.state.save = route => json(route, 500, {});
    await gotoMap(page);
    await answerOneQuestion(page);
    const failed = await waitForState(page, s => Boolean(s.lastSyncError), 15000);
    check(failed.lastSyncError && failed.lastSyncError.httpStatus === 500, 'H 同步失败记录 5xx 状态', JSON.stringify(failed.lastSyncError));

    await gotoAccount(page);
    const logoutBtn = page.locator('.account-actions-row .danger-btn');
    await logoutBtn.waitFor({ state: 'visible', timeout: 10000 });
    await logoutBtn.click();

    const toastText = await poll(
      () => page.evaluate(() => {
        const el = document.querySelector('#toast');
        return el ? (el.textContent || '') : '';
      }),
      text => text.indexOf('已退出') !== -1,
      5000
    );
    check(toastText.indexOf('未同步') !== -1, 'H 退出登录提示本机仍有未同步进度', toastText.slice(0, 80));

    await sleep(400);
    const stored = await page.evaluate(([sessionKey, userKey]) => ({
      session: window.localStorage.getItem(sessionKey),
      sessionMem: window.sessionStorage.getItem(sessionKey),
      userProgress: window.localStorage.getItem(userKey)
    }), [SESSION_KEY, USER_KEY]);
    check(!stored.session && !stored.sessionMem, 'H 退出后清除本地 token/session');
    check(Boolean(stored.userProgress), 'H 退出后保留该账号本机进度');
    let keptAnswers = -1;
    try {
      keptAnswers = answerCount(JSON.parse(stored.userProgress));
    } catch (e) {}
    check(keptAnswers >= 1, 'H 保留的本机进度包含答题记录', 'answers=' + keptAnswers);

    const current = await accountState(page);
    check(current.currentUser === null, 'H 退出后回到游客态');
    await gotoMap(page);
    check(await page.locator('.level.choice-level').count() > 0, 'H 退出后仍可继续做题');
    check(pageErrors.length === 0, 'H 无页面 JS 错误', pageErrors.join(' | '));
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 场景 I：emailCodeEnabled 默认关闭                                   */
/* ------------------------------------------------------------------ */

async function scenarioEmailCodeDefaultOff(browser, viewport) {
  const { context, page, stub, pageErrors } = await openApp(browser, viewport, {});
  try {
    await page.waitForSelector('.account-grid-forms form', { timeout: 10000 });
    check((await page.locator('.account-email-code').count()) === 0, 'I emailCodeEnabled 默认关闭：页面无数字验证码区块');

    const result = await page.evaluate(async () => {
      const form = document.createElement('form');
      const email = document.createElement('input');
      email.name = 'email';
      email.value = 'student@example.com';
      const code = document.createElement('input');
      code.name = 'code';
      code.value = '123456';
      form.appendChild(email);
      form.appendChild(code);
      document.body.appendChild(form);
      await window.CQuestAccount.handleEmailCode(form);
      const toast = document.querySelector('#toast');
      const text = toast ? (toast.textContent || '') : '';
      form.remove();
      return { text, status: window.CQuestAccount._getState().status };
    });
    check(result.text.indexOf('尚未开启') !== -1, 'I 默认关闭时验证码入口给出明确提示', result.text);
    check(stub.state.counts.verify === 0 && stub.state.counts.resend === 0, 'I 默认关闭时不发起任何验证码请求', JSON.stringify({ verify: stub.state.counts.verify, resend: stub.state.counts.resend }));
    check(result.status === 'guest', 'I 默认关闭时不会进入 authenticating 状态', result.status);
    check(pageErrors.length === 0, 'I 无页面 JS 错误', pageErrors.join(' | '));
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const SCENARIOS = [
  ['A 游客本机保存/刷新恢复', scenarioGuestLocalSave],
  ['B 登录错误分类', scenarioLoginErrorClassification],
  ['C 注册错误分类', scenarioSignupErrorClassification],
  ['D 防重复提交', scenarioDoubleSubmitPrevention],
  ['E 断网保存/刷新/恢复', scenarioOfflineLifecycle],
  ['F 首屏不被阻塞', scenarioFirstScreenNotBlocked],
  ['G 冲突有界重试', scenarioConflictBoundedRetry],
  ['H 退出登录保留进度', scenarioLogoutKeepsProgress],
  ['I emailCodeEnabled 默认关闭', scenarioEmailCodeDefaultOff]
];

async function main() {
  console.log('build: ' + BUILD);
  console.log('app:   ' + APP_URL);

  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      console.log('\n=== 视口 ' + viewport.name + 'x' + viewport.height + ' ===');
      for (const [name, fn] of SCENARIOS) {
        console.log('\n[' + name + '] @' + viewport.name);
        try {
          await fn(browser, viewport);
        } catch (e) {
          check(false, name + ' @' + viewport.name + ' 场景执行异常', e && e.message ? e.message : String(e));
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n==============================');
  console.log('PASS: ' + passCount + '   FAIL: ' + failCount);
  if (failCount > 0) {
    console.log('失败项：');
    failures.forEach(item => console.log(' - ' + item));
    process.exitCode = 1;
  } else {
    console.log('全部韧性用例通过。');
    process.exitCode = 0;
  }
  await sleep(50);
  process.exit(process.exitCode);
}

main().catch(err => {
  console.error('测试运行器异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
