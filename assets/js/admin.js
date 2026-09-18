// 后台管理页逻辑
// 页面分流三种状态:首次设置密码(setupView) / 登录(loginView) / 管理区(adminView)。
// 通过 /api/me 的 loggedIn + needsSetup 字段决定进入哪个视图。
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

  const editorCard = $('editorCard');
  const editorTitle = $('editorTitle');
  const titleInput = $('titleInput');
  const tagInput = $('tagInput');
  const excerptInput = $('excerptInput');
  const contentInput = $('contentInput');
  const newBtn = $('newBtn');
  const saveBtn = $('saveBtn');
  const cancelEditorBtn = $('cancelEditorBtn');
  const logoutBtn = $('logoutBtn');
  const imgInput = $('imgInput');
  const uploadStatus = $('uploadStatus');
  const postList = $('postList');
  const listEmpty = $('listEmpty');
  const postCount = $('postCount');

  let editingId = null; // null = 新建
  let editSeq = 0; // 递增序号,丢弃过期的"编辑加载"结果,防连点竞态

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
  function showAdmin() { setupView.hidden = true; loginView.hidden = true; adminView.hidden = false; }

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
      editBtn.addEventListener('click', () => editPost(p.id));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn small danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => delPost(p));
      actions.append(viewBtn, editBtn, delBtn);

      row.append(info, actions);
      postList.appendChild(row);
    });
  }

  function openEditor(title) {
    editorTitle.textContent = title;
    editorCard.hidden = false;
    editorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeEditor() {
    editorCard.hidden = true;
    editingId = null;
  }
  function collect() {
    return {
      title: titleInput.value,
      tag: tagInput.value,
      excerpt: excerptInput.value,
      content: contentInput.value,
    };
  }

  async function editPost(id) {
    const seq = ++editSeq;
    editingId = id;
    const p = await api('/api/posts/' + id);
    if (seq !== editSeq) return; // 期间用户已切到别的文章,丢弃过期结果
    titleInput.value = p.title;
    tagInput.value = p.tag || '';
    excerptInput.value = p.excerpt || '';
    contentInput.value = p.content || '';
    openEditor('编辑文章 #' + id);
  }

  async function delPost(p) {
    if (!confirm('确定删除《' + p.title + '》吗?此操作不可恢复。')) return;
    await api('/api/posts/' + p.id, { method: 'DELETE' });
    await loadPosts();
  }

  async function submit() {
    const data = collect();
    if (!data.title.trim()) { alert('标题不能为空'); titleInput.focus(); return; }
    try {
      if (editingId === null) {
        await api('/api/posts', jsonOpts(data));
      } else {
        await api('/api/posts/' + editingId, jsonOpts(data, 'PUT'));
      }
    } catch (e) { alert(e.message); return; }
    closeEditor();
    titleInput.value = tagInput.value = excerptInput.value = contentInput.value = '';
    await loadPosts();
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
    closeEditor();
    showLogin();
  });

  newBtn.addEventListener('click', () => {
    editingId = null;
    titleInput.value = tagInput.value = excerptInput.value = contentInput.value = '';
    openEditor('写新文章');
    titleInput.focus();
  });
  saveBtn.addEventListener('click', submit);
  cancelEditorBtn.addEventListener('click', () => { closeEditor(); editorCard.scrollIntoView({ behavior: 'smooth' }); });

  // 图片上传:转 base64 → 上传 → 插入正文光标处
  imgInput.addEventListener('change', async () => {
    const file = imgInput.files[0];
    if (!file) return;
    if (imgInput.dataset.busy) return;
    imgInput.dataset.busy = '1';
    uploadStatus.textContent = '上传中…';
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('读取文件失败'));
        r.readAsDataURL(file);
      });
      const res = await api('/api/upload', jsonOpts({ data: dataUrl }));
      const md = '![' + (file.name.replace(/\.[^.]+$/, '') || '图片') + '](' + res.url + ') ';
      insertAtCursor(contentInput, md);
      uploadStatus.textContent = '已插入 ✓';
    } catch (e) {
      uploadStatus.textContent = '上传失败:' + e.message;
    } finally {
      imgInput.dataset.busy = '';
      imgInput.value = '';
      setTimeout(() => { uploadStatus.textContent = ''; }, 3000);
    }
  });

  function insertAtCursor(tarea, text) {
    const s = tarea.selectionStart ?? tarea.value.length;
    const e = tarea.selectionEnd ?? tarea.value.length;
    tarea.value = tarea.value.slice(0, s) + text + tarea.value.slice(e);
    const pos = s + text.length;
    tarea.focus();
    tarea.setSelectionRange(pos, pos);
  }

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