// 全局页面切换过渡:点击处圆形水波扩散,再跳转目标页面(清新甜美风格)
(function (global) {
  const DURATION = 650; // 与 style.css 中 .ripple 的 transition 时长匹配
  let busy = false;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function startRipple(x, y) {
    const ripple = document.getElementById('ripple');
    if (!ripple || busy) return false;
    ripple.style.setProperty('--cx', x + 'px');
    ripple.style.setProperty('--cy', y + 'px');
    document.body.classList.add('profile-reveal');
    return true;
  }

  async function go(url, x, y, el) {
    if (busy) return;
    busy = true;
    if (el) el.classList.add('is-hiding');
    startRipple(x, y);
    await sleep(DURATION);
    location.href = url;
  }

  // 判断是否为站内链接(相对路径),外部链接/锚点/下载/新标签页等放行默认行为
  function isInternal(a) {
    const href = a.getAttribute('href') || '';
    if (a.target && a.target !== '_self') return false;
    if (a.rel && a.rel.split(/\s+/).indexOf('external') !== -1) return false;
    if (href.startsWith('http://') || href.startsWith('https://')) return false;
    if (href.startsWith('#')) return false;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return false;
    if (a.hasAttribute('download')) return false;
    return true;
  }

  // 事件委托:所有 <a> 内部链接点击时,从点击处触发水波过渡
  // 用事件委托可覆盖后加载/动态生成的链接(如首页 fetch 出的文章卡片)
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || !isInternal(a)) return;
    e.preventDefault();
    go(a.getAttribute('href'), e.clientX, e.clientY, a);
  });

  global.Trans = { go };
})(typeof window !== 'undefined' ? window : globalThis);