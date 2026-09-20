// 移动端菜单开合
const toggle = document.getElementById('menuToggle');
const menu = document.getElementById('menu');

toggle.addEventListener('click', () => menu.classList.toggle('open'));

// 点击菜单项后关闭
menu.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => menu.classList.remove('open'));
});

// ============ 进入个人简介：圆形水波扩散后跳转 ============
const hero = document.querySelector('.hero');
const ripple = document.getElementById('ripple');

if (hero && ripple) {
  hero.addEventListener('pointerdown', (e) => {
    // 圆心 = 鼠标事件坐标。直接写 inline clip-path + 强制 reflow,
    // 绕开 CSS 变量 circle() 在过渡中对 at 位置的插值偏移。
    const cx = e.clientX, cy = e.clientY;
    ripple.style.transition = 'none';
    ripple.style.clipPath = 'circle(0% at ' + cx + 'px ' + cy + 'px)';
    void ripple.offsetWidth;
    ripple.style.transition = 'clip-path .78s cubic-bezier(.65, 0, .35, 1)';
    ripple.style.clipPath = 'circle(150% at ' + cx + 'px ' + cy + 'px)';
    document.body.classList.add('profile-reveal');
    hero.classList.add('is-hiding');
    setTimeout(() => { window.location.href = 'profile.html'; }, 750);
  });
}