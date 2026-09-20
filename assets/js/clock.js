// 顶端导航实时时钟:问候语按时段切换(早上好/中午好/下午好/晚上好),秒实时跳动。
// 渐变动效与过渡在 style.css(.brand-clock 系列),这里只负责数据更新。
(function () {
  var greet = document.getElementById('bcGreet');
  var time = document.getElementById('bcTime');
  if (!greet || !time) return;

  function greeting(h) {
    if (h >= 5 && h < 12) return '早上好 ☀️';
    if (h >= 12 && h < 14) return '中午好 🕛';
    if (h >= 14 && h < 18) return '下午好 🍵';
    return '晚上好 🌙';
  }
  var lastGreet = '';
  var pad = function (n) { return String(n).padStart(2, '0'); };

  // 问候切换:先淡出,切字后淡入(避免同字重复触发)
  function swapGreet(txt) {
    greet.style.transition = 'opacity .3s ease';
    greet.style.opacity = '0';
    setTimeout(function () {
      greet.textContent = txt;
      greet.style.opacity = '1';
    }, 300);
  }

  function tick() {
    var now = new Date();
    var h = now.getHours();
    var g = greeting(h);
    if (g !== lastGreet) { swapGreet(g); lastGreet = g; }
    time.textContent = pad(h) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  }

  tick();
  setInterval(tick, 1000);
})();