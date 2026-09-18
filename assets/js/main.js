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
  hero.addEventListener('click', () => {
    const r = hero.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    ripple.style.setProperty('--cx', cx + 'px');
    ripple.style.setProperty('--cy', cy + 'px');
    document.body.classList.add('profile-reveal');
    hero.classList.add('is-hiding');
    setTimeout(() => { window.location.href = 'profile.html'; }, 750);
  });
}