/* Opt-in public learning records. Private sessions stay in the account adapter. */
(() => {
  'use strict';
  let generation = 0, signature = '';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const active = () => location.hash.split('?')[0] === '#leaderboard';
  function render() {
    const token = ++generation, account = window.CQuestAccount;
    const auth = account?.leaderboardSession() || {};
    signature = JSON.stringify(auth);
    const root = document.querySelector('#app');
    root.innerHTML = `<div class="page-title"><div><h1>学习排行榜</h1><p>每一道学会的题，都算一步进步。</p></div><span class="rank-kicker">LEARNING TOGETHER</span></div>
      <div class="rank-layout"><section class="rank-card" aria-labelledby="rank-title"><div class="rank-heading"><div><span class="rank-eyebrow">共同进步 · TOP 50</span><h2 id="rank-title">答对题数榜</h2></div><button type="button" id="rank-refresh" class="secondary">刷新榜单</button></div><p class="rank-muted">按云存档中答对的不同选择题数量排名，同分并列。</p><div id="rank-list" aria-live="polite" aria-busy="true"><p class="rank-placeholder">正在加载榜单…</p></div></section>
      <aside class="rank-side"><section class="rank-card"><h2>我的上榜名片</h2><div id="rank-profile">${!auth.configured ? '<p>排行榜云服务尚未配置。</p>' : !auth.loggedIn ? '<p class="rank-muted">登录并同步学习记录后，选择昵称即可加入。</p><a class="primary rank-link" href="#account">登录 / 注册</a>' : auth.pendingMerge ? '<p>请先处理云存档合并，再加入排行榜。</p><a href="#account">前往账户</a>' : '<p>正在读取上榜状态…</p>'}</div><p id="rank-message" role="status"></p></section>
      <section class="rank-card rank-rules"><h2>怎样计分？</h2><ul><li>同一道选择题答对多次，只计 1 题。</li><li>只统计已同步的云存档，自练题自评不计入。</li><li>自愿加入；公开昵称和答对题数，不公开邮箱或作答内容。</li><li>可随时退出，不会删除个人存档。</li></ul><p class="rank-muted">这是学习记录榜，不能作为防作弊考试成绩。</p></section></aside></div>`;
    const valid = () => token === generation && active();
    const message = text => { if (valid()) root.querySelector('#rank-message').textContent = text; };
    let listGeneration = 0;
    async function loadList() {
      if (!valid()) return;
      const request = ++listGeneration;
      const target = root.querySelector('#rank-list');
      target.setAttribute('aria-busy', 'true');
      try {
        const rows = await account.leaderboardRpc('list');
        if (!valid() || request !== listGeneration) return;
        target.innerHTML = rows.length ? `<div class="rank-columns" aria-hidden="true"><span>名次</span><span>学习伙伴</span><span>答对题数</span></div><ol class="rank-rows">${rows.map(row => `<li class="rank-row${row.mine ? ' rank-mine' : ''}"><span class="rank-position${row.rank <= 3 ? ' rank-top' : ''}" aria-label="第 ${row.rank} 名">${row.rank}</span><span class="rank-name">${escape(row.nickname)}${row.mine ? '<small>我</small>' : ''}</span><strong class="rank-score">${row.solved}<small>题</small></strong></li>`).join('')}</ol><p class="rank-muted rank-caption">展示前 50 位 · 以最近同步的云存档为准</p>` : '<div class="rank-empty"><span aria-hidden="true">↗</span><h3>第一步，等你加入</h3><p>还没有人上榜。设置昵称，一起开始积累。</p></div>';
      } catch (err) {
        if (valid() && request === listGeneration) { target.innerHTML = `<p class="rank-error">${escape(err.message || '榜单加载失败，请重试。')}</p><button type="button" id="rank-retry" class="secondary">重新加载</button>`; target.querySelector('#rank-retry').onclick = loadList; }
      } finally { if (valid() && request === listGeneration) target.setAttribute('aria-busy', 'false'); }
    }
    root.querySelector('#rank-refresh').onclick = loadList;
    if (auth.configured) loadList();
    else { root.querySelector('#rank-list').innerHTML = '<p>排行榜云服务尚未配置。</p>'; root.querySelector('#rank-list').setAttribute('aria-busy', 'false'); }
    if (!auth.loggedIn || auth.pendingMerge) return;
    function showProfile(profile) {
      if (!valid()) return;
      const target = root.querySelector('#rank-profile');
      target.innerHTML = `<p class="rank-muted">${profile.joined ? '你已加入，昵称可随时修改。' : '加入前，请选择一个公开昵称。'}</p><form id="rank-form"><label for="rank-nickname">公开昵称</label><input id="rank-nickname" name="nickname" autocomplete="off" required placeholder="2—16 个字符" value="${escape(profile.nickname)}" aria-describedby="rank-name-help"><small id="rank-name-help" class="rank-muted">请勿填写邮箱或其他个人信息。</small><label class="rank-consent"><input type="checkbox" id="rank-consent" required><span>我同意公开昵称和答对题数。</span></label><button type="submit" class="primary" id="rank-save" disabled>${profile.joined ? '保存昵称' : '加入排行榜'}</button></form><div class="rank-profile-actions"><button type="button" class="secondary" id="rank-sync">同步学习进度</button>${profile.joined ? '<button type="button" class="rank-leave" id="rank-leave">退出排行榜</button>' : ''}</div>`;
      const form = target.querySelector('form');
      const consent = target.querySelector('#rank-consent');
      consent.onchange = () => { target.querySelector('#rank-save').disabled = !consent.checked; };
      let busy = false;
      async function mutate(action, params) {
        if (busy || !valid()) return;
        busy = true; target.querySelectorAll('button,input').forEach(el => el.disabled = true);
        try {
          const result = await account.leaderboardRpc(action, params);
          if (!valid()) return;
          showProfile(result); message(action === 'leave' ? '已退出排行榜，个人存档已保留。' : '名片已保存。答题后记得同步进度。'); await loadList();
        } catch (err) { message(err.message || '操作失败，请重试。'); }
        finally { busy = false; if (valid() && form.isConnected) { target.querySelectorAll('button,input').forEach(el => el.disabled = false); target.querySelector('#rank-save').disabled = !consent.checked; } }
      }
      form.onsubmit = event => { event.preventDefault(); if (consent.checked) mutate('join', {nickname: form.elements.nickname.value}); };
      target.querySelector('#rank-leave')?.addEventListener('click', () => mutate('leave'));
      target.querySelector('#rank-sync').onclick = async () => {
        if (busy) return;
        busy = true;
        const button = target.querySelector('#rank-sync'); button.disabled = true;
        message('正在同步，请稍候…');
        try { await account.handleSyncNow(); if (valid()) { message('请在账户页确认同步状态；榜单以云端存档为准。'); await loadList(); } }
        catch (err) { message(err.message || '同步失败，请在账户页重试。'); }
        finally { busy = false; if (valid() && button.isConnected) button.disabled = false; }
      };
    }
    account.leaderboardRpc('profile').then(showProfile).catch(err => {
      if (valid()) { root.querySelector('#rank-profile').textContent = err.message || '上榜状态加载失败。'; const retry = document.createElement('button'); retry.className='secondary'; retry.textContent='重试'; retry.onclick=render; root.querySelector('#rank-profile').append(retry); }
    });
  }
  window.CQuestLeaderboard = { render };
  window.addEventListener('hashchange', () => { if (!active()) ++generation; });
  window.addEventListener('cquest:account-status', () => {
    const next = JSON.stringify(window.CQuestAccount?.leaderboardSession() || {});
    if (active() && next !== signature) render();
  });
})();
