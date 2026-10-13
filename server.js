// 沐玺博客后端 —— 薄入口
// 零依赖 Node 服务:http 静态服务器 + SQLite(db) + JSON API。
// 模块化后,业务逻辑拆到 src/:
//   src/config 路径/常量, src/db SQLite, src/auth 会话/密码, src/routes/* 各路由,
//   src/router 路由分发;本文件只负责装配 + 静态服务 + 监听。
// [ref] 参考 Asamiya-Shiina/blog 的模块化组织,但保留零第三方依赖(原生 http + node:sqlite)。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./src/db'); // 副作用:初始化 SQLite 与建表/迁移

const { PORT, HOST, UPLOAD_DIR, PHOTO_DIR, ensureDirs } = require('./src/config');
const { MIME, sendJSON, setSecurityHeaders } = require('./src/helpers');
const { dispatch } = require('./src/router');

const dir = __dirname;
ensureDirs();

// ---- 静态文件服务 ----
// HTML 页都放在 assets/html/ 下,但对外仍保持干净 URL(/,/admin.html 等),这里做一层内部映射。
const HTML_DIR = path.join(dir, 'assets', 'html');
const HTML_PAGES = new Set(['/index.html', '/admin.html', '/admin-editor.html', '/post.html', '/profile.html', '/status.html', '/404.html']);
// 找不到文件时兜底返回风格统一的自定义 404 页,比裸文本友好
function send404(res) {
  const file = path.join(HTML_DIR, '404.html');
  fs.readFile(file, (err, data) => {
    const headers = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' };
    if (err) { res.writeHead(404, headers); res.end('Not found'); return; }
    res.writeHead(404, headers);
    res.end(data);
  });
}
function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end('Bad request'); return; }
  if (p.includes('\0')) { res.writeHead(400); res.end('Bad request'); return; } // 拒绝 NUL,防同步抛异常崩溃
  if (p === '/') p = '/index.html';
  let root = dir;
  if (HTML_PAGES.has(p)) { root = HTML_DIR; p = p.slice(1); } // /index.html → index.html(相对 HTML_DIR)
  else if (p.startsWith('/uploads/')) { root = UPLOAD_DIR; p = p.slice('/uploads'.length); } // 上传文件从 UPLOAD_DIR 提供
  else if (p.startsWith('/photo/')) { root = PHOTO_DIR; p = p.slice('/photo'.length); }  // 相册图片从 PHOTO_DIR 提供
  const file = path.normalize(path.join(root, p));
  // 精确判定边界,防兄弟目录前缀绕过(如 dir 是 "...(2)" 时误放行 "...(2)x"...)
  if (!(file === root || file.startsWith(root + path.sep))) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { send404(res); return; }
    // 媒体文件(mp4/webm/mp3)走流式 + Range,支持断点/进度,是背景视频能播放的前提
    if (ext === '.mp4' || ext === '.webm' || ext === '.mp3') {
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= stat.size) end = stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        const rs = fs.createReadStream(file, { start, end });
        rs.on('error', () => res.destroy());
        rs.pipe(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      const s = fs.createReadStream(file);
      s.on('error', () => res.destroy());
      s.pipe(res);
      return;
    }
    // 其余文件简单 readFile(NUL 已在上面拒绝,不会同步抛异常)
    fs.readFile(file, (err2, data) => {
      if (err2) { send404(res); return; }
      // HTML 禁 bfcache(浏览器后退按钮走完整重载,避免水波遮罩残留);
      // JS 禁浏览器缓存,确保 main.js / admin.js 等改动生效,水波圆心能及时跟随新代码。
      const headers = { 'Content-Type': type };
      if (ext === '.html' || ext === '.htm') headers['Cache-Control'] = 'no-store';
      else if (ext === '.js') headers['Cache-Control'] = 'no-store';
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

// ---- 服务器 ----
// 路由分层:/api/* 交给 JSON 接口(异步,带错误兜底),其余按静态文件服务。
http.createServer((req, res) => {
  setSecurityHeaders(res);
  const u = req.url.split('#')[0];
  const qidx = u.indexOf('?');
  const pathname = qidx >= 0 ? u.slice(0, qidx) : u;
  if (pathname.startsWith('/api/')) {
    dispatch(req, res, pathname).catch((e) => {
      console.error(e);
      sendJSON(res, 500, { error: '服务器错误' });
    });
  } else {
    serveStatic(req, res, pathname);
  }
}).listen(PORT, HOST, () => {
  console.log(`Ciallo～ 博客运行中 →  http://${HOST}:${PORT}`);
  console.log(`后台管理 →  http://${HOST}:${PORT}/admin.html`);
  if (!getSetting('admin_password_hash')) console.log(`尚未设置管理员密码,首次访问后台将引导设置`);
});