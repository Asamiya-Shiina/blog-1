// 全局悬浮音乐播放器:进度/播放状态用 localStorage 持久化,刷新或跨页面跳转后
// 自动从上次位置继续播放、进度条继承。需要在页面存在对应播放器 DOM。
(function () {
  const player = document.getElementById('musicPlayer');
  const mpAudio = document.getElementById('mpAudio');
  if (!player || !mpAudio) return;

  const mpPlay = document.getElementById('mpPlay');
  const mpToggle = document.getElementById('mpToggle');
  const mpFill = document.getElementById('mpFill');
  const mpCurrent = document.getElementById('mpCurrent');
  const mpDuration = document.getElementById('mpDuration');
  const mpBar = document.getElementById('mpBar');

  const STORE_KEY = 'muxi_player_state';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { saved = {}; }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        currentTime: mpAudio.currentTime || 0,
        playing: !mpAudio.paused
      }));
    } catch (e) {}
  }

  function fmt(t) {
    if (isNaN(t)) return '--:--';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  function setPlaying(p) {
    player.classList.toggle('playing', p);
    if (mpPlay) mpPlay.textContent = p ? '❚❚' : '▶';
  }

  // 元数据就绪后:显示总时长、跳到上次进度、恢复进度条
  mpAudio.addEventListener('loadedmetadata', () => {
    if (mpDuration) mpDuration.textContent = fmt(mpAudio.duration);
    const t = Number(saved.currentTime) || 0;
    if (t > 0 && t < mpAudio.duration) { try { mpAudio.currentTime = t; } catch (e) {} }
    if (mpFill && mpAudio.duration) mpFill.style.width = (t / mpAudio.duration * 100) + '%';
  });

  // 播放中持续保存进度(节流),避免进度丢失;暂停/结束也存一次
  let lastSave = 0;
  mpAudio.addEventListener('timeupdate', () => {
    if (mpCurrent) mpCurrent.textContent = fmt(mpAudio.currentTime);
    if (mpFill && mpAudio.duration) mpFill.style.width = (mpAudio.currentTime / mpAudio.duration * 100) + '%';
    const now = Date.now();
    if (now - lastSave > 3000) { lastSave = now; save(); }
  });

  mpAudio.addEventListener('play', () => setPlaying(true));
  mpAudio.addEventListener('pause', () => { setPlaying(false); save(); });
  mpAudio.addEventListener('ended', () => {
    setPlaying(false);
    if (mpCurrent) mpCurrent.textContent = '00:00';
    if (mpFill) mpFill.style.width = '0%';
  });

  if (mpPlay) mpPlay.addEventListener('click', () => (mpAudio.paused ? mpAudio.play() : mpAudio.pause()));
  if (mpBar) mpBar.addEventListener('click', (e) => {
    const r = mpBar.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    if (mpAudio.duration) mpAudio.currentTime = ratio * mpAudio.duration;
  });

  // 悬浮按钮可拖动,无位移才算“点击”(开合面板)
  let dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  function clampPos(x, y) {
    const w = player.offsetWidth, h = player.offsetHeight;
    return [Math.min(Math.max(0, x), innerWidth - w), Math.min(Math.max(0, y), innerHeight - h)];
  }
  if (mpToggle) {
    mpToggle.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      const r = player.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      player.style.left = r.left + 'px';
      player.style.top = r.top + 'px';
      player.style.right = 'auto';
      player.style.bottom = 'auto';
      mpToggle.setPointerCapture(e.pointerId);
    });
    mpToggle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (moved) {
        const [x, y] = clampPos(startLeft + dx, startTop + dy);
        player.style.left = x + 'px';
        player.style.top = y + 'px';
      }
    });
    mpToggle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) player.classList.toggle('open');
    });
  }

  // 离开页面前保存进度与播放态
  document.addEventListener('pagehide', save);
  document.addEventListener('beforeunload', save);

  // 首次点击任意处解锁续播(浏览器自动播放策略需一次手势)
  const unlock = () => {
    document.removeEventListener('click', unlock);
    if (mpAudio.paused) mpAudio.play().catch(() => {});
  };
  document.addEventListener('click', unlock);

  // 等元数据就绪并把进度 seek 到上次位置之后,才按“上次在播放”续播,避免从 0 开播
  mpAudio.addEventListener('canplay', () => {
    if (saved.playing && mpAudio.paused) mpAudio.play().catch(() => {});
  });
})();