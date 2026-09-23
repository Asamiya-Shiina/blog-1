// 共享 HTML 分片统一注入:页面用空占位 <div data-part="bg|player|footer"> 声明需要哪块,
// 这里按需 fetch /assets/html/_<part>.html 并把占位替换成内容,避免各页重复手写。
// 完成后派发本次只加载的本地事件 partials-ready,依赖注入 DOM 的脚本(player.js)据此等待。
(function () {
  var slots = Array.prototype.slice.call(document.querySelectorAll('[data-part]'));
  if (!slots.length) return;

  var jobs = slots.map(function (slot) {
    var name = slot.getAttribute('data-part');
    return fetch('/assets/html/_' + name + '.html')
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) {
        if (!html) return;
        var tpl = document.createElement('template');
        tpl.innerHTML = html;
        slot.replaceWith(tpl.content);
      })
      .catch(function () {});
  });

  Promise.all(jobs).then(function () {
    document.dispatchEvent(new Event('partials-ready'));
  });
})();