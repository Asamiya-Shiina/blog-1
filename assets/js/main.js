// 移动端菜单开合
const toggle = document.getElementById('menuToggle');
const menu = document.getElementById('menu');

toggle.addEventListener('click', () => menu.classList.toggle('open'));

// 点击菜单项后关闭
menu.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => menu.classList.remove('open'));
});

// ============ 悬浮音乐播放器 ============
const player = document.getElementById('musicPlayer');
const mpAudio = document.getElementById('mpAudio');
const mpPlay = document.getElementById('mpPlay');
const mpToggle = document.getElementById('mpToggle');
const mpFill = document.getElementById('mpFill');
const mpCurrent = document.getElementById('mpCurrent');
const mpDuration = document.getElementById('mpDuration');
const mpBar = document.getElementById('mpBar');

function fmt(t) {
  if (isNaN(t)) return '--:--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function setPlaying(playing) {
  player.classList.toggle('playing', playing);
  mpPlay.textContent = playing ? '❚❚' : '▶';
}

// 按钮可拖动，拖动结束后无位移才当作“点击”（开合面板）
let dragging = false;
let moved = false;
let startX = 0, startY = 0, startLeft = 0, startTop = 0;

function clampPos(x, y) {
  const w = player.offsetWidth;
  const h = player.offsetHeight;
  const maxX = window.innerWidth - w;
  const maxY = window.innerHeight - h;
  return [Math.min(Math.max(0, x), maxX), Math.min(Math.max(0, y), maxY)];
}

mpToggle.addEventListener('pointerdown', (e) => {
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  const rect = player.getBoundingClientRect();
  startLeft = rect.left;
  startTop = rect.top;
  player.style.left = rect.left + 'px';
  player.style.top = rect.top + 'px';
  player.style.right = 'auto';
  player.style.bottom = 'auto';
  mpToggle.setPointerCapture(e.pointerId);
});

mpToggle.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
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

mpPlay.addEventListener('click', () => {
  if (mpAudio.paused) {
    mpAudio.play();
  } else {
    mpAudio.pause();
  }
});

mpAudio.addEventListener('play', () => setPlaying(true));
mpAudio.addEventListener('pause', () => setPlaying(false));
mpAudio.addEventListener('ended', () => { setPlaying(false); mpCurrent.textContent = '00:00'; mpFill.style.width = '0%'; });

mpAudio.addEventListener('loadedmetadata', () => {
  mpDuration.textContent = fmt(mpAudio.duration);
});

mpAudio.addEventListener('timeupdate', () => {
  mpCurrent.textContent = fmt(mpAudio.currentTime);
  if (mpAudio.duration) {
    mpFill.style.width = (mpAudio.currentTime / mpAudio.duration * 100) + '%';
  }
});

mpBar.addEventListener('click', (e) => {
  const rect = mpBar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  if (mpAudio.duration) {
    mpAudio.currentTime = ratio * mpAudio.duration;
  }
});