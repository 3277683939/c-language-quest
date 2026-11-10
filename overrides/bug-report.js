/* 手机 Bug 收集器前端模块 (Bug Report & Admin UI) */
(() => {
  'use strict';

  const DRAFT_KEY = 'cquest-bug-draft-v1';
  const CATEGORIES = ['按钮', '显示', '题目内容', '注册登录', '其他'];

  // 背景滚动锁由 overrides/ui.js 的通用 dialog 锁统一处理（按 dialog[open] 计数、
  // 支持嵌套弹窗、移动端生效、关闭最后一层时精确恢复 scrollY）。
  // 这里不再重复加锁，避免两套锁互相恢复滚动位置。

  // 粗粒度浏览器提取，绝不泄露完整 UA 或指纹
  function getRoughBrowser() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/MicroMessenger/i.test(ua)) return 'WeChat';
    if (/HuaweiBrowser/i.test(ua)) return 'Huawei';
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
    if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    return 'Other';
  }

  // 云端 questionId 白名单只接受 ^[A-Za-z0-9:_-]{0,100}$（见 cloud/bug-reports.sql）。
  // 自练单元 id 形如 self:h:1:基础篇:填空题:1，含中文，直接提交会被前后端白名单丢弃/拒绝，
  // 这里做可逆 ASCII 编码：白名单字符原样保留，其余字符写成 _<十六进制码点>（基础篇 => _57fa_7840_7bc7）。
  function encodeQuestionId(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    let out = '';
    for (const ch of raw) {
      out += /^[A-Za-z0-9:_-]$/.test(ch) ? ch : '_' + ch.codePointAt(0).toString(16);
      if (out.length > 100) break;
    }
    return out.slice(0, 100);
  }

  // 安全清洗 context：只含 page/模式/题号/位置/屏幕尺寸/粗粒度浏览器名称
  // 严禁完整URL、UA、邮箱、答案、草稿或Key
  function sanitizeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const clean = {};
    const allowed = {page:['map','random','wrong','favorites','practice','coach','library','progress','account','leaderboard','feedback'],mode:['choice','practice','page'],browser:['WeChat','Huawei','Edge','Chrome','Firefox','Safari','Other']};
    for (const key of Object.keys(allowed)) if (allowed[key].includes(raw[key])) clean[key]=raw[key];
    const qid = encodeQuestionId(raw.questionId);
    if (qid) clean.questionId=qid;
    if (Number.isInteger(raw.position) && raw.position>=0 && raw.position<=999999) clean.position=raw.position;
    const v=raw.viewport || {width:window.innerWidth,height:window.innerHeight};
    if (Number.isInteger(v.width) && Number.isInteger(v.height) && v.width>0 && v.height>0 && v.width<=10000 && v.height<=10000) clean.viewport={width:v.width,height:v.height};
    clean.browser ||= getRoughBrowser();
    return clean;
  }

  // 展示用上下文：题号仍显示用户可读的原始值；提交给云端时使用 sanitizeContext 编码后的值
  function contextParts(ctx) {
    if (!ctx) return [];
    const parts = [];
    if (ctx.page) parts.push(`页面: ${ctx.page}`);
    if (ctx.mode) parts.push(`模式: ${ctx.mode}`);
    if (ctx.questionId != null) parts.push(`题号: ${ctx.questionId}`);
    if (ctx.position != null) parts.push(`位置: ${ctx.position}`);
    if (ctx.viewport) parts.push(`屏幕: ${ctx.viewport.width}×${ctx.viewport.height}`);
    if (ctx.browser) parts.push(`浏览器: ${ctx.browser}`);
    return parts;
  }

  function contextLine(ctx) {
    return `附带信息: ${contextParts(ctx).join(' | ') || '无'}`;
  }

  // 生成随机 reportId
  function generateReportId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try {
        return crypto.randomUUID();
      } catch {}
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16);});
  }

  // 读取独立草稿（仅 category, description, reportId）
  function loadDraft() {
    try {
      const data = localStorage.getItem(DRAFT_KEY);
      if (!data) return null;
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        category: CATEGORIES.includes(parsed.category) ? parsed.category : CATEGORIES[0],
        description: typeof parsed.description === 'string' ? parsed.description.slice(0,2000) : '',
        reportId: typeof parsed.reportId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parsed.reportId) ? parsed.reportId : generateReportId()
      };
    } catch {
      return null;
    }
  }

  // 保存独立草稿（绝不保存 context/账号/题目等）
  function saveDraft(category, description, reportId) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ category, description, reportId }));
    } catch {}
  }

  // 清除独立草稿
  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }

  // 复制文本辅助函数
  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }

  let currentContext = null;
  // 展示用副本（题号保留原始中文 id），提交时用 currentContext 的 ASCII 编码值
  let currentContextDisplay = null;
  let activeReportId = null;
  let dialogElement = null;
  let submitting = false;
  let attempted = false;

  // 构造/获取原生 Dialog
  function ensureDialog() {
    if (dialogElement && document.body.contains(dialogElement)) {
      return dialogElement;
    }
    const existing = document.getElementById('cquest-bug-dialog');
    if (existing) {
      dialogElement = existing;
      return dialogElement;
    }

    const dialog = document.createElement('dialog');
    dialog.id = 'cquest-bug-dialog';
    dialog.className = 'cquest-bug-dialog';
    dialog.setAttribute('aria-labelledby', 'cquest-bug-title');

    dialog.innerHTML = `
      <div class="cquest-bug-header">
        <h2 id="cquest-bug-title">问题与反馈</h2>
        <button type="button" class="cquest-bug-close" aria-label="关闭">&times;</button>
      </div>
      <div class="cquest-bug-notice">
        <span>反馈仅站点管理员可见，请不要填写密码、验证码或其他个人隐私。</span>
      </div>
      <form id="cquest-bug-form" class="cquest-bug-form" novalidate>
        <div class="cquest-bug-field">
          <label for="cquest-bug-category">问题类别</label>
          <select id="cquest-bug-category" name="category" required>
            ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="cquest-bug-field">
          <div class="cquest-bug-label-row">
            <label for="cquest-bug-desc">问题描述（10 ~ 2000 字）</label>
            <span id="cquest-bug-counter" class="cquest-bug-counter">0 / 2000</span>
          </div>
          <textarea id="cquest-bug-desc" name="description" rows="5" placeholder="请详细描述遇到的问题、现象或复现步骤（至少10个字符）..." required minlength="10" maxlength="2000"></textarea>
          <div id="cquest-bug-hint" class="cquest-bug-hint">还需输入至少 10 个字</div>
        </div>
        <div class="cquest-bug-field">
          <label class="cquest-bug-checkbox-label">
            <input type="checkbox" id="cquest-bug-attach-ctx" checked>
            <span>附带页面、题号、屏幕尺寸与浏览器类型，便于复现问题。</span>
          </label>
          <div id="cquest-bug-ctx-preview" class="cquest-bug-ctx-preview"></div>
        </div>
        <div id="cquest-bug-status" class="cquest-bug-status" role="status" aria-live="polite"></div>
        <div class="cquest-bug-actions">
          <button type="button" id="cquest-bug-copy" class="secondary cquest-bug-btn">复制反馈文本</button>
          <button type="button" id="cquest-bug-cancel" class="secondary cquest-bug-btn">取消</button>
          <button type="submit" id="cquest-bug-submit" class="primary cquest-bug-btn" disabled>提交反馈</button>
        </div>
      </form>
    `;

    document.body.appendChild(dialog);
    dialogElement = dialog;

    const form = dialog.querySelector('#cquest-bug-form');
    const closeBtn = dialog.querySelector('.cquest-bug-close');
    const cancelBtn = dialog.querySelector('#cquest-bug-cancel');
    const descInput = dialog.querySelector('#cquest-bug-desc');
    const catSelect = dialog.querySelector('#cquest-bug-category');
    const counter = dialog.querySelector('#cquest-bug-counter');
    const hint = dialog.querySelector('#cquest-bug-hint');
    const submitBtn = dialog.querySelector('#cquest-bug-submit');
    const copyBtn = dialog.querySelector('#cquest-bug-copy');
    const attachCheckbox = dialog.querySelector('#cquest-bug-attach-ctx');
    const ctxPreview = dialog.querySelector('#cquest-bug-ctx-preview');
    const statusDiv = dialog.querySelector('#cquest-bug-status');

    function updatePreview() {
      if (!attachCheckbox.checked || !currentContext) {
        ctxPreview.style.display = 'none';
        ctxPreview.textContent = '';
      } else {
        ctxPreview.style.display = 'block';
        ctxPreview.textContent = contextLine(currentContextDisplay || currentContext);
      }
    }

    function validate() {
      if (submitting) {submitBtn.disabled=true;return;}
      const len = [...descInput.value.trim()].length;
      counter.textContent = `${len} / 2000`;
      if (len < 10) {
        hint.textContent = `还需输入至少 ${10 - len} 个字`;
        hint.className = 'cquest-bug-hint cquest-bug-hint-warn';
        submitBtn.disabled = true;
      } else if (len > 2000) {
        hint.textContent = `已超出 ${len - 2000} 个字`;
        hint.className = 'cquest-bug-hint cquest-bug-hint-error';
        submitBtn.disabled = true;
      } else {
        hint.textContent = '字数符合要求';
        hint.className = 'cquest-bug-hint cquest-bug-hint-ok';
        submitBtn.disabled = false;
      }
    }

    function updateDraftId() {if (attempted && !submitting) {activeReportId=generateReportId();attempted=false;}}

    descInput.addEventListener('input', () => {
      updateDraftId();
      validate();
      saveDraft(catSelect.value, descInput.value, activeReportId);
    });

    catSelect.addEventListener('change', () => {
      updateDraftId();
      saveDraft(catSelect.value, descInput.value, activeReportId);
    });

    attachCheckbox.addEventListener('change', updatePreview);

    const closeHandler = () => {
      if (dialog.open) dialog.close();
    };

    // 背景滚动锁由 overrides/ui.js 的通用 dialog 锁统一处理（含嵌套计数与恢复），此处不再重复加锁

    closeBtn.addEventListener('click', closeHandler);
    cancelBtn.addEventListener('click', closeHandler);

    // 复制反馈文本（离线支持）
    copyBtn.addEventListener('click', async () => {
      const cat = catSelect.value;
      const desc = descInput.value;
      const includeCtx = attachCheckbox.checked && currentContext;
      let text = `【C语言闯关营 反馈】\n类别: ${cat}\n描述: ${desc || '(未填写)'}`;
      if (includeCtx) {
        text += `\n附带环境: ${contextParts(currentContextDisplay || currentContext).join(' | ')}`;
      }
      const ok = await copyText(text);
      statusDiv.className = ok ? 'cquest-bug-status cquest-bug-status-info' : 'cquest-bug-status cquest-bug-status-error';
      statusDiv.textContent = ok ? '已复制反馈文本，可粘贴离线发送。' : '复制失败，请手动选择文字复制。';
    });

    // 提交表单
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;
      const desc = descInput.value.trim();
      if ([...desc].length < 10 || [...desc].length > 2000) {
        validate();
        return;
      }

      submitting = true;
      attempted = true;
      // 防双击与禁用
      submitBtn.disabled = true;
      attachCheckbox.disabled = true;
      cancelBtn.disabled = true;
      copyBtn.disabled = true;
      descInput.disabled = true;
      catSelect.disabled = true;
      statusDiv.className = 'cquest-bug-status cquest-bug-status-info';
      statusDiv.textContent = '正在提交反馈，请稍候…';

      const account = window.CQuestAccount;
      const payload = {
        reportId: activeReportId || generateReportId(),
        category: catSelect.value,
        description: desc,
        context: attachCheckbox.checked ? (currentContext || {}) : null
      };

      try {
        if (!account || typeof account.bugReportRpc !== 'function') {
          throw new Error('反馈服务未就绪，请稍后重试。');
        }
        const res = await account.bugReportRpc('submit', payload);
        if (res && res.accepted) {
          statusDiv.className = 'cquest-bug-status cquest-bug-status-success';
          statusDiv.textContent = '感谢您的反馈，已提交站点管理员！';
          clearDraft();
          activeReportId = generateReportId();
          descInput.value = '';
          catSelect.value = CATEGORIES[0];
          closeHandler();
          if (typeof window.toast === 'function') window.toast('反馈已提交，谢谢！');
        } else {
          throw new Error('反馈未能接收，请重试或复制反馈内容。');
        }
      } catch (err) {
        // 失败保留草稿，错误/超时不自动重试
        statusDiv.className = 'cquest-bug-status cquest-bug-status-error';
        statusDiv.textContent = err.message || '提交失败，请重试或点击复制文本离线反馈。';
      } finally {
        submitting = false;
        attachCheckbox.disabled = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        copyBtn.disabled = false;
        descInput.disabled = false;
        catSelect.disabled = false;
        validate();
      }
    });

    return dialog;
  }

  // 打开反馈弹窗
  function open(rawContext) {
    if (submitting) {dialogElement?.focus();return;}
    // 严格清洗并隔离上下文，新开对话不得保留旧上下文
    currentContext = sanitizeContext(rawContext);
    const rawQuestionId = rawContext && typeof rawContext.questionId === 'string' ? rawContext.questionId : '';
    currentContextDisplay = currentContext && rawQuestionId && rawQuestionId !== currentContext.questionId
      ? Object.assign({}, currentContext, { questionId: rawQuestionId })
      : currentContext;

    const dialog = ensureDialog();
    const draft = loadDraft();
    attempted = !!draft;
    const catSelect = dialog.querySelector('#cquest-bug-category');
    const descInput = dialog.querySelector('#cquest-bug-desc');
    const counter = dialog.querySelector('#cquest-bug-counter');
    const hint = dialog.querySelector('#cquest-bug-hint');
    const submitBtn = dialog.querySelector('#cquest-bug-submit');
    const statusDiv = dialog.querySelector('#cquest-bug-status');
    const attachCheckbox = dialog.querySelector('#cquest-bug-attach-ctx');
    const ctxPreview = dialog.querySelector('#cquest-bug-ctx-preview');

    statusDiv.textContent = '';
    statusDiv.className = 'cquest-bug-status';

    if (draft) {
      catSelect.value = draft.category;
      descInput.value = draft.description;
      activeReportId = draft.reportId;
    } else {
      catSelect.value = CATEGORIES[0];
      descInput.value = '';
      activeReportId = generateReportId();
    }

    // 默认勾选附带上下文
    attachCheckbox.checked = true;

    // 更新预览
    if (currentContext) {
      ctxPreview.style.display = 'block';
      ctxPreview.textContent = contextLine(currentContextDisplay || currentContext);
    } else {
      ctxPreview.style.display = 'none';
      ctxPreview.textContent = '';
    }

    // 验证字符
    const len = [...descInput.value.trim()].length;
    counter.textContent = `${len} / 2000`;
    if (len < 10) {
      hint.textContent = `还需输入至少 ${10 - len} 个字`;
      hint.className = 'cquest-bug-hint cquest-bug-hint-warn';
      submitBtn.disabled = true;
    } else if (len > 2000) {
      hint.textContent = `已超出 ${len - 2000} 个字`;
      hint.className = 'cquest-bug-hint cquest-bug-hint-error';
      submitBtn.disabled = true;
    } else {
      hint.textContent = '字数符合要求';
      hint.className = 'cquest-bug-hint cquest-bug-hint-ok';
      submitBtn.disabled = false;
    }

    if (!dialog.open) {
      dialog.showModal();
    }
    // 背景滚动锁由 overrides/ui.js 的通用 dialog 锁统一处理，避免两套锁互相恢复滚动位置
  }

  // 管理端反馈渲染
  let adminGeneration = 0;
  async function renderAdmin() {
    const token = ++adminGeneration;
    const root = document.querySelector('#feedback') || document.querySelector('#app');
    if (!root) return;

    const account = window.CQuestAccount;
    const session = account?.bugReportSession ? account.bugReportSession() : {};

    root.innerHTML = `
      <div class="page-title">
        <div>
          <h1>Bug 反馈管理</h1>
          <p>查看与处理用户提交的问题反馈（仅站点管理员可见）</p>
        </div>
        <span class="rank-kicker">ADMIN FEEDBACK</span>
      </div>
      <div class="feedback-admin-layout">
        <div id="feedback-admin-content" class="feedback-admin-card"></div>
      </div>
    `;

    const content = root.querySelector('#feedback-admin-content');

    if (!session.configured) {
      content.innerHTML = `<div class="rank-empty"><h3>服务未配置</h3><p class="rank-muted">Bug 反馈云服务尚未配置。</p></div>`;
      return;
    }
    if (!session.loggedIn) {
      content.innerHTML = `<div class="rank-empty"><h3>需要登录</h3><p class="rank-muted">请先登录管理员账户。</p><a class="primary rank-link" href="#account">前往登录</a></div>`;
      return;
    }
    if (!session.admin) {
      content.innerHTML = `<div class="rank-empty"><h3>无管理权限</h3><p class="rank-muted">此反馈列表仅站点管理员可见。</p></div>`;
      return;
    }

    // 管理员已鉴权
    content.innerHTML = `
      <div class="feedback-admin-header">
        <div class="feedback-admin-actions">
          <button type="button" id="feedback-refresh-btn" class="secondary">刷新列表</button>
          <div class="feedback-filter-group">
            <label><input type="radio" name="fb-filter" value="all" checked> 全部</label>
            <label><input type="radio" name="fb-filter" value="open"> 待处理</label>
            <label><input type="radio" name="fb-filter" value="resolved"> 已解决</label>
          </div>
        </div>
        <div id="feedback-admin-msg" class="feedback-admin-msg" role="status"></div>
      </div>
      <div id="feedback-list-container" class="feedback-list-container" aria-live="polite">
        <p class="rank-placeholder">正在加载反馈列表…</p>
      </div>
    `;

    const refreshBtn = content.querySelector('#feedback-refresh-btn');
    const listContainer = content.querySelector('#feedback-list-container');
    const msgArea = content.querySelector('#feedback-admin-msg');
    const filterRadios = content.querySelectorAll('input[name="fb-filter"]');

    let currentList = [];
    let activeFilter = 'all';

    function setMessage(text, isError = false) {
      if (token !== adminGeneration) return;
      msgArea.textContent = text;
      msgArea.className = isError ? 'feedback-admin-msg feedback-admin-msg-error' : 'feedback-admin-msg';
    }

    // 纯 DOM 节点安全构建，不使用 innerHTML 插入未转义内容，彻底杜绝 XSS
    function renderItems() {
      if (token !== adminGeneration) return;
      listContainer.textContent = '';

      const filtered = currentList.filter(item => {
        if (activeFilter === 'all') return true;
        if (activeFilter === 'open') return item.status !== 'resolved';
        if (activeFilter === 'resolved') return item.status === 'resolved';
        return true;
      });

      if (filtered.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'rank-empty';
        const h3 = document.createElement('h3');
        h3.textContent = '暂无反馈记录';
        const p = document.createElement('p');
        p.className = 'rank-muted';
        p.textContent = activeFilter === 'all' ? '当前没有收集到任何反馈。' : '当前筛选条件下没有记录。';
        emptyDiv.appendChild(h3);
        emptyDiv.appendChild(p);
        listContainer.appendChild(emptyDiv);
        return;
      }

      const ul = document.createElement('ul');
      ul.className = 'feedback-items-list';

      filtered.forEach(item => {
        const li = document.createElement('li');
        li.className = `feedback-item-card ${item.status === 'resolved' ? 'feedback-item-resolved' : 'feedback-item-open'}`;

        // 卡片头部
        const head = document.createElement('div');
        head.className = 'feedback-item-head';

        const tagGroup = document.createElement('div');
        tagGroup.className = 'feedback-tag-group';

        const catBadge = document.createElement('span');
        catBadge.className = 'feedback-badge-category';
        catBadge.textContent = item.category || '其他';

        const statusBadge = document.createElement('span');
        statusBadge.className = `feedback-badge-status ${item.status === 'resolved' ? 'status-resolved' : 'status-open'}`;
        statusBadge.textContent = item.status === 'resolved' ? '已解决' : '待处理';

        tagGroup.appendChild(catBadge);
        tagGroup.appendChild(statusBadge);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'feedback-item-time';
        timeSpan.textContent = item.created_at ? new Date(item.created_at).toLocaleString() : '未知时间';

        head.appendChild(tagGroup);
        head.appendChild(timeSpan);

        // 问题描述（严格 textContent）
        const descP = document.createElement('p');
        descP.className = 'feedback-item-desc';
        descP.textContent = item.description || '';

        // 上下文展示（若有）
        let ctxBlock = null;
        if (item.context && typeof item.context === 'object') {
          const parts = [];
          if (item.context.page) parts.push(`页面: ${item.context.page}`);
          if (item.context.mode) parts.push(`模式: ${item.context.mode}`);
          if (item.context.questionId != null) parts.push(`题号: ${item.context.questionId}`);
          if (item.context.position != null) parts.push(`位置: ${item.context.position}`);
          if (item.context.viewport) parts.push(`屏幕: ${item.context.viewport.width}×${item.context.viewport.height}`);
          if (item.context.browser) parts.push(`浏览器: ${item.context.browser}`);
          if (parts.length > 0) {
            ctxBlock = document.createElement('div');
            ctxBlock.className = 'feedback-item-context';
            ctxBlock.textContent = `设备与位置: ${parts.join(' | ')}`;
          }
        }

        // 状态操作按钮
        const actions = document.createElement('div');
        actions.className = 'feedback-item-actions';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = item.status === 'resolved' ? 'secondary feedback-resolve-btn' : 'primary feedback-resolve-btn';
        toggleBtn.textContent = item.status === 'resolved' ? '重新打开' : '标记已解决';

        toggleBtn.addEventListener('click', async () => {
          toggleBtn.disabled = true;
          const newStatus = item.status === 'resolved' ? 'open' : 'resolved';
          try {
            setMessage('正在更新状态…');
            const res = await account.bugReportRpc('resolve', {
              reportId: item.id,
              status: newStatus
            });
            if (res && res.updated) {
              item.status = newStatus;
              renderItems();
              setMessage(newStatus === 'resolved' ? '已标记为解决。' : '已重新打开问题。');
            } else {
              throw new Error('更新失败');
            }
          } catch (e) {
            setMessage(e.message || '更新状态失败，请重试。', true);
            toggleBtn.disabled = false;
          }
        });

        actions.appendChild(toggleBtn);

        li.appendChild(head);
        li.appendChild(descP);
        if (ctxBlock) li.appendChild(ctxBlock);
        li.appendChild(actions);

        ul.appendChild(li);
      });

      listContainer.appendChild(ul);
    }

    async function fetchList() {
      if (token !== adminGeneration) return;
      refreshBtn.disabled = true;
      listContainer.textContent = '';
      const loadingP = document.createElement('p');
      loadingP.className = 'rank-placeholder';
      loadingP.textContent = '正在获取反馈列表…';
      listContainer.appendChild(loadingP);

      try {
        const data = await account.bugReportRpc('list', {});
        if (token !== adminGeneration) return;
        currentList = Array.isArray(data) ? data : [];
        // 按时间倒序排序
        currentList.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        renderItems();
      } catch (err) {
        if (token !== adminGeneration) return;
        listContainer.textContent = '';
        const errP = document.createElement('p');
        errP.className = 'rank-error';
        errP.textContent = err.message || '获取列表失败，请重试。';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'secondary';
        retryBtn.textContent = '重新加载';
        retryBtn.onclick = fetchList;
        listContainer.appendChild(errP);
        listContainer.appendChild(retryBtn);
      } finally {
        if (token === adminGeneration) refreshBtn.disabled = false;
      }
    }

    refreshBtn.onclick = fetchList;
    filterRadios.forEach(radio => {
      radio.onchange = () => {
        activeFilter = radio.value;
        renderItems();
      };
    });

    await fetchList();
  }

  // 挂载导出接口
  window.CQuestBugReport = {
    open,
    renderAdmin
  };

  // 监听路由与账号状态
  window.addEventListener('hashchange', () => {
    const hash = (location.hash || '').split('?')[0];
    if (hash !== '#feedback') ++adminGeneration;
  });

  window.addEventListener('cquest:account-status', () => {
    const hash = (location.hash || '').split('?')[0];
    if (hash === '#feedback') renderAdmin();
  });
})();
