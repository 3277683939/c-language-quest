/**
 * Test suite for overrides/account.js
 * Run with: node tools/test_account.cjs
 */
'use strict';

const assert = require('assert');
const syncCore = require('../overrides/sync-core.js');
const accountModule = require('../overrides/account.js');

let testCount = 0;
async function test(name, fn) {
  testCount++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 模拟 Web Storage
function createMockStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    _dump: () => Object.fromEntries(store.entries())
  };
}

function findSessionKey(storage) {
  for (const k of Object.keys(storage._dump())) {
    if (k.startsWith('cquest_auth_session')) return k;
  }
  return null;
}

function findUserKey(storage, uid) {
  for (const k of Object.keys(storage._dump())) {
    if (k.includes('_u_' + uid)) return k;
  }
  return null;
}

// 模拟 DOM Form 与 Input
function createMockForm(fields) {
  const data = new Map(Object.entries(fields));
  const inputs = [];
  for (const [name, val] of data.entries()) {
    inputs.push({
      name,
      value: val,
      type: name === 'password' ? 'password' : 'text',
      closest: () => null,
      parentElement: { parentElement: null }
    });
  }

  return {
    _data: data,
    querySelector: sel => {
      if (sel.includes('password')) {
        return inputs.find(i => i.name === 'password') || null;
      }
      return null;
    },
    querySelectorAll: sel => {
      if (sel.includes('password')) {
        return inputs.filter(i => i.name === 'password');
      }
      return inputs;
    }
  };
}

// 设置全局 FormData
global.FormData = class MockFormData {
  constructor(form) {
    this.map = form._data || new Map();
  }
  get(key) {
    return this.map.get(key) ?? null;
  }
};

console.log('Running test_account.cjs (Account & Cloud Persistence Lifecycle Tests)...');

