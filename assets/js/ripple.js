// 圆形水波过渡:点击任何带 data-ripple 的元素,从鼠标位置扩散渐变遮罩,然后跳转元素的 href。
// 用法:HTML 里放 `<div class="ripple" id="ripple"></div>`,跳转元素加属性 `data-ripple`。
// 依赖:ripple.css 提供 .ripple / body.profile-reveal 的样式。
(function () {
  const ripple = document.getElementById('ripple');
  if (!ripple) return;
  document.querySelectorAll('[data-ripple]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      // 圆心 = 鼠标坐标。直接 inline clip-path + 强制 reflow,
      // 绕开 CSS 变量 circle() 在过渡中对 at 位置的插值偏移(实测会偏)。
      const cx = e.clientX, cy = e.clientY;
      ripple.style.transition = 'none';
      ripple.style.clipPath = 'circle(0% at ' + cx + 'px ' + cy + 'px)';
      void ripple.offsetWidth;
      ripple.style.transition = 'clip-path .78s cubic-bezier(.65, 0, .35, 1)';
      ripple.style.clipPath = 'circle(150% at ' + cx + 'px ' + cy + 'px)';
      document.body.classList.add('profile-reveal');
      setTimeout(() => { window.location.href = el.getAttribute('href'); }, 750);
    });
  });
})();
