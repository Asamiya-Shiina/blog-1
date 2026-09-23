// 独立编辑器页逻辑:基于 /api/posts 增改文章 + /api/upload 插图 + markdown.js 实时预览。
// ?id= 存在时为编辑既有文章(自动加载回填),否则为新建。
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let editingId = params.get('id') ? Number(params.get('id')) : null;

  const titleInput = $('titleInput');
  const tagInput = $('tagInput');
  const tagsInput = $('tagsInput');
  const excerptInput = $('excerptInput');
  const contentInput = $('contentInput');
  const editorTitle = $('editorTitle');
  const saveBtn = $('saveBtn');
  const logoutBtn = $('logoutBtn');
  const imgInput = $('imgInput');
  const uploadStatus = $('uploadStatus');
  const previewPane = $('previewPane');
  let categoriesList = [];

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

  // 填充文章类型下拉:默认选中第一项;候选加载失败时兜底一个「未分类」
  async function initTagSelect() {
    try {
      const r = await api('/api/categories');
      categoriesList = Array.isArray(r.categories) ? r.categories : [];
    } catch {}
    tagInput.textContent = '';
    (categoriesList.length ? categoriesList : ['未分类']).forEach((c) => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      tagInput.appendChild(o);
      if (tagInput.value === '' && c) tagInput.value = c;
    });
  }

  function renderPreview() {
    previewPane.innerHTML = Markdown.render(contentInput.value || '');
  }

  function insertAtCursor(tarea, text) {
    const s = tarea.selectionStart ?? tarea.value.length;
    const e = tarea.selectionEnd ?? tarea.value.length;
    tarea.value = tarea.value.slice(0, s) + text + tarea.value.slice(e);
    const pos = s + text.length;
    tarea.focus();
    tarea.setSelectionRange(pos, pos);
    renderPreview();
  }

  async function loadForEdit() {
    if (!editingId) return;
    const p = await api('/api/posts/' + editingId);
    editorTitle.textContent = '编辑文章 #' + editingId;
    titleInput.value = p.title;
    // 回填文章类型:若用了候选外的旧标签,临时补一个选项再选中
    if (![...tagInput.options].some((o) => o.value === p.tag)) {
      const o = document.createElement('option');
      o.value = p.tag;
      o.textContent = p.tag;
      tagInput.appendChild(o);
    }
    tagInput.value = p.tag || (tagInput.options[0] ? tagInput.options[0].value : '');
    tagsInput.value = p.tags || '';
    excerptInput.value = p.excerpt || '';
    contentInput.value = p.content || '';
    renderPreview();
  }

  async function submit() {
    const data = {
      title: titleInput.value,
      tag: tagInput.value,
      tags: tagsInput.value,
      excerpt: excerptInput.value,
      content: contentInput.value,
    };
    if (!data.title.trim()) { alert('标题不能为空'); titleInput.focus(); return; }
    try {
      if (editingId === null) {
        const r = await api('/api/posts', jsonOpts(data));
        editingId = r.id; // 保存后保留为编辑态,可继续改再存
      } else {
        await api('/api/posts/' + editingId, jsonOpts(data, 'PUT'));
      }
      alert('保存成功 ✓');
    } catch (e) { alert(e.message); }
  }

  // 从某个元素中心触发水波盖屏(与登录进管理同一套)
  function rippleFrom(el) {
    const ripple = document.getElementById('ripple');
    if (!ripple) return false;
    const r = el.getBoundingClientRect();
    ripple.style.setProperty('--cx', (r.left + r.width / 2) + 'px');
    ripple.style.setProperty('--cy', (r.top + r.height / 2) + 'px');
    document.body.classList.add('profile-reveal');
    return true;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function goTo(url, fromEl) {
    if (rippleFrom(fromEl)) { await sleep(750); }
    location.href = url;
  }

  // ---- 事件 ----
  contentInput.addEventListener('input', renderPreview);
  saveBtn.addEventListener('click', submit);

  logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    goTo('admin.html', logoutBtn);
  });

  imgInput.addEventListener('change', async () => {
    const file = imgInput.files[0];
    if (!file || imgInput.dataset.busy) return;
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

  // 守卫:未登录时进编辑器页会被 API 401,引导回后台
  (async () => {
    try { const me = await api('/api/me'); if (!me.loggedIn) { location.href = 'admin.html'; return; } } catch {}
    await initTagSelect();
    try { await loadForEdit(); } catch (e) { alert(e.message || '加载文章失败'); }
  })();
})();