async function runAll() {
  await test('1. Unconfigured cloud: makes 0 network calls and reports local/unconfigured status', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();
    let networkCalls = 0;

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: '', publishableKey: '' };

    accountModule._setInjectedDeps({
      fetch: async () => {
        networkCalls++;
        throw new Error('Should not make any network calls');
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let currentState = { version: 1, answers: {}, wrong: [], favorites: [] };
    accountModule.attach({
      getState: () => currentState,
      replaceState: s => { currentState = s; },
      render: () => {},
      toast: () => {}
    });

    assert.strictEqual(accountModule.isCloudConfigured(), false);
    assert.strictEqual(accountModule.statusLabel(), '本机模式');
    assert.strictEqual(networkCalls, 0);

    // 本地保存和读取正常运作
    accountModule.saveLocalProgress({ version: 1, answers: { q1: { attempts: 1, correct: 1 } } });
    const raw = accountModule.readLocalProgress();
    assert.ok(raw && raw.includes('q1'));
    assert.strictEqual(networkCalls, 0);
  });

  await test('2. Signup pending email verification: does NOT treat as logged in', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    let fetchCalled = false;
    accountModule._setInjectedDeps({
      fetch: async (url, opts) => {
        fetchCalled = true;
        assert.ok(url.endsWith('/auth/v1/signup'));
        assert.strictEqual(opts.method, 'POST');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { id: 'user-pending-uuid', email: 'test@example.com' },
            session: null
          })
        };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    accountModule.attach({
      getState: () => ({ version: 1 }),
      replaceState: () => {},
      render: () => {},
      toast: () => {}
    });

    const form = createMockForm({ email: 'test@example.com', password: 'mypassword123', remember: 'on' });
    await accountModule.handleSignup(form);

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(accountModule.statusLabel(), '待验证邮箱');
    assert.strictEqual(accountModule._getState().currentUser, null, 'Must NOT set currentUser before verification');
    assert.strictEqual(findSessionKey(mockLocal), null, 'Must NOT persist auth session');
    assert.strictEqual(findSessionKey(mockSession), null);
  });

  await test('3. Remember Me = false saves session to sessionStorage, NOT localStorage; password never stored', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    accountModule._setInjectedDeps({
      fetch: async (url) => {
        if (url.includes('/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'tok-abc-123',
              refresh_token: 'ref-xyz-456',
              expires_in: 3600,
              user: { id: 'uid-user-1', email: 'user1@test.com' }
            })
          };
        }
        if (url.includes('/cquest_progress')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    accountModule.attach({
      getState: () => ({ version: 1, answers: {} }),
      replaceState: () => {},
      render: () => {},
      toast: () => {}
    });

    const form = createMockForm({ email: 'user1@test.com', password: 'secretpassword' });
    await accountModule.handleLogin(form);

    assert.strictEqual(accountModule.statusLabel(), '云端已同步');
    const sessKey = findSessionKey(mockSession);
    assert.ok(sessKey, 'Session must be in sessionStorage');
    const sessRaw = mockSession.getItem(sessKey);
    assert.strictEqual(findSessionKey(mockLocal), null, 'Session must NOT be in localStorage when remember is false');

    assert.strictEqual(sessRaw.includes('secretpassword'), false, 'Password must never be saved in session');
    assert.strictEqual(JSON.stringify(mockLocal._dump()).includes('secretpassword'), false, 'Password must never be in localStorage');
  });

  await test('4. User storage namespaces: User A, User B, and Guest have strictly isolated progress keys', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    accountModule._setInjectedDeps({
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let activeState = { version: 1, answers: { q_guest: { attempts: 1 } } };
    accountModule.attach({
      getState: () => activeState,
      replaceState: s => { activeState = s; },
      render: () => {},
      toast: () => {}
    });

    // 1. Save guest progress
    accountModule.saveLocalProgress(activeState);
    assert.ok(mockLocal.getItem('c-quest-progress-v1').includes('q_guest'));

    // 2. Simulate User A login
    const authKey = 'cquest_auth_session_test';
    mockSession.setItem(authKey, JSON.stringify({
      access_token: 'tok_A',
      user: { id: 'uid_A', email: 'a@test.com' }
    }));
    accountModule.attach({
      getState: () => activeState,
      replaceState: s => { activeState = s; },
      render: () => {},
      toast: () => {}
    });

    const userAState = { version: 1, answers: { q_user_A: { attempts: 5 } } };
    accountModule.saveLocalProgress(userAState);

    const userAKey = findUserKey(mockLocal, 'uid_A');
    assert.ok(userAKey && mockLocal.getItem(userAKey).includes('q_user_A'));
    // Guest progress is untouched
    assert.ok(mockLocal.getItem('c-quest-progress-v1').includes('q_guest'));
    assert.strictEqual(mockLocal.getItem('c-quest-progress-v1').includes('q_user_A'), false);

    // 3. Simulate User B login
    mockSession.setItem(authKey, JSON.stringify({
      access_token: 'tok_B',
      user: { id: 'uid_B', email: 'b@test.com' }
    }));
    accountModule.attach({
      getState: () => activeState,
      replaceState: s => { activeState = s; },
      render: () => {},
      toast: () => {}
    });

    const userBState = { version: 1, answers: { q_user_B: { attempts: 10 } } };
    accountModule.saveLocalProgress(userBState);

    const userBKey = findUserKey(mockLocal, 'uid_B');
    assert.ok(userBKey && mockLocal.getItem(userBKey).includes('q_user_B'));
    // Neither User A nor Guest has User B's progress
    assert.strictEqual(mockLocal.getItem(userAKey).includes('q_user_B'), false);
    assert.strictEqual(mockLocal.getItem('c-quest-progress-v1').includes('q_user_B'), false);
  });

  await test('5. First-time login detects guest data: merge option combines data; replace option preserves guest', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockLocal.setItem('c-quest-progress-v1', JSON.stringify({
      version: 1,
      answers: { q_guest: { attempts: 2, correct: 2, last: 'B' } },
      wrong: ['q_wrong_guest'],
      favorites: [],
      levels: {},
      days: ['2026-11-01'],
      drafts: {},
      selfChecks: {}
    }));

    let savedCloudPayload = null;
    accountModule._setInjectedDeps({
      fetch: async (url, opts) => {
        if (url.includes('/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'tok_A',
              refresh_token: 'ref_A',
              user: { id: 'uid_first_time', email: 'first@test.com' }
            })
          };
        }
        if (url.includes('/cquest_progress')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{
              revision: 1,
              document: {
                schemaVersion: 1,
                answers: { q_remote: { attempts: 1, correct: 1, last: 'A' } },
                wrong: {},
                favorites: {},
                levels: {},
                days: ['2026-11-02'],
                drafts: {},
                selfChecks: {}
              }
            }]
          };
        }
        if (url.includes('/cquest_save_progress')) {
          const body = JSON.parse(opts.body);
          savedCloudPayload = body.payload;
          return {
            ok: true,
            status: 200,
            json: async () => [{ revision: 2, updated_at: '2026-11-02T12:00:00Z' }]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let appState = null;
    accountModule.attach({
      getState: () => appState,
      replaceState: s => { appState = s; },
      render: () => {},
      toast: () => {}
    });

    const form = createMockForm({ email: 'first@test.com', password: 'password123' });
    await accountModule.handleLogin(form);

    assert.strictEqual(accountModule.statusLabel(), '待处理存档');
    assert.ok(accountModule._getState().pendingMerge);

    await accountModule.handleMergeChoice('merge');

    assert.ok(appState.answers['q_guest']);
    assert.ok(appState.answers['q_remote']);
    assert.ok(appState.wrong.includes('q_wrong_guest'));
    assert.ok(savedCloudPayload.answers['q_guest']);
    assert.ok(savedCloudPayload.answers['q_remote']);
    assert.strictEqual(accountModule.statusLabel(), '云端已同步');
    // Guest backup must remain intact
    assert.ok(mockLocal.getItem('c-quest-progress-v1'), 'Guest backup must NOT be removed');
  });

  await test('6. Logout restores guest state, retains user local backup, does NOT copy user data to guest', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockLocal.setItem('c-quest-progress-v1', JSON.stringify({
      version: 1,
      answers: { q_guest_only: { attempts: 1 } },
      wrong: [],
      favorites: []
    }));

    mockLocal.setItem('c-quest-progress_test_u_uid_X', JSON.stringify({
      version: 1,
      answers: { q_user_X_secret: { attempts: 10 } },
      wrong: [],
      favorites: []
    }));

    mockSession.setItem('cquest_auth_session_test', JSON.stringify({
      access_token: 'tok_X',
      user: { id: 'uid_X', email: 'x@test.com' }
    }));

    let currentAppState = null;
    accountModule._setInjectedDeps({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: 'uid_X' }) }),
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    accountModule.attach({
      getState: () => currentAppState,
      replaceState: s => { currentAppState = s; },
      render: () => {},
      toast: () => {}
    });

    const userProgress = accountModule.readLocalProgress();
    assert.ok(userProgress.includes('q_user_X_secret'));

    await accountModule.handleLogout();

    assert.strictEqual(accountModule._getState().currentUser, null);
    assert.strictEqual(accountModule.statusLabel(), '未登录');
    assert.ok(currentAppState.answers['q_guest_only']);
    assert.strictEqual(currentAppState.answers['q_user_X_secret'], undefined, 'User data must NOT leak into guest state');
    assert.ok(mockLocal.getItem('c-quest-progress_test_u_uid_X').includes('q_user_X_secret'));
  });

  await test('7. 401 Unauthorized triggers single-flight refresh token and retries request', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockSession.setItem('cquest_auth_session_test', JSON.stringify({
      access_token: 'expired_token',
      refresh_token: 'valid_refresh_token',
      user: { id: 'uid_refresh_test', email: 'ref@test.com' }
    }));

    let initialFetchAttempt = 0;
    let refreshCalls = 0;
    let saveAttempts = 0;

    accountModule._setInjectedDeps({
      fetch: async (url, opts) => {
        if (url.includes('/auth/v1/user')) {
          return { ok: true, status: 200, json: async () => ({ id: 'uid_refresh_test', email: 'ref@test.com' }) };
        }
        if (url.includes('/token?grant_type=refresh_token')) {
          refreshCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'fresh_new_token',
              refresh_token: 'next_refresh_token',
              expires_in: 3600
            })
          };
        }
        if (url.includes('/cquest_progress')) {
          initialFetchAttempt++;
          if (initialFetchAttempt === 1) {
            return { ok: false, status: 401, json: async () => ({ message: 'JWT expired' }) };
          }
          assert.strictEqual(opts.headers['Authorization'], 'Bearer fresh_new_token');
          return {
            ok: true,
            status: 200,
            json: async () => [{ revision: 1, document: { answers: {} } }]
          };
        }
        if (url.includes('/cquest_save_progress')) {
          saveAttempts++;
          return {
            ok: true,
            status: 200,
            json: async () => [{ revision: 2 }]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    accountModule.attach({
      getState: () => ({ version: 1, answers: {} }),
      replaceState: () => {},
      render: () => {},
      toast: () => {}
    });

    await accountModule.handleSyncNow();

    assert.strictEqual(refreshCalls, 1, 'Refresh token called exactly once');
    assert.strictEqual(initialFetchAttempt, 2, 'Request retried after refresh');
    assert.strictEqual(saveAttempts, 1);
    assert.strictEqual(accountModule.statusLabel(), '云端已同步');
  });

  await test('8. 409 Concurrency Conflict re-reads remote progress, merges, and retries RPC', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockSession.setItem('cquest_auth_session_test', JSON.stringify({
      access_token: 'tok_409',
      user: { id: 'uid_409', email: 'conflict@test.com' }
    }));

    let readCount = 0;
    let rpcSaveCount = 0;
    let finalPayloadSaved = null;

    accountModule._setInjectedDeps({
      fetch: async (url, opts) => {
        if (url.includes('/auth/v1/user')) {
          return { ok: true, status: 200, json: async () => ({ id: 'uid_409', email: 'conflict@test.com' }) };
        }
        if (url.includes('/cquest_progress')) {
          readCount++;
          if (readCount === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => [{
                revision: 1,
                document: { answers: { q1: { attempts: 1, correct: 1, last: 'A' } } }
              }]
            };
          } else {
            return {
              ok: true,
              status: 200,
              json: async () => [{
                revision: 2,
                document: { answers: { q1: { attempts: 1, correct: 1, last: 'A' }, q2: { attempts: 3, correct: 3, last: 'C' } } }
              }]
            };
          }
        }
        if (url.includes('/cquest_save_progress')) {
          rpcSaveCount++;
          const body = JSON.parse(opts.body);
          if (rpcSaveCount === 1) {
            return {
              ok: false,
              status: 409,
              json: async () => ({ message: 'Progress changed; read and merge again' })
            };
          } else {
            assert.strictEqual(body.expected_revision, 2);
            finalPayloadSaved = body.payload;
            return {
              ok: true,
              status: 200,
              json: async () => [{ revision: 3, updated_at: '2026-11-02T12:00:00Z' }]
            };
          }
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let clientState = { version: 1, answers: { q3: { attempts: 1, correct: 1, last: 'B' } } };
    accountModule.attach({
      getState: () => clientState,
      replaceState: s => { clientState = s; },
      render: () => {},
      toast: () => {}
    });

    await accountModule.handleSyncNow();

    assert.strictEqual(readCount, 2, 'Must re-read remote document on 409 conflict');
    assert.strictEqual(rpcSaveCount, 2, 'Must retry RPC with updated revision');
    assert.ok(finalPayloadSaved.answers['q1']);
    assert.ok(finalPayloadSaved.answers['q2']);
    assert.ok(finalPayloadSaved.answers['q3']);
    assert.strictEqual(accountModule.statusLabel(), '云端已同步');
  });

  await test('9. Local edit during in-flight sync preserves local edit time and triggers follow-up sync', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockSession.setItem('cquest_auth_session_test', JSON.stringify({
      access_token: 'tok_inflight',
      user: { id: 'uid_inflight', email: 'inflight@test.com' }
    }));

    let scheduledSyncCalls = 0;
    let syncCount = 0;

    let resolveFirstFetch;
    const firstFetchPromise = new Promise(r => { resolveFirstFetch = r; });

    accountModule._setInjectedDeps({
      fetch: async (url) => {
        if (url.includes('/auth/v1/user')) {
          return { ok: true, status: 200, json: async () => ({ id: 'uid_inflight', email: 'inflight@test.com' }) };
        }
        if (url.includes('/cquest_progress')) {
          syncCount++;
          if (syncCount === 1) {
            await firstFetchPromise;
          }
          return {
            ok: true,
            status: 200,
            json: async () => [{ revision: 1, document: { answers: {} } }]
          };
        }
        if (url.includes('/cquest_save_progress')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{ revision: 2 }]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession,
      timer: (fn, delay) => {
        scheduledSyncCalls++;
        return setTimeout(fn, delay);
      }
    });

    let localState = { version: 1, answers: { q1: { attempts: 1 } } };
    accountModule.attach({
      getState: () => localState,
      replaceState: s => { localState = s; },
      render: () => {},
      toast: () => {}
    });

    const syncPromise = accountModule.handleSyncNow();

    localState.answers['q2'] = { attempts: 1, correct: 1 };
    accountModule.saveLocalProgress(localState);

    resolveFirstFetch();
    await syncPromise;

    assert.ok(scheduledSyncCalls > 0, 'Follow-up sync must be scheduled for edits made during sync');
  });

  await test('10. User switch generation guard: inflight requests from User A are discarded upon switch/logout', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockSession.setItem('cquest_auth_session_test', JSON.stringify({
      access_token: 'tok_user_A',
      user: { id: 'uid_A', email: 'a@test.com' }
    }));

    let slowRequestResolve;
    const slowRequestPromise = new Promise(r => { slowRequestResolve = r; });

    accountModule._setInjectedDeps({
      fetch: async (url) => {
        if (url.includes('/auth/v1/user')) {
          return { ok: true, status: 200, json: async () => ({ id: 'uid_inflight', email: 'inflight@test.com' }) };
        }
        if (url.includes('/cquest_progress')) {
          await slowRequestPromise;
          return {
            ok: true,
            status: 200,
            json: async () => [{
              revision: 10,
              document: { answers: { q_corrupt_A: { attempts: 99 } } }
            }]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let clientState = { version: 1, answers: { q_guest: { attempts: 1 } } };
    accountModule.attach({
      getState: () => clientState,
      replaceState: s => { clientState = s; },
      render: () => {},
      toast: () => {}
    });

    const pendingSyncA = accountModule.handleSyncNow();
    await accountModule.handleLogout();

    slowRequestResolve();
    await pendingSyncA;

    assert.strictEqual(clientState.answers['q_corrupt_A'], undefined, 'User A response must be dropped by generation guard');
  });

  await test('11. Offline network drop gracefully falls back to local save and recovers upon reconnect', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockSession.setItem('cquest_auth_session_test', JSON.stringify({
      access_token: 'tok_offline',
      user: { id: 'uid_offline', email: 'offline@test.com' }
    }));

    let networkOnline = false;

    accountModule._setInjectedDeps({
      fetch: async (url) => {
        if (!networkOnline) {
          const netErr = new TypeError('Failed to fetch (offline)');
          throw netErr;
        }
        if (url.includes('/auth/v1/user')) {
          return { ok: true, status: 200, json: async () => ({ id: 'uid_offline', email: 'offline@test.com' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => [{ revision: 1, document: { answers: {} } }]
        };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let currentClientState = { version: 1, answers: { q_offline: { attempts: 1 } } };
    accountModule.attach({
      getState: () => currentClientState,
      replaceState: s => { currentClientState = s; },
      render: () => {},
      toast: () => {}
    });

    accountModule.saveLocalProgress(currentClientState);
    await accountModule.handleSyncNow();

    assert.strictEqual(accountModule.statusLabel(), '等待同步');
    const rawLocal = accountModule.readLocalProgress();
    assert.ok(rawLocal.includes('q_offline'));

    networkOnline = true;
    await accountModule.handleSyncNow();

    assert.strictEqual(accountModule.statusLabel(), '云端已同步');
  });

  await test('12. Password input clearing works even when input type is toggled to text', async () => {
    accountModule._resetForTesting();
    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    accountModule._setInjectedDeps({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'tok_test',
          refresh_token: 'ref_test',
          user: { id: 'uid_pwd', email: 'pwd@test.com' }
        })
      }),
      localStorage: createMockStorage(),
      sessionStorage: createMockStorage()
    });

    accountModule.attach({ getState: () => ({ version: 1 }), replaceState: () => {}, render: () => {}, toast: () => {} });

    const form = createMockForm({ email: 'pwd@test.com', password: 'secret123password' });
    // Simulate user toggled password visibility to text!
    const pwdInput = form.querySelector('input[name="password"]');
    pwdInput.type = 'text';

    await accountModule.handleLogin(form);

    assert.strictEqual(pwdInput.value, '', 'Password input must be cleared even when type is text');
    assert.strictEqual(pwdInput.type, 'password', 'Password input type must be reset to password');
  });

  await test('13. Non-HTTPS or service_role/secret keys are strictly rejected', () => {
    accountModule._resetForTesting();
    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'http://insecure.supabase.co', publishableKey: 'anon-key-123' };
    assert.strictEqual(accountModule.isCloudConfigured(), false, 'HTTP URL must be rejected');

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'service_role_secret_key_123' };
    assert.strictEqual(accountModule.isCloudConfigured(), false, 'service_role key must be rejected');
  });

  await test('14. Implicit callback hash sanitization clears tokens/errors without storing or exposing them', () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    // 1. 成功回跳包含 access_token / refresh_token
    const winSuccess = {
      location: {
        hash: '#access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive&refresh_token=sensitive_refresh&token_type=bearer&type=signup',
        pathname: '/app/',
        search: ''
      },
      history: {
        replaceState: (_state, _title, url) => {
          winSuccess.location.hash = url.slice(url.indexOf('#'));
          winSuccess.location.cleanUrl = url;
        }
      }
    };

    accountModule.checkAndCleanAuthHash(winSuccess);
    assert.strictEqual(winSuccess.location.hash, '#account', 'Hash must be reset to #account');
    assert.strictEqual(winSuccess.location.cleanUrl, '/app/#account', 'Clean URL must not expose sensitive tokens');
    assert.strictEqual(accountModule._getPendingAuthHashNotice(), 'verified');

    let toastMessage = '';
    accountModule._setInjectedDeps({ localStorage: mockLocal, sessionStorage: mockSession });
    accountModule.attach({
      getState: () => ({ version: 1 }),
      replaceState: () => {},
      render: () => {},
      toast: msg => { toastMessage = msg; }
    });

    assert.strictEqual(toastMessage, '邮箱验证已完成，请使用邮箱与密码登录。');
    assert.strictEqual(accountModule._getPendingAuthHashNotice(), null, 'Notice must be cleared after display');
    assert.strictEqual(JSON.stringify(mockLocal._dump()).includes('sensitive'), false, 'Tokens must never be persisted');
    assert.strictEqual(JSON.stringify(mockSession._dump()).includes('sensitive'), false);

    // 2. 失败回跳包含 error 参数
    accountModule._resetForTesting();
    const winError = {
      location: {
        hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
        pathname: '/',
        search: ''
      },
      history: {
        replaceState: (_state, _title, url) => {
          winError.location.hash = url.slice(url.indexOf('#'));
        }
      }
    };

    accountModule.checkAndCleanAuthHash(winError);
    assert.strictEqual(winError.location.hash, '#account');
    assert.strictEqual(accountModule._getPendingAuthHashNotice(), 'error');

    toastMessage = '';
    accountModule.attach({
      getState: () => ({ version: 1 }),
      replaceState: () => {},
      render: () => {},
      toast: msg => { toastMessage = msg; }
    });
    assert.strictEqual(toastMessage, '邮箱验证链接无效或已过期，请重新登录。');
  });

  await test('15. handleMergeChoice generation/uid guard aborts in-flight merge if user logs out before state write', async () => {
    accountModule._resetForTesting();
    const mockLocal = createMockStorage();
    const mockSession = createMockStorage();

    global.CQUEST_CLOUD_CONFIG = { provider: 'supabase', url: 'https://test.supabase.co', publishableKey: 'anon-key-123' };

    mockLocal.setItem('c-quest-progress-v1', JSON.stringify({
      version: 1,
      answers: { q_guest_preserved: { attempts: 1 } },
      wrong: [],
      favorites: []
    }));

    let slowRemoteResolve;
    const slowRemotePromise = new Promise(r => { slowRemoteResolve = r; });

    accountModule._setInjectedDeps({
      fetch: async (url) => {
        if (url.includes('/auth/v1/user')) {
          return { ok: true, status: 200, json: async () => ({ id: 'uid_merge_user', email: 'merge@test.com' }) };
        }
        if (url.includes('/auth/v1/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'tok_merge',
              user: { id: 'uid_merge_user', email: 'merge@test.com' }
            })
          };
        }
        if (url.includes('/cquest_progress')) {
          await slowRemotePromise;
          return {
            ok: true,
            status: 200,
            json: async () => [{
              revision: 1,
              document: { schemaVersion: 1, answers: { q_remote_corrupt: { attempts: 99 } } }
            }]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      localStorage: mockLocal,
      sessionStorage: mockSession
    });

    let currentClientState = { version: 1, answers: { q_guest_preserved: { attempts: 1 } } };
    accountModule.attach({
      getState: () => currentClientState,
      replaceState: s => { currentClientState = s; },
      render: () => {},
      toast: () => {}
    });

    // 1. 用户登录，进入 pendingMerge 状态
    await accountModule.handleLogin(createMockForm({ email: 'merge@test.com', password: 'mypassword' }));
    assert.ok(accountModule._getState().pendingMerge, 'Must be in pendingMerge state');

    // 2. 用户点击合并，启动异步请求
    const mergePromise = accountModule.handleMergeChoice('merge');

    // 3. 在 GET 响应返回前，用户退出了账号！
    await accountModule.handleLogout();
    assert.strictEqual(accountModule._getState().currentUser, null);

    // 4. 此时慢速 GET /cquest_progress 响应返回
    slowRemoteResolve();
    await mergePromise;

    // 5. 校验：守卫生效，合并彻底作废，没有向游客或已退出状态写入用户数据
    assert.strictEqual(currentClientState.answers['q_remote_corrupt'], undefined, 'Remote corrupt data must not leak into client state');
    assert.ok(currentClientState.answers['q_guest_preserved'], 'Guest data must be cleanly preserved');
    assert.ok(mockLocal.getItem('c-quest-progress-v1').includes('q_guest_preserved'));
  });
}

runAll().then(() => {
  console.log(`\nAll ${testCount} tests passed successfully in test_account.cjs!`);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
