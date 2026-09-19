// 主页相册模块:加载 /api/photos 渲染成单图轮播;
// 每张图铺满相册框,展示 SHOW_MS(5 秒)后自动切到下一张;鼠标悬停暂停;
// 右上角「上传」按钮:未登录先跳后台,已登录选多张图上传(实时刷新);
// 登录态下悬停出现删除按钮,可随时清理 photo/ 下的图片。
(function () {
  const grid = document.getElementById('albumGrid');
  const uploadBtn = document.getElementById('photoUploadBtn');
  const fileInput = document.getElementById('photoFileInput');
  const status = document.getElementById('albumStatus');
  if (!grid) return;

  const SHOW_MS = 5000; // 每张展示 5 秒
  let canManage = false; // 仅站主(muxi)可上传/删除
  let photos = [];
  let idx = 0;
  let timer = null;
  let stage = null, layers = [], dots = null;

  function setStatus(msg, ok) {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('ok', !!ok);
    if (msg) setTimeout(() => setStatus(''), 2600);
  }

  function showEmpty(msg) {
    grid.textContent = '';
    const p = document.createElement('p');
    p.className = 'album-empty';
    p.textContent = msg;
    grid.appendChild(p);
  }

  // 两幅交叉淡入:偶数索引用 0 号图层,奇数用 1 号,来回切换实现淡入淡出
  function render() {
    const p = photos[idx % photos.length];
    const slot = idx % 2;
    layers.forEach((img, k) => {
      const isActive = k === slot;
      if (isActive && !img.src.includes(p.url)) { img.src = p.url; img.alt = p.name; } // 需要时才换图,避免闪一下
      img.classList.toggle('active', isActive);
    });
    if (dots) dots.querySelectorAll('.dot').forEach((d, j) => d.classList.toggle('active', j === idx % photos.length));
    startTimer();
  }

  function show(i) { idx = ((i % photos.length) + photos.length) % photos.length; render(); }
  function next() { show(idx + 1); }
  function startTimer() { stopTimer(); timer = setInterval(next, SHOW_MS); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  function buildSlideshow() {
    grid.textContent = '';
    stage = document.createElement('div');
    stage.className = 'album-stage';
    layers = [0, 1].map(() => {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.onerror = () => img.classList.add('broken'); // 链接失效的透明占位
      return img;
    });
    layers.forEach((img) => stage.appendChild(img));
    if (canManage) {
      const del = document.createElement('button');
      del.className = 'album-del';
      del.title = '删除当前图片';
      del.textContent = '✕';
      del.addEventListener('click', () => delPhoto(photos[idx]));
      stage.appendChild(del);
    }
    const prev = document.createElement('button');
    prev.className = 'album-arrow album-prev';
    prev.textContent = '<';
    prev.setAttribute('aria-label', '上一张');
    prev.addEventListener('click', () => show(idx - 1));
    stage.appendChild(prev);

    const next = document.createElement('button');
    next.className = 'album-arrow album-next';
    next.textContent = '>';
    next.setAttribute('aria-label', '下一张');
    next.addEventListener('click', () => show(idx + 1));
    stage.appendChild(next);

    dots = document.createElement('div');
    dots.className = 'album-dots';
    photos.forEach((_, j) => {
      const d = document.createElement('span');
      d.className = 'dot';
      d.title = '第 ' + (j + 1) + ' 张';
      d.addEventListener('click', () => show(j));
      dots.appendChild(d);
    });
    grid.append(stage, dots);
    stage.addEventListener('mouseenter', stopTimer);   // 悬停暂停
    stage.addEventListener('mouseleave', startTimer);  // 移出恢复自动切换
    show(0);
  }

  async function loadPhotos() {
    let list = [];
    try {
      const res = await fetch('/api/photos');
      if (!res.ok) throw new Error('http ' + res.status);
      list = await res.json();
    } catch {
      setStatus('加载相册失败', false);
      return;
    }
    photos = list;
    if (!photos.length) { showEmpty('相册还是空的,去右上角传几张 ✧'); return; }
    buildSlideshow();
  }

  async function delPhoto(p) {
    if (!confirm('确定删除这张相册图片吗?')) return;
    try {
      const res = await fetch('/api/photos?name=' + encodeURIComponent(p.name), { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '删除失败'); }
      await loadPhotos(); // 重拉列表,重建轮播
    } catch (e) { setStatus('删除失败:' + e.message, false); }
  }

  // 上传:每张转 base64 逐张上传(photo 多图),成功后轻量重拉列表
  async function uploadFiles(files) {
    setStatus('上传中…', true);
    let ok = 0, fail = 0;
    for (const file of files) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('读取失败'));
          r.readAsDataURL(file);
        });
        const res = await fetch('/api/photos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: dataUrl }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'http ' + res.status);
        ok++;
      } catch (e) { fail++; }
    }
    if (fileInput) fileInput.value = '';
    setStatus(ok ? ('已上传 ' + ok + ' 张' + (fail ? ', ' + fail + ' 张失败' : '')) : ('上传失败 ' + fail + ' 张'), ok > 0);
    await loadPhotos(); // 实时刷新相册,新图立刻出现
  }

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', async () => {
      // 先确认站主身份:非 muxi 则不给上传(按钮未登录时本就隐藏)
      try {
        const me = await (await fetch('/api/me')).json();
        if (!me.canManage) return;
      } catch { return; }
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      if (files.length) uploadFiles(files);
    });
  }

  // 启动:仅站主有删除/上传;非站主隐藏右上角上传按钮并加载相册
  (async () => {
    try {
      const me = await (await fetch('/api/me')).json();
      canManage = !!me.canManage;
      if (!canManage && uploadBtn) uploadBtn.style.display = 'none';
    } catch {}
    await loadPhotos();
  })();
})();