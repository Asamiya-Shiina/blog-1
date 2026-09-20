// 播放器挂在每个页面右下角,跨页面靠 localStorage 续播。
// 存了四样东西:进度、是否在播、是否展开、拖到的位置。
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
  const mpVol = document.getElementById('mpVol');
  const mpVolBtn = document.getElementById('mpVolBtn');
  const mpVolume = document.getElementById('mpVolume');

  const STORE_KEY = 'muxi_player_state';
  const VOLUME_KEY = 'muxi_player_volume';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { saved = {}; }

  // 跳页进来先恢复两个外观:展开态、拖动位置。没拖过的话 left/top 是空,就走 CSS 默认。
  if (saved.expanded) player.classList.add('open');
  if (saved.left && saved.top) {
    player.style.left = saved.left;
    player.style.top = saved.top;
    player.style.right = 'auto';
    player.style.bottom = 'auto';
  }

  // 音量:默认 40%(别满格太吵),持久化到 localStorage;
  // 未存过(首次)才用默认值,否则 Number(null)=0 会把默认设成静音
  const storedVol = localStorage.getItem(VOLUME_KEY);
  mpAudio.volume = storedVol === null ? 0.4 : Number(storedVol);
  if (!(mpAudio.volume >= 0 && mpAudio.volume <= 1)) mpAudio.volume = 0.4;
  if (mpVolume) mpVolume.value = mpAudio.volume;

  function paintVol() {
    if (!mpVolume) return;
    const pct = Math.round(mpAudio.volume * 100);
    mpVolume.style.background = `linear-gradient(to top, #c0392b 0%, #e67e22 ${pct}%, var(--border) ${pct}%)`;
    if (mpVolBtn) {
      mpVolBtn.textContent = mpAudio.volume <= 0 ? '🔇' : (mpAudio.volume < 0.5 ? '🔉' : '🔊');
    }
  }
  paintVol();

  if (mpVolume) {
    mpVolume.addEventListener('input', () => {
      mpAudio.volume = Number(mpVolume.value);
      localStorage.setItem(VOLUME_KEY, String(mpAudio.volume));
      paintVol();
    });
  }
  // 喇叭按钮弹出垂直音量条;stopPropagation 是为了不触发外层的“首次点击解锁”逻辑
  if (mpVolBtn && mpVol) {
    mpVolBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mpVol.classList.toggle('open');
    });
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        currentTime: mpAudio.currentTime || 0,
        playing: !mpAudio.paused,
        expanded: player.classList.contains('open'),
        left: player.style.left || '',
        top: player.style.top || '',
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

  // 元数据拿到之后:显示总时长、跳回上次进度、进度条同步
  mpAudio.addEventListener('loadedmetadata', () => {
    if (mpDuration) mpDuration.textContent = fmt(mpAudio.duration);
    const t = Number(saved.currentTime) || 0;
    if (t > 0 && t < mpAudio.duration) { try { mpAudio.currentTime = t; } catch (e) {} }
    if (mpFill && mpAudio.duration) mpFill.style.width = (t / mpAudio.duration * 100) + '%';
  });

  // 边播边存,但节流到 3 秒一次(不能每帧都写 localStorage)
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

  // 悬浮按钮同时承担两个动作:拖动(改位置)、点击(展开/合并面板)。
  // 用位移阈值区分:动过就算拖,没动过才算点击。
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
      // 切到 inline 定位才能用 left/top,清掉 CSS 默认的 right/bottom 锚点
      player.style.left = r.left + 'px';
      player.style.top = r.top + 'px';
      player.style.right = 'auto';
      player.style.bottom = 'auto';
      mpToggle.setPointerCapture(e.pointerId);
    });
    mpToggle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      // 5px 阈值:轻微抖动不算拖,避免误触
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
      if (moved) save(); // 拖完存位置
      else { player.classList.toggle('open'); save(); } // 点完存展开态
    });
  }

  // 跳页前再存一次,兜底(比如秒级 force quit 时节流的那 3 秒可能没赶上)
  document.addEventListener('pagehide', save);
  document.addEventListener('beforeunload', save);

  // Chrome 系不让没手势就自动播,所以第一次点页面任意位置时尝试续播;
  // 仅当上次离开时在播(saved.playing)才真播,否则只是预热 mpAudio,
  // 避免静音进入页面后被人不经意地点开出声。
  const unlock = () => {
    document.removeEventListener('click', unlock);
    if (saved.playing && mpAudio.paused) mpAudio.play().catch(() => {});
  };
  document.addEventListener('click', unlock);

  // 必须等 canplay(已经能播)再按 saved.playing 续播,
  // 否则从 0 开始播一秒再被 seek 到上次位置,会有“跳一下”的体验
  mpAudio.addEventListener('canplay', () => {
    if (saved.playing && mpAudio.paused) mpAudio.play().catch(() => {});
  });
})();