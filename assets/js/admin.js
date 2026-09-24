// 后台管理页逻辑(文章列表)
// 页面分流三种状态:首次设置密码(setupView) / 登录(loginView) / 管理区(adminView)。
// 写文章与编辑改走独立编辑器页 admin-editor.html(含插图上传、实时预览)。
(function () {
  const $ = (id) => document.getElementById(id);

  const loginView = $('loginView');
  const adminView = $('adminView');
  const passInput = $('passInput');
  const loginBtn = $('loginBtn');
  const loginErr = $('loginErr');

  const setupView = $('setupView');
  const setupPassInput = $('setupPassInput');
  const setupPass2Input = $('setupPass2Input');
  const setupBtn = $('setupBtn');
  const setupErr = $('setupErr');

  const logoutBtn = $('logoutBtn');
  const postList = $('postList');
  const listEmpty = $('listEmpty');
  const postCount = $('postCount');
  const namesInput = $('namesInput');
  const renamePatternsInput = $('renamePatternsInput');
  const blockInput = $('blockInput');
  const blockPatternsInput = $('blockPatternsInput');
  const titleAppsInput = $('titleAppsInput');
  const titlePatternsInput = $('titlePatternsInput');
  const procSaveBtn = $('procSaveBtn');
  const procStatus = $('procStatus');

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  }
  const jsonOpts = (obj, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });

  function showSetup() { setupView.hidden = false; loginView.hidden = true; adminView.hidden = true; }
  function showLogin() { setupView.hidden = true; loginView.hidden = false; adminView.hidden = true; }
  function showAdmin() { setupView.hidden = true; loginView.hidden = true; adminView.hidden = false; loadProcCfg(); }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 从某个元素中心触发水波盖屏(与首页 hero 进简介同一套动画)
  function rippleFrom(el) {
    const ripple = document.getElementById('ripple');
    if (!ripple) return false;
    const r = el.getBoundingClientRect();
    ripple.style.setProperty('--cx', (r.left + r.width / 2) + 'px');
    ripple.style.setProperty('--cy', (r.top + r.height / 2) + 'px');
    document.body.classList.add('profile-reveal');
    return true;
  }
  async function goTo(url, fromEl) {
    if (rippleFrom(fromEl)) { await sleep(750); }
    location.href = url;
  }

  let rippleBusy = false; // 防止水波期间连点

  async function loadPosts() {
    const posts = await api('/api/posts');
    postList.textContent = '';
    postCount.textContent = posts.length;
    listEmpty.hidden = posts.length > 0;
    posts.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'post-row';

      const info = document.createElement('div');
      info.className = 'post-row-info';
      const t = document.createElement('div');
      t.className = 'post-row-title';
      t.textContent = p.title;
      const m = document.createElement('div');
      m.className = 'post-row-meta';
      m.textContent = (p.tag || '未分类') + ' · ' + p.created_at;
      info.append(t, m);

      const actions = document.createElement('div');
      actions.className = 'post-row-actions';
      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn small secondary';
      viewBtn.textContent = '查看';
      viewBtn.title = '新标签页打开文章';
      viewBtn.addEventListener('click', () => window.open('post.html?id=' + p.id, '_blank'));
      const editBtn = document.createElement('button');
      editBtn.className = 'btn small secondary';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => goTo('admin-editor.html?id=' + p.id, editBtn));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn small danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => delPost(p));
      actions.append(viewBtn, editBtn, delBtn);

      row.append(info, actions);
      postList.appendChild(row);
    });
  }

  async function delPost(p) {
    if (!confirm('确定删除《' + p.title + '》吗?此操作不可恢复。')) return;
    await api('/api/posts/' + p.id, { method: 'DELETE' });
    await loadPosts();
  }

  // ---- "正在用"状态设置(统一配置对象:改名/正则/黑名单/标题应用) ----
  const objToLines = (o) => Object.keys(o).map((k) => k + '=' + o[k]).join('\n');
  const linesToObj = (s) => {
    const o = {};
    s.split(/[\n\r]+/).forEach((line) => {
      const eq = line.indexOf('=');
      if (eq > 0) { const k = line.slice(0, eq).trim(); const v = line.slice(eq + 1).trim(); if (k) o[k] = v; }
    });
    return o;
  };
  const linesToArr = (s) => s.split(/[\n\r]+/).map((x) => x.trim()).filter(Boolean);
  // "正则=名称" 每行 → [{pattern,name}]
  const patternsToArr = (s) => linesToArr(s).map((line) => {
    const eq = line.indexOf('=');
    if (eq > 0) return { pattern: line.slice(0, eq).trim(), name: line.slice(eq + 1).trim() };
    return { pattern: line, name: '' };
  }).filter((x) => x.pattern);
  // [{pattern,name}] → 每行 "pattern=name"
  const patternsToLines = (arr) => (arr || []).map((x) => x.pattern + '=' + (x.name || '')).join('\n');

  async function loadProcCfg() {
    if (!namesInput) return;
    procStatus.textContent = '';
    try {
      const c = await api('/api/data/admin/config');
      namesInput.value = objToLines(c.appNames || {});
      renamePatternsInput.value = patternsToLines(c.appNamePatterns || []);
      blockInput.value = (c.blacklist || []).join('\n');
      blockPatternsInput.value = (c.blacklistPatterns || []).join('\n');
      titleAppsInput.value = (c.titleApps || []).join('\n');
      titlePatternsInput.value = (c.titleAppPatterns || []).join('\n');
    } catch (e) { procStatus.textContent = '加载失败:' + e.message; }
  }

  async function saveProcCfg() {
    procStatus.textContent = '保存中…';
    try {
      await api('/api/data/admin/config', jsonOpts({
        appNames: linesToObj(namesInput.value),
        appNamePatterns: patternsToArr(renamePatternsInput.value),
        blacklist: linesToArr(blockInput.value),
        blacklistPatterns: linesToArr(blockPatternsInput.value),
        titleApps: linesToArr(titleAppsInput.value),
        titleAppPatterns: linesToArr(titlePatternsInput.value),
      }));
      procStatus.textContent = '已保存 ✓';
    } catch (e) {
      procStatus.textContent = '保存失败:' + e.message;
    }
  }

  // ---- 事件 ----
  loginBtn.addEventListener('click', async () => {
    if (rippleBusy) return;
    loginErr.textContent = '';
    try {
      await api('/api/login', jsonOpts({ password: passInput.value }));
      passInput.value = '';
      // 水波盖屏后露出管理界面
      rippleBusy = true;
      rippleFrom(loginBtn);
      await sleep(750);
      showAdmin();
      await loadPosts();
      document.body.classList.remove('profile-reveal'); // 水波回缩,呈现 zoom-in 效果
      rippleBusy = false;
    } catch (e) {
      loginErr.textContent = e.message || '登录失败';
    }
  });
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginBtn.click(); });

  setupBtn.addEventListener('click', async () => {
    setupErr.textContent = '';
    const p1 = setupPassInput.value;
    const p2 = setupPass2Input.value;
    if (p1.length < 6) { setupErr.textContent = '密码至少 6 位'; return; }
    if (p1 !== p2) { setupErr.textContent = '两次输入的密码不一致'; return; }
    try {
      await api('/api/setup', jsonOpts({ password: p1 }));
      setupPassInput.value = setupPass2Input.value = '';
      showAdmin();
      loadPosts();
    } catch (e) {
      setupErr.textContent = e.message || '设置失败';
    }
  });
  [setupPassInput, setupPass2Input].forEach((el) =>
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') setupBtn.click(); })
  );

  logoutBtn.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    showLogin();
  });

  if (procSaveBtn) procSaveBtn.addEventListener('click', saveProcCfg);

  // ---- 启动 ----
  (async () => {
    try {
      const me = await api('/api/me');
      if (me.loggedIn) { showAdmin(); await loadPosts(); }
      else if (me.needsSetup) { showSetup(); }
      else { showLogin(); }
    } catch {
      showLogin();
    }
  })();
})();