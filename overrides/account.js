/**
 * C 语言闯关营 · 云账户与云存档适配器 (account.js)
 * 实现 Supabase 认证、RLS 行级安全存档隔离、并发乐观锁重试、断网离线缓存与游客合并
 * 遵从 account-contract.md 与 account-review.md 规范
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sync-core.js'));
  } else {
    root.CQuestAccount = factory(root.CQuestSyncCore);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (syncCore) {
  'use strict';

  const GUEST_KEY = 'c-quest-progress-v1';

  // 依赖注入槽（用于 Node.js 单元测试与无浏览器环境验证）
  let injected = {
    fetch: typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    localStorage: typeof localStorage !== 'undefined' ? localStorage : null,
    sessionStorage: typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    now: () => Date.now(),
    timer: setTimeout
  };

  function getStorage(type) {
    if (type === 'session') return injected.sessionStorage;
    return injected.localStorage;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function blankState() {
    return {
      version: 1,
      answers: {},
      wrong: [],
      favorites: [],
      levels: {},
      days: [],
      session: null,
      drafts: {},
      selfChecks: {},
      teaching: {}
    };
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // 外部注入的 app.js 回调函数
  let appBridge = {
    getState: () => null,
    replaceState: () => {},
    render: () => {},
    toast: () => {}
  };

  // 账户系统内部状态
  let currentUser = null; // { id: uuid, email: string }
  let currentSession = null; // { access_token, refresh_token, expires_at }
  let status = 'unconfigured'; // 'unconfigured' | 'guest' | 'authenticating' | 'idle' | 'syncing' | 'offline' | 'conflict' | 'signup_pending'
  let statusMessage = '';
  let lastSyncTime = 0;
  let currentRevision = 0;
  let generationToken = 0; // 世代防竞态守卫
  let syncTimer = null;
  let isApplyingRemote = false; // 防止回声循环
  let isSyncing = false;
  let pendingMerge = null; // { user, session, guestState } 待决定是否合并游客进度
  let pendingAuthHashNotice = null; // 'verified' | 'error' | null 邮件回跳通知标记
  let singleFlightRefreshPromise = null;
  let lastLocalEditTime = 0;
  let lastSyncedLocalEditTime = 0;

  // 检查并清除 Supabase 邮件验证回跳 URL 中的敏感令牌与错误片段
  function checkAndCleanAuthHash(customEnv) {
    const win = customEnv || (typeof window !== 'undefined' ? window : null);
    if (!win || !win.location) return;
    const rawHash = win.location.hash || '';
    if (!rawHash) return;

    const hasAuthToken = /access_token=|refresh_token=/i.test(rawHash);
    const hasAuthError = /error=|error_code=|error_description=/i.test(rawHash);

    if (!hasAuthToken && !hasAuthError) return;

    // 严禁持久化保存回跳令牌，严禁打印日志，严禁展示原始 URL 或令牌
    if (hasAuthError) {
      pendingAuthHashNotice = 'error';
    } else {
      pendingAuthHashNotice = 'verified';
    }

    try {
      if (win.history && typeof win.history.replaceState === 'function') {
        const cleanUrl = (win.location.pathname || '/') + (win.location.search || '') + '#account';
        win.history.replaceState(null, '', cleanUrl);
      } else {
        win.location.hash = '#account';
      }
    } catch (e) {
      try { win.location.hash = '#account'; } catch (_) {}
    }

    if (appBridge && appBridge.toast) {
      if (pendingAuthHashNotice === 'verified') {
        appBridge.toast('邮箱验证已完成，请使用邮箱与密码登录。');
        pendingAuthHashNotice = null;
      } else if (pendingAuthHashNotice === 'error') {
        appBridge.toast('邮箱验证链接无效或已过期，请重新登录。');
        pendingAuthHashNotice = null;
      }
    }
  }

  // 启动即刻检查回跳片段（在浏览器环境中执行）
  checkAndCleanAuthHash();
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', () => checkAndCleanAuthHash());
  }

  function getCloudConfig() {
    const cfg = (typeof root !== 'undefined' && root.CQUEST_CLOUD_CONFIG) || (typeof globalThis !== 'undefined' && globalThis.CQUEST_CLOUD_CONFIG) || {};
    return {
      provider: cfg.provider || 'supabase',
      url: (cfg.url || '').trim().replace(/\/+$/, ''),
      publishableKey: (cfg.publishableKey || '').trim()
    };
  }

  function isCloudConfigured() {
    const cfg = getCloudConfig();
    if (!cfg.url || !cfg.publishableKey) return false;
    // 必须为 HTTPS
    if (!/^https:\/\//i.test(cfg.url)) return false;
    // 严禁填入 service_role 或 secret key
    if (/service_role|secret/i.test(cfg.publishableKey)) return false;
    return true;
  }

  // 获取云项目的 Namespace 标识，实现跨项目会话与存档隔离
  function getProjectNamespace() {
    const cfg = getCloudConfig();
    if (!cfg.url) return 'default';
    try {
      const u = new URL(cfg.url);
      const host = u.hostname.toLowerCase();
      const match = host.match(/^([a-z0-9_-]+)\.supabase\./);
      if (match) return match[1];
      return host.replace(/[^a-z0-9_-]/g, '_');
    } catch (e) {
      return 'default';
    }
  }

  function getAuthStorageKey() {
    return `cquest_auth_session_${getProjectNamespace()}`;
  }

  function getUserKey(userId) {
    return `c-quest-progress_${getProjectNamespace()}_u_${userId}`;
  }

  function getBaselineKey(userId) {
    return `c-quest-baseline_${getProjectNamespace()}_u_${userId}`;
  }

  function updateStatus(newStatus, msg) {
    status = newStatus;
    statusMessage = msg || '';
    dispatchStatusEvent();
  }

  function statusLabel() {
    if (!isCloudConfigured()) return '本机模式';
    if (pendingMerge) return '待处理存档';
    if (status === 'signup_pending') return '待验证邮箱';
    if (!currentUser) return '未登录';
    if (status === 'authenticating') return '正在验证...';
    if (status === 'syncing') return '正在同步...';
    if (status === 'offline') return '等待同步';
    if (status === 'conflict') return '版本冲突';
    if (status === 'idle') {
      // 只有真实完成过至少一次同步，且没有待上传的本地改动时，才宣称“云端已同步”
      if (lastSyncTime > 0 && lastLocalEditTime <= lastSyncedLocalEditTime) {
        return '云端已同步';
      }
      return '等待同步';
    }
    return '等待同步';
  }

  function dispatchStatusEvent() {
    const lbl = statusLabel();
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('cquest:account-status', {
          detail: { status, label: lbl }
        }));
      } catch (e) {
        // ignore in non-browser envs
      }
    }
  }

  // 安全清空表单中密码输入框（包括已切换为 text 显示的字段）
  function clearPasswordInputs(formEl) {
    if (!formEl) return;
    const inputs = formEl.querySelectorAll ? formEl.querySelectorAll('input[name="password"], input[type="password"]') : [];
    for (const input of inputs) {
      input.value = '';
      input.type = 'password';
    }
    // 兼容单个 querySelector
    const single = formEl.querySelector ? formEl.querySelector('input[name="password"]') : null;
    if (single) {
      single.value = '';
      single.type = 'password';
    }
  }

  // 封装安全 fetch：支持超时中止、redirect: 'error'
  async function safeFetch(url, options = {}, timeoutMs = 12000) {
    const fetchFn = injected.fetch;
    if (!fetchFn) throw new Error('Fetch not available');

    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timerId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const opts = {
        ...options,
        redirect: 'error',
        signal: controller ? controller.signal : undefined
      };
      return await fetchFn(url, opts);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  // 读取已保存的鉴权会话（优先 sessionStorage，次选 localStorage）
  function loadPersistedSession() {
    try {
      const authKey = getAuthStorageKey();
      const sessStorage = getStorage('session');
      const locStorage = getStorage('local');
      let raw = sessStorage?.getItem(authKey);
      let isRemembered = false;
      if (!raw) {
        raw = locStorage?.getItem(authKey);
        if (raw) isRemembered = true;
      }
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && data.access_token && data.user && data.user.id) {
        data.remember = isRemembered;
        return data;
      }
    } catch (e) {}
    return null;
  }

  function savePersistedSession(sessionData, remember) {
    const authKey = getAuthStorageKey();
    const sessStorage = getStorage('session');
    const locStorage = getStorage('local');
    const payload = JSON.stringify({
      access_token: sessionData.access_token,
      refresh_token: sessionData.refresh_token,
      expires_at: sessionData.expires_at || 0,
      user: {
        id: sessionData.user.id,
        email: sessionData.user.email
      }
    });

    if (remember) {
      locStorage?.setItem(authKey, payload);
      sessStorage?.removeItem(authKey);
    } else {
      sessStorage?.setItem(authKey, payload);
      locStorage?.removeItem(authKey);
    }
  }

  function clearPersistedSession() {
    try {
      const authKey = getAuthStorageKey();
      getStorage('session')?.removeItem(authKey);
      getStorage('local')?.removeItem(authKey);
    } catch (e) {}
  }

  // 检查本地是否存在游客有效进度
  function getGuestProgress() {
    try {
      const raw = getStorage('local')?.getItem(GUEST_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return null;
      const hasAnswers = parsed.answers && Object.keys(parsed.answers).length > 0;
      const hasWrong = Array.isArray(parsed.wrong) && parsed.wrong.length > 0;
      const hasFavs = Array.isArray(parsed.favorites) && parsed.favorites.length > 0;
      const hasLevels = parsed.levels && Object.keys(parsed.levels).length > 0;
      const hasDrafts = parsed.drafts && Object.values(parsed.drafts).some(t => (t || '').trim());
      if (hasAnswers || hasWrong || hasFavs || hasLevels || hasDrafts) {
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  // 初始化鉴权状态并异步向服务端校验用户真实身份
  function initAuth() {
    if (!isCloudConfigured()) {
      updateStatus('unconfigured', '云账户服务尚未配置');
      return;
    }

    const saved = loadPersistedSession();
    if (saved && saved.user) {
      currentUser = saved.user;
      currentSession = saved;
      updateStatus('idle', '已载入本地凭据，等待同步');

      // 异步通过 GET /auth/v1/user 校验身份合法性，并触发初始同步
      const initGen = generationToken;
      verifySessionUser(saved, initGen).then(verified => {
        if (verified && generationToken === initGen) {
          scheduleSync(100);
        }
      }).catch(() => {});
    } else {
      currentUser = null;
      currentSession = null;
      updateStatus('guest', '未登录');
    }
  }

  async function verifySessionUser(session, reqGen) {
    const cfg = getCloudConfig();
    if (!cfg.url || !session?.access_token) return false;
    try {
      const res = await safeFetch(`${cfg.url}/auth/v1/user`, {
        method: 'GET',
        headers: {
          'apikey': cfg.publishableKey,
          'Authorization': `Bearer ${session.access_token}`
        }
      });

      if (generationToken !== reqGen || currentSession !== session) return false;

      if (res.ok) {
        const verifiedUser = await res.json();
        if (generationToken !== reqGen || currentSession !== session) return false;
        if (verifiedUser && verifiedUser.id === session.user.id) {
          currentUser = verifiedUser;
          return true;
        }
      } else if (res.status === 401 && session.refresh_token) {
        const refreshed = await singleFlightRefresh();
        return refreshed;
      }
      // 凭据无效或用户身份不匹配：仅在会话仍是当前活动会话时注销
      if (generationToken === reqGen && currentSession === session) {
        handleLogout();
      }
      return false;
    } catch (e) {
      // 离线时不作废会话，保留离线状态
      if (generationToken === reqGen && currentSession === session) {
        updateStatus('offline', '离线模式，本地凭据有效');
      }
      return false;
    }
  }

  /**
   * 基础 Supabase REST 请求封装
   */
  async function supabaseRequest(endpoint, method, body, authRequired = false) {
    const cfg = getCloudConfig();
    if (!cfg.url || !cfg.publishableKey) {
      throw new Error('Supabase configuration missing');
    }

    const currentGen = generationToken;
    const currentUid = currentUser?.id;
    const currentSess = currentSession;
    const url = `${cfg.url}${endpoint}`;
    const headers = {
      'apikey': cfg.publishableKey,
      'Content-Type': 'application/json'
    };

    if (authRequired) {
      if (!currentSession?.access_token) {
        throw new Error('Authentication required');
      }
      headers['Authorization'] = `Bearer ${currentSession.access_token}`;
    }

    let res;
    try {
      res = await safeFetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (netErr) {
      if (generationToken === currentGen && currentUser?.id === currentUid) {
        updateStatus('offline', '网络连接失败，已保存至本地');
      }
      throw netErr;
    }

    // 世代与账号守卫：若在网络请求返回时用户已切换或退出，立即丢弃结果
    if (generationToken !== currentGen || (authRequired && (currentUser?.id !== currentUid || currentSession !== currentSess))) {
      const err = new Error('Request superseded by user account transition');
      err.superseded = true;
      throw err;
    }

    // 401 自动单飞刷新 token 并重试一次
    if (res.status === 401 && authRequired && currentSession?.refresh_token) {
      const refreshed = await singleFlightRefresh();
      if (refreshed) {
        if (generationToken !== currentGen || currentUser?.id !== currentUid) {
          const err = new Error('Request superseded by user account transition');
          err.superseded = true;
          throw err;
        }
        headers['Authorization'] = `Bearer ${currentSession.access_token}`;
        res = await safeFetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
        if (generationToken !== currentGen || currentUser?.id !== currentUid) {
          const err = new Error('Request superseded by user account transition');
          err.superseded = true;
          throw err;
        }
      }
    }

    return res;
  }

  // 单飞刷新 Token，防止多个并发请求重复触发刷新；具备全生命周期世代守卫
  async function singleFlightRefresh() {
    if (singleFlightRefreshPromise) return singleFlightRefreshPromise;

    const refreshGen = generationToken;
    const refreshUid = currentUser?.id;
    const targetSession = currentSession;

    if (!targetSession || !targetSession.refresh_token) return false;

    singleFlightRefreshPromise = (async () => {
      try {
        const cfg = getCloudConfig();
        const refreshUrl = `${cfg.url}/auth/v1/token?grant_type=refresh_token`;
        const res = await safeFetch(refreshUrl, {
          method: 'POST',
          headers: {
            'apikey': cfg.publishableKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ refresh_token: targetSession.refresh_token })
        });

        // 世代与账号守卫 1: 请求返回后校验
        if (generationToken !== refreshGen || currentUser?.id !== refreshUid || currentSession !== targetSession) {
          return false;
        }

        if (res.ok) {
          const data = await res.json();
          // 世代与账号守卫 2: json 解析后校验
          if (generationToken !== refreshGen || currentUser?.id !== refreshUid || currentSession !== targetSession) {
            return false;
          }
          currentSession.access_token = data.access_token;
          currentSession.refresh_token = data.refresh_token;
          currentSession.expires_at = injected.now() + (data.expires_in || 3600) * 1000;
          savePersistedSession(currentSession, currentSession.remember);
          return true;
        } else {
          // 刷新失败：仅当当前会话仍为发生刷新的会话时注销
          if (generationToken === refreshGen && currentUser?.id === refreshUid && currentSession === targetSession) {
            handleLogout();
            appBridge.toast('登录状态已过期，请重新登录。');
          }
          return false;
        }
      } catch (e) {
        return false;
      } finally {
        singleFlightRefreshPromise = null;
      }
    })();

    return singleFlightRefreshPromise;
  }

  /**
   * 核心接口 1：同步读取当前本地存储进度
   * 给 app.js 初始化 state 使用
   */
  function readLocalProgress() {
    const locStorage = getStorage('local');
    if (!locStorage) return null;

    if (!currentUser) {
      const saved = loadPersistedSession();
      if (saved && saved.user) {
        currentUser = saved.user;
        currentSession = saved;
      }
    }

    if (currentUser && currentUser.id) {
      const userKey = getUserKey(currentUser.id);
      const userRaw = locStorage.getItem(userKey);
      if (userRaw) return userRaw;
      return null;
    }

    // 游客读取默认全局 key
    return locStorage.getItem(GUEST_KEY);
  }

  /**
   * 核心接口 2：同步保存本地进度，并排队云端同步
   * 严格保障：账号 A 存档不落入游客或账号 B
   */
  function saveLocalProgress(state) {
    const locStorage = getStorage('local');
    if (!locStorage) {
      throw new Error('LocalStorage not available');
    }

    const stateStr = JSON.stringify(state);

    if (currentUser && currentUser.id) {
      locStorage.setItem(getUserKey(currentUser.id), stateStr);
    } else {
      locStorage.setItem(GUEST_KEY, stateStr);
    }

    // 如果是远程同步写回触发的本地保存：绝不修改 lastLocalEditTime，绝不触发回声同步
    if (isApplyingRemote) {
      return;
    }

    // 记录用户主动本地修改时间戳
    lastLocalEditTime = injected.now();

    // 已登录且配置可用时，调度后台防抖同步
    if (currentUser && isCloudConfigured() && !pendingMerge) {
      scheduleSync(600);
    }
  }

  /**
   * 核心接口 3：挂载 app.js 桥接能力
   */
  function attach(bridge) {
    appBridge = {
      getState: bridge.getState || (() => null),
      replaceState: bridge.replaceState || (() => {}),
      render: bridge.render || (() => {}),
      toast: bridge.toast || (() => {})
    };

    // 如果检测到邮件验证回跳已完成清理，提示用户使用邮箱密码登录
    if (pendingAuthHashNotice === 'verified') {
      appBridge.toast('邮箱验证已完成，请使用邮箱与密码登录。');
      pendingAuthHashNotice = null;
    } else if (pendingAuthHashNotice === 'error') {
      appBridge.toast('邮箱验证链接无效或已过期，请重新登录。');
      pendingAuthHashNotice = null;
    }

    initAuth();
  }

  function scheduleSync(delayMs) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = injected.timer(() => {
      syncTimer = null;
      syncWithCloud().catch(() => {});
    }, delayMs || 500);
  }

  /**
   * 核心云同步流程 (乐观并发重试 + LWW 合并 + 在途新答题强保全)
   */
  async function syncWithCloud(retryCount = 0) {
    if (!isCloudConfigured() || !currentUser || !currentSession || pendingMerge) {
      return;
    }
    if (isSyncing) return;
    isSyncing = true;
    updateStatus('syncing', '正在与云端同步...');

    const myGen = generationToken;
    const myUid = currentUser.id;
    // 捕获请求发起时的本地编辑时间戳快照与 state 深拷贝
    const syncSnapshotTime = lastLocalEditTime;
    const startLocalState = deepClone(appBridge.getState() || JSON.parse(readLocalProgress() || '{}'));

    try {
      // 1. 获取云端当前版本与文档
      const getRes = await supabaseRequest(
        `/rest/v1/cquest_progress?select=revision,document,updated_at&user_id=eq.${myUid}`,
        'GET',
        null,
        true
      );

      if (!getRes.ok) {
        throw new Error(`Failed to fetch cloud progress (HTTP ${getRes.status})`);
      }

      const rows = await getRes.json();
      if (generationToken !== myGen || currentUser?.id !== myUid) return;

      const remoteRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      const remoteRevision = remoteRow ? Number(remoteRow.revision) || 0 : 0;
      currentRevision = remoteRevision;
      const remoteDoc = remoteRow ? remoteRow.document : null;

      // 2. 读取基线文档（上次成功同步时的快照），用于推导 tombstone
      let baselineDoc = null;
      try {
        const rawBase = getStorage('local')?.getItem(getBaselineKey(myUid));
        if (rawBase) baselineDoc = JSON.parse(rawBase);
      } catch (e) {}

      // 将请求发起时的快照转为带有增量与墓碑的云文档
      const localDoc = syncCore.stateToDocument(startLocalState, baselineDoc, { now: injected.now() });

      // 3. 执行合并 (LWW + 增量计数 + 草稿冲突保留)
      let finalDocToSave;
      if (remoteDoc) {
        finalDocToSave = syncCore.mergeProgress(localDoc, remoteDoc, { now: injected.now() });
      } else {
        finalDocToSave = syncCore.sanitizeForCloud(localDoc);
      }

      // 4. 调用 Supabase RPC: cquest_save_progress
      const saveRes = await supabaseRequest(
        '/rest/v1/rpc/cquest_save_progress',
        'POST',
        {
          expected_revision: remoteRevision,
          payload: finalDocToSave
        },
        true
      );

      if (generationToken !== myGen || currentUser?.id !== myUid) return;

      if (saveRes.status === 409 || saveRes.status === 400) {
        // 409 乐观锁冲突：远端已被其他设备修改
        const errJson = await saveRes.json().catch(() => ({}));
        if (errJson.message && errJson.message.includes('Progress changed') && retryCount < 3) {
          updateStatus('conflict', '检测到其他设备更新，正在重新合并...');
          isSyncing = false;
          return await syncWithCloud(retryCount + 1);
        }
        throw new Error(`Concurrency conflict: ${errJson.message || '409 Conflict'}`);
      }

      if (!saveRes.ok) {
        throw new Error(`Cloud save RPC failed (HTTP ${saveRes.status})`);
      }

      const saveResult = await saveRes.json();
      if (generationToken !== myGen || currentUser?.id !== myUid) return;

      const newRev = Array.isArray(saveResult) && saveResult[0] ? saveResult[0].revision : remoteRevision + 1;
      currentRevision = Number(newRev) || (remoteRevision + 1);

      // 5. 保存最新云端基线快照
      getStorage('local')?.setItem(getBaselineKey(myUid), JSON.stringify(finalDocToSave));

      // 6. 重算当前 liveState，保证在途新答题绝对不被旧快照抹去
      const currentLiveState = appBridge.getState() || {};
      let finalState;

      if (lastLocalEditTime > syncSnapshotTime) {
        // 请求在途期间用户在当前设备做出了新答题或新修改：
        // 以刚上传成功的 finalDocToSave 为基准，提取 liveState 中的最新增量并重新合并
        const inFlightDoc = syncCore.stateToDocument(currentLiveState, finalDocToSave, { now: injected.now() });
        const reconciledDoc = syncCore.mergeProgress(inFlightDoc, finalDocToSave, { now: injected.now() });
        finalState = syncCore.documentToState(reconciledDoc, currentLiveState);
      } else {
        finalState = syncCore.documentToState(finalDocToSave, currentLiveState);
      }

      // 7. 更新本地存储与 application state（无回声）
      isApplyingRemote = true;
      try {
        saveLocalProgress(finalState);
        appBridge.replaceState(finalState);
      } finally {
        isApplyingRemote = false;
      }

      lastSyncTime = injected.now();
      lastSyncedLocalEditTime = syncSnapshotTime;

      // 检查在网络请求期间本地是否产生过新答题
      if (lastLocalEditTime > syncSnapshotTime) {
        // 本地在同步过程中有新修改，立即排队下一轮同步上传新题
        updateStatus('syncing', '正在上传在途新答题...');
        scheduleSync(300);
      } else {
        updateStatus('idle', '云端已同步');
      }

    } catch (err) {
      if (err.superseded) return;
      if (generationToken === myGen && currentUser?.id === myUid) {
        if (status !== 'offline') {
          updateStatus('offline', err.message || '同步遇到异常，已转为本机存储');
        }
      }
    } finally {
      isSyncing = false;
    }
  }

  /**
   * 表单与交互方法 1: 登录
   */
  async function handleLogin(formEl) {
    if (!isCloudConfigured()) {
      appBridge.toast('尚未配置云端服务，当前处于本地离线模式。');
      return;
    }

    const formData = new FormData(formEl);
    const email = (formData.get('email') || '').toString().trim();
    const password = (formData.get('password') || '').toString();
    const remember = Boolean(formData.get('remember'));

    // 立即清空密码输入框（包括显示状态下的密码）
    clearPasswordInputs(formEl);

    if (!email || !password) {
      appBridge.toast('请填写完整的邮箱与密码。');
      return;
    }

    updateStatus('authenticating', '正在验证登录信息...');
    appBridge.render();

    const reqGen = generationToken;
    try {
      const cfg = getCloudConfig();
      const loginUrl = `${cfg.url}/auth/v1/token?grant_type=password`;
      const res = await safeFetch(loginUrl, {
        method: 'POST',
        headers: {
          'apikey': cfg.publishableKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      if (generationToken !== reqGen) return;

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (generationToken !== reqGen) return;
        const errMsg = errData.error_description || errData.msg || errData.message || '邮箱或密码错误';
        updateStatus('guest', errMsg);
        appBridge.toast('登录失败：' + errMsg);
        appBridge.render();
        return;
      }

      const data = await res.json();
      if (generationToken !== reqGen) return;

      const user = data.user;
      const session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: injected.now() + (data.expires_in || 3600) * 1000,
        user,
        remember
      };

      generationToken++; // 成功登录开启新世代
      currentUser = user;
      currentSession = session;
      savePersistedSession(session, remember);

      // 检查本机是否存在游客数据
      const guestProgress = getGuestProgress();
      if (guestProgress) {
        pendingMerge = { user, session, guestProgress };
        updateStatus('idle', '请选择是否合并本机游客记录');
        appBridge.toast('登录成功！检测到本机有做题记录，请选择是否合并。');
        appBridge.render();
        return;
      }

      // 无游客记录，直接切入该用户独立本地存档并同步云端
      const existingUserRaw = getStorage('local')?.getItem(getUserKey(user.id));
      const userState = existingUserRaw ? JSON.parse(existingUserRaw) : blankState();
      isApplyingRemote = true;
      try {
        appBridge.replaceState(userState);
      } finally {
        isApplyingRemote = false;
      }

      updateStatus('idle', '登录成功');
      appBridge.toast('登录成功，正在同步云端存档...');
      await syncWithCloud();
      appBridge.render();

    } catch (err) {
      if (generationToken === reqGen) {
        updateStatus('guest', '网络请求失败');
        appBridge.toast('登录遇到网络错误，请稍后重试。');
        appBridge.render();
      }
    }
  }

  /**
   * 表单与交互方法 2: 注册
   */
  async function handleSignup(formEl) {
    if (!isCloudConfigured()) {
      appBridge.toast('尚未配置云端服务。');
      return;
    }

    const formData = new FormData(formEl);
    const email = (formData.get('email') || '').toString().trim();
    const password = (formData.get('password') || '').toString();
    const remember = Boolean(formData.get('remember'));

    clearPasswordInputs(formEl);

    if (!email || !password) {
      appBridge.toast('请填写完整的邮箱与密码。');
      return;
    }
    if (password.length < 6) {
      appBridge.toast('密码长度不能少于 6 位。');
      return;
    }

    updateStatus('authenticating', '正在注册账号...');
    appBridge.render();

    const reqGen = generationToken;
    try {
      const cfg = getCloudConfig();
      // The site is hosted below a repository path, not at the domain root.
      // Explicitly retain that path even if the project's default Site URL drifts.
      const emailRedirect = 'https://3277683939.github.io/c-language-quest/';
      const signupUrl = `${cfg.url}/auth/v1/signup?redirect_to=${encodeURIComponent(emailRedirect)}`;
      const res = await safeFetch(signupUrl, {
        method: 'POST',
        headers: {
          'apikey': cfg.publishableKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      if (generationToken !== reqGen) return;

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (generationToken !== reqGen) return;
        const errMsg = errData.msg || errData.message || '注册未能完成';
        updateStatus('guest', errMsg);
        appBridge.toast('注册失败：' + errMsg);
        appBridge.render();
        return;
      }

      const data = await res.json();
      if (generationToken !== reqGen) return;

      // 有 user 无 session 表示需要邮箱确认
      if (data.user && !data.session && !data.access_token) {
        updateStatus('signup_pending', '请查收验证邮件，验证后登录');
        appBridge.toast('请查收验证邮件，验证后登录。');
        appBridge.render();
        return;
      }

      const user = data.user;
      const session = {
        access_token: data.access_token || data.session?.access_token,
        refresh_token: data.refresh_token || data.session?.refresh_token,
        expires_at: injected.now() + ((data.expires_in || 3600) * 1000),
        user,
        remember
      };

      generationToken++;
      currentUser = user;
      currentSession = session;
      savePersistedSession(session, remember);

      const guestProgress = getGuestProgress();
      if (guestProgress) {
        pendingMerge = { user, session, guestProgress };
        updateStatus('idle', '请选择是否合并本机游客记录');
        appBridge.toast('注册成功！检测到本机已有做题记录，请选择是否合并。');
        appBridge.render();
        return;
      }

      const userState = blankState();
      isApplyingRemote = true;
      try {
        appBridge.replaceState(userState);
      } finally {
        isApplyingRemote = false;
      }

      updateStatus('idle', '注册并登录成功');
      appBridge.toast('注册并登录成功！');
      await syncWithCloud();
      appBridge.render();

    } catch (err) {
      if (generationToken === reqGen) {
        updateStatus('guest', '网络请求失败');
        appBridge.toast('注册遇到网络错误，请稍后重试。');
        appBridge.render();
      }
    }
  }

  /**
   * 表单与交互方法 3: 处理游客进度合并选择
   * @param {'merge' | 'replace'} choice
   */
  async function handleMergeChoice(choice) {
    if (!pendingMerge) return;

    const { user, guestProgress } = pendingMerge;
    pendingMerge = null;

    const mergeGen = generationToken;
    const mergeUid = user.id;

    if (choice === 'merge') {
      // 合并游客进度到账号
      appBridge.toast('正在合并本机游客记录到账号...');

      // 1. 读取远端存档（如果有）
      let remoteDoc = null;
      try {
        const getRes = await supabaseRequest(
          `/rest/v1/cquest_progress?select=revision,document,updated_at&user_id=eq.${user.id}`,
          'GET',
          null,
          true
        );
        // GET await 之后增加 generation/uid 守卫，防止在途用户退出或换号
        if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

        if (getRes.ok) {
          const rows = await getRes.json();
          // json() 解析后增加 generation/uid 守卫
          if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

          if (Array.isArray(rows) && rows[0]) {
            currentRevision = Number(rows[0].revision) || 0;
            remoteDoc = rows[0].document;
          }
        }
      } catch (e) {
        if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;
      }

      // 保存账号 state 前增加 generation/uid 守卫
      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

      // 2. 将游客 state 转为云文档，与远端合并
      const guestDoc = syncCore.stateToDocument(guestProgress, null, { now: injected.now() });
      let mergedDoc = guestDoc;
      if (remoteDoc) {
        mergedDoc = syncCore.mergeProgress(guestDoc, remoteDoc, { now: injected.now() });
      }

      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

      // 3. 存入账号独立存储与 state
      const mergedState = syncCore.documentToState(mergedDoc, guestProgress);
      isApplyingRemote = true;
      try {
        saveLocalProgress(mergedState);
        appBridge.replaceState(mergedState);
      } finally {
        isApplyingRemote = false;
      }

      // 状态变更后再次核验
      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

      // 注意：保留 GUEST_KEY 作为游客独立本地备份，绝不删除！

      // 4. 上传云端
      try {
        await syncWithCloud();
        if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;
        if (status === 'idle') {
          appBridge.toast('已成功将游客进度合并至您的云账号！');
        } else {
          appBridge.toast('已在本机合并记录，网络恢复后将同步至云端。');
        }
      } catch (err) {
        if (generationToken === mergeGen && currentUser?.id === mergeUid) {
          appBridge.toast('已在本机合并记录，网络恢复后将同步至云端。');
        }
      }

    } else {
      // 仅使用账号原有存档：先核验守卫
      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

      let accountState = blankState();
      try {
        const rawAcc = getStorage('local')?.getItem(getUserKey(user.id));
        if (rawAcc) accountState = JSON.parse(rawAcc);
      } catch (e) {}

      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

      isApplyingRemote = true;
      try {
        saveLocalProgress(accountState);
        appBridge.replaceState(accountState);
      } finally {
        isApplyingRemote = false;
      }

      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;

      appBridge.toast('正在载入账号原有存档...');
      await syncWithCloud();
      if (generationToken !== mergeGen || currentUser?.id !== mergeUid) return;
      appBridge.toast('已切换为账号存档。');
    }

    if (generationToken === mergeGen && currentUser?.id === mergeUid) {
      appBridge.render();
    }
  }

  /**
   * 表单与交互方法 4: 退出登录
   */
  async function handleLogout() {
    generationToken++; // 作废所有属于该用户的在途请求
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }

    const cfg = getCloudConfig();
    const token = currentSession?.access_token;

    currentUser = null;
    currentSession = null;
    pendingMerge = null;
    clearPersistedSession();
    updateStatus('guest', '已退出登录');

    // 发起一次本地注销通知（不阻塞主流程）
    if (token && cfg.url) {
      safeFetch(`${cfg.url}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          'apikey': cfg.publishableKey,
          'Authorization': `Bearer ${token}`
        }
      }).catch(() => {});
    }

    // 恢复游客存档
    let guestState = null;
    try {
      const rawGuest = getStorage('local')?.getItem(GUEST_KEY);
      if (rawGuest) guestState = JSON.parse(rawGuest);
    } catch (e) {}

    isApplyingRemote = true;
    try {
      if (guestState && guestState.version === 1) {
        appBridge.replaceState(guestState);
      } else {
        appBridge.replaceState(blankState());
      }
    } finally {
      isApplyingRemote = false;
    }

    appBridge.toast('已退出账号，当前已恢复本机游客记录。');
    appBridge.render();
  }

  /**
   * 手动触发同步
   */
  async function handleSyncNow() {
    if (!currentUser) {
      appBridge.toast('请先登录账号后再执行云端同步。');
      return;
    }
    appBridge.toast('正在执行云端同步...');
    await syncWithCloud();
    appBridge.render();
  }

  /**
   * 密码可见性切换
   */
  function togglePasswordVisibility(btn) {
    const field = btn.closest ? btn.closest('.account-field') : btn.parentElement?.parentElement;
    if (!field) return;
    const input = field.querySelector('input[name="password"]');
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = '🙈 隐藏';
      btn.setAttribute('aria-label', '隐藏密码');
    } else {
      input.type = 'password';
      btn.textContent = '👁 显示';
      btn.setAttribute('aria-label', '显示密码');
    }
  }

  /**
   * 渲染账户主界面
   */
  function render() {
    const el = (typeof document !== 'undefined') ? document.getElementById('app') : null;
    if (!el) return;

    const state = appBridge.getState() || {};
    const answeredCount = Object.keys(state.answers || {}).length;
    const passedLevelsCount = Object.values(state.levels || {}).filter(l => l && l.passed).length;
    const wrongCount = Array.isArray(state.wrong) ? state.wrong.length : 0;
    const favCount = Array.isArray(state.favorites) ? state.favorites.length : 0;
    const lastSyncStr = lastSyncTime > 0
      ? new Date(lastSyncTime).toLocaleString('zh-CN', { hour12: false })
      : '尚未同步';

    const configured = isCloudConfigured();

    let html = `
      <div class="account-container">
        <div class="account-header">
          <div>
            <h1>云端学习记录与账户</h1>
            <p>登录账号后，在不同电脑或手机间同步刷题进度、收藏夹和错题本。</p>
          </div>
          <div class="account-badge-wrap">
            <span class="account-status-badge ${status}">${esc(statusLabel())}</span>
          </div>
        </div>
    `;

    // 1. 若检测到待处理的游客合并
    if (pendingMerge) {
      html += `
        <div class="account-card account-banner-card">
          <div class="account-banner-head">
            <span class="account-banner-icon">⚡</span>
            <div>
              <h3>检测到本机存有游客练习记录</h3>
              <p>您登录了账号 <strong>${esc(pendingMerge.user.email)}</strong>。本机目前存有已练习的题面与错题，请选择处理方式：</p>
            </div>
          </div>
          <div class="account-merge-actions">
            <button class="primary" onclick="window.CQuestAccount.handleMergeChoice('merge')">
              合并本机进度到云账号 (推荐)
            </button>
            <button class="quiet" onclick="window.CQuestAccount.handleMergeChoice('replace')">
              仅使用账号存档 (保留本机独立备份)
            </button>
          </div>
        </div>
      `;
    }

    // 2. 统计概览卡片
    html += `
      <div class="account-card">
        <div class="account-card-title">
          <h3>当前设备练习状态</h3>
          <small>记录保存在本机与你的云端账号中</small>
        </div>
        <div class="account-stat-grid">
          <div class="account-stat-item">
            <span class="account-stat-num">${answeredCount}</span>
            <span class="account-stat-label">已练题目</span>
          </div>
          <div class="account-stat-item">
            <span class="account-stat-num">${passedLevelsCount}</span>
            <span class="account-stat-label">通关关卡</span>
          </div>
          <div class="account-stat-item">
            <span class="account-stat-num">${wrongCount}</span>
            <span class="account-stat-label">错题记录</span>
          </div>
          <div class="account-stat-item">
            <span class="account-stat-num">${favCount}</span>
            <span class="account-stat-label">收藏题目</span>
          </div>
        </div>
        <div class="account-sync-meta">
          <span>上次云端同步时间：<strong>${esc(lastSyncStr)}</strong></span>
          ${currentUser ? `<span class="account-user-pill">已登录账号：${esc(currentUser.email)}</span>` : ''}
        </div>
      </div>
    `;

    // 3. 核心账户动作区
    if (!configured) {
      html += `
        <div class="account-card account-unconfigured-card">
          <div class="account-unconfigured-icon">ℹ</div>
          <h3>云账户服务尚未开启</h3>
          <p>当前网站尚未配置云端服务。做题记录、错题、收藏和草稿均保存在当前浏览器中，可正常练习。</p>
          <div class="account-local-actions">
            <button class="primary" onclick="location.hash='progress'">前往“学习记录”导出备份文件</button>
          </div>
        </div>
      `;
    } else if (currentUser) {
      html += `
        <div class="account-card">
          <div class="account-card-title">
            <h3>云端连接与同步管理</h3>
            <span class="account-card-status">${currentUser.app_metadata?.cquest_role === 'admin' ? '网站管理员 · ' : ''}已连接个人云存档</span>
          </div>
          <p class="account-info-text">
            您已成功登录 <strong>${esc(currentUser.email)}</strong>。系统会在答题或修改时自动同步；若网络波动，本地将自动暂存并在连通后合并。
          </p>
          <div class="account-actions-row">
            <button class="primary" onclick="window.CQuestAccount.handleSyncNow()" ${isSyncing ? 'disabled' : ''}>
              ${isSyncing ? '正在同步中...' : '立即同步到云端 ↻'}
            </button>
            <button class="quiet danger-btn" onclick="window.CQuestAccount.handleLogout()">
              退出当前账号
            </button>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="account-grid-forms">
          <!-- 登录表单 -->
          <div class="account-card">
            <div class="account-card-title">
              <h3>登录已有账号</h3>
              <small>跨设备同步您的所有进度</small>
            </div>
            <form class="account-form" onsubmit="event.preventDefault(); window.CQuestAccount.handleLogin(this)">
              <div class="account-field">
                <label>电子邮箱</label>
                <input type="email" name="email" required autocomplete="username" placeholder="your@email.com">
              </div>
              <div class="account-field">
                <div class="account-field-head">
                  <label>密码</label>
                  <button type="button" class="account-toggle-pass" onclick="window.CQuestAccount.togglePasswordVisibility(this)">👁 显示</button>
                </div>
                <input type="password" name="password" required minlength="6" autocomplete="current-password" placeholder="请输入密码">
              </div>
              <div class="account-checkbox">
                <label>
                  <input type="checkbox" name="remember" checked>
                  记住登录状态（在当前设备持久保留）
                </label>
              </div>
              <div class="account-form-actions">
                <button type="submit" class="primary account-submit-btn">立即登录 ↗</button>
              </div>
            </form>
          </div>

          <!-- 注册表单 -->
          <div class="account-card">
            <div class="account-card-title">
              <h3>注册新账号</h3>
              <small>开通个人云端刷题进度</small>
            </div>
            <form class="account-form" onsubmit="event.preventDefault(); window.CQuestAccount.handleSignup(this)">
              <div class="account-field">
                <label>电子邮箱</label>
                <input type="email" name="email" required autocomplete="username" placeholder="your@email.com">
              </div>
              <div class="account-field">
                <div class="account-field-head">
                  <label>设置密码（至少 6 位）</label>
                  <button type="button" class="account-toggle-pass" onclick="window.CQuestAccount.togglePasswordVisibility(this)">👁 显示</button>
                </div>
                <input type="password" name="password" required minlength="6" autocomplete="new-password" placeholder="不少于6位密码">
              </div>
              <div class="account-checkbox">
                <label>
                  <input type="checkbox" name="remember" checked>
                  注册后自动记住登录状态
                </label>
              </div>
              <p class="account-mail-tip" style="font-size:11px;color:#7a8780;line-height:1.6;margin:4px 0 8px;">
                说明：当前默认邮件服务仅支持项目团队邮箱，其他邮箱需配置邮件服务方可收到验证邮件。
              </p>
              <div class="account-form-actions">
                <button type="submit" class="secondary account-submit-btn">注册新账号 ✦</button>
              </div>
            </form>
          </div>
        </div>
      `;
    }

    // 4. 底部离线备份保障（任何情况下均可使用）
    html += `
        <div class="account-card account-backup-footer">
          <div class="account-card-title">
            <h3>离线备份与迁移</h3>
            <small>无需依赖云端，自由掌控你的学习数据</small>
          </div>
          <p class="account-info-text">
            您可以随时将当前浏览器保存的学习记录完整导出为 JSON 文件，或者将之前备份的文件导入恢复。
          </p>
          <div class="account-backup-buttons">
            <button class="quiet" onclick="location.hash='progress'">打开学习记录导出/导入页面 ▤</button>
          </div>
        </div>
      </div>
    `;

    el.innerHTML = html;
  }

  // 暴露给单元测试的内部辅助注入
  function _setInjectedDeps(deps) {
    injected = { ...injected, ...deps };
  }

  function _getState() {
    return {
      currentUser,
      currentSession,
      status,
      statusMessage,
      pendingMerge,
      currentRevision,
      generationToken,
      lastSyncTime,
      lastLocalEditTime,
      lastSyncedLocalEditTime
    };
  }

  let resetCounter = 0;
  function _resetForTesting() {
    currentUser = null;
    currentSession = null;
    status = 'unconfigured';
    statusMessage = '';
    pendingMerge = null;
    currentRevision = 0;
    generationToken = ++resetCounter * 1000;
    lastSyncTime = 0;
    lastLocalEditTime = 0;
    lastSyncedLocalEditTime = 0;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    singleFlightRefreshPromise = null;
    isApplyingRemote = false;
    isSyncing = false;
    appBridge = null;
    pendingAuthHashNotice = null;
  }

  return {
    readLocalProgress,
    saveLocalProgress,
    attach,
    render,
    statusLabel,
    handleLogin,
    handleSignup,
    handleLogout,
    handleSyncNow,
    handleMergeChoice,
    togglePasswordVisibility,
    isCloudConfigured,
    checkAndCleanAuthHash,
    _getPendingAuthHashNotice: () => pendingAuthHashNotice,
    _setPendingAuthHashNotice: (v) => { pendingAuthHashNotice = v; },
    _setInjectedDeps,
    _getState,
    _resetForTesting
  };
});
