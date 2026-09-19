// 沐玺博客后端
// 零依赖 Node 服务:http 静态服务器 + SQLite(db) + JSON API。
// 数据持久化 —— 数据库与上传目录可通过环境变量外置(Docker 场景挂命名卷):
//   PORT / HOST / DB_PATH / UPLOAD_DIR
// 认证 —— 后台用 HttpOnly cookie 会话;无写死的默认密码,首次运行走 /api/setup 设置。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const dir = __dirname;
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(dir, 'blog.db');
// resolve 统一路径分隔符(避免 Windows 下环境变量为 "/" 而 path.join 归一成 "\" 导致
// startsWith 目录校验误判为越权 forbidden)
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(dir, 'uploads'));
const PHOTO_DIR = path.resolve(process.env.PHOTO_DIR || path.join(dir, 'photo'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    excerpt    TEXT NOT NULL DEFAULT '',
    tag        TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// 密码用 scrypt 加盐哈希。启动时写入;旧版无盐 sha256 会在登录成功后自动升级。
function scryptHash(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(pw) {
  const stored = getSetting('admin_password_hash') || '';
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const h = crypto.scryptSync(String(pw), Buffer.from(parts[1], 'hex'), 32);
    const a = Buffer.from(parts[2], 'hex');
    return a.length === h.length && crypto.timingSafeEqual(a, h);
  }
  // 旧格式:无盐 sha256,命中后升级为 scrypt
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(sha256(pw), 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (ok) setSetting('admin_password_hash', scryptHash(pw));
  return ok;
}

// 登录失败限流:每 IP 记录失败次数,超限后锁 10 分钟,防暴力破解
const loginFails = new Map(); // ip -> { count, until }
const MAX_LOGIN_FAILS = 5;
const LOGIN_WINDOW = 10 * 60 * 1000;

// ---- 会话(内存) ----
// 会话只存进程内存:重启即全部失效(需重新登录),适合单机/小规模场景。
const sessions = new Map(); // token -> { createdAt }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// ---- 帮助函数 ----
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 与登录 cookie 的 Max-Age 一致(604800s)
// 唯一管理员即站主(muxi)。删除/上传等敏感操作仅对站主开放;将来若加普通账号,isOwner 会拦下对方。
const OWNER_USERNAME = 'muxi';
function getSession(req) {
  const token = getCookie(req, 'blog_token');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return null; } // 服务端强制过期,可吊销
  return s;
}
function requireAuth(req) { return !!getSession(req); }
function isOwner(req) { const s = getSession(req); return !!s && s.username === OWNER_USERNAME; }

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 校验常见图片格式的文件头魔数,防止任意内容伪装成图片
function sniffImage(ext, b) {
  if (b.length < 12) return false;
  if (ext === '.png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ext === '.jpg' || ext === '.jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === '.gif') return b.slice(0, 6).toString('ascii') === 'GIF89a' || b.slice(0, 6).toString('ascii') === 'GIF87a';
  if (ext === '.webp') return b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

// ---- 安全响应头(针对所有响应) ----
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

// ---- 静态文件服务 ----
function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end('Bad request'); return; }
  if (p.includes('\0')) { res.writeHead(400); res.end('Bad request'); return; } // 拒绝 NUL,防同步抛异常崩溃
  if (p === '/') p = '/index.html';
  let root = dir;
  if (p.startsWith('/uploads/')) { root = UPLOAD_DIR; p = p.slice('/uploads'.length); } // 上传文件从 UPLOAD_DIR 提供
  else if (p.startsWith('/photo/')) { root = PHOTO_DIR; p = p.slice('/photo'.length); }  // 相册图片从 PHOTO_DIR 提供
  const file = path.normalize(path.join(root, p));
  // 精确判定边界,防兄弟目录前缀绕过(如 dir 是 "...(2)" 时误放行 "...(2)x"...)
if (!(file === root || file.startsWith(root + path.sep))) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
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
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });
}

// ---- API 路由 ----
async function handleAPI(req, res, pathname) {
  if (pathname === '/api/posts' && req.method === 'GET') {
    const rows = db.prepare(
      'SELECT id, title, excerpt, tag, created_at, updated_at FROM posts ORDER BY created_at DESC, id DESC'
    ).all();
    return sendJSON(res, 200, rows);
  }

  let m = pathname.match(/^\/api\/posts\/(\d+)$/);
  if (m && req.method === 'GET') {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(m[1]));
    if (!post) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, post);
  }

  // 以下均为需要登录的操作
  if (pathname === '/api/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const ip = req.socket.remoteAddress || 'local';
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (rec && rec.until > now) {
      return sendJSON(res, 429, { error: '尝试次数过多,请 ' + Math.ceil((rec.until - now) / 1000) + ' 秒后再试' });
    }
    if (!verifyPassword((body && body.password) || '')) {
      const count = (rec && rec.until > now ? rec.count : 0) + 1; // 超出锁定窗口后重新计数
      loginFails.set(ip, { count, until: count >= MAX_LOGIN_FAILS ? now + LOGIN_WINDOW : 0 });
      if (loginFails.size > 10000) loginFails.delete(loginFails.keys().next().value); // 防 Map 无限增长
      return sendJSON(res, 401, { error: '密码错误' });
    }
    if (rec) loginFails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { createdAt: Date.now(), username: OWNER_USERNAME });
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Set-Cookie': 'blog_token=' + token + '; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const t = getCookie(req, 'blog_token');
    if (t) sessions.delete(t);
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Set-Cookie': 'blog_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const s = getSession(req);
    return sendJSON(res, 200, {
      loggedIn: !!s,
      username: s ? s.username : null,
      canManage: isOwner(req), // 删除/上传仅对站主(muxi)开放
      needsSetup: !getSetting('admin_password_hash'), // 尚未设置管理员密码则引导进入设置页
    });
  }

  // 相册图片列表(公开):主页展示。按修改时间倒序,新上传的靠前,不限数量。
  if (pathname === '/api/photos' && req.method === 'GET') {
    const IMG = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    let names = [];
    try { names = fs.readdirSync(PHOTO_DIR); } catch { names = []; }
    const list = names
      .filter((n) => IMG.includes(path.extname(n).toLowerCase()))
      .map((n) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(PHOTO_DIR, n)).mtimeMs; } catch {}
        return { name: n, url: '/photo/' + encodeURIComponent(n), mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // 新的在前
    return sendJSON(res, 200, list);
  }

  // 首次设置管理员密码:仅当尚无密码时允许(公开,不需登录),一设即成登录态
  if (pathname === '/api/setup' && req.method === 'POST') {
    if (getSetting('admin_password_hash')) return sendJSON(res, 409, { error: '管理员密码已设置' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const pw = (body && body.password) || '';
    if (pw.length < 6) return sendJSON(res, 400, { error: '密码至少 6 位' });
    setSetting('admin_password_hash', scryptHash(pw));
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { createdAt: Date.now(), username: OWNER_USERNAME });
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Set-Cookie': 'blog_token=' + token + '; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });

  m = pathname.match(/^\/api\/upload$/);
  if (m && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const dataUrl = String((body && body.data) || '');
    const bm = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!bm) return sendJSON(res, 400, { error: '仅支持图片' });
    const ext = '.' + bm[1].replace('jpeg', 'jpg');
    const buf = Buffer.from(bm[2], 'base64');
    // 校验文件头魔数,拒绝"披着 png 外衣的任意内容"(如伪装成图片的 HTML/SVG 等)
    if (!sniffImage(ext, buf)) return sendJSON(res, 400, { error: '文件内容不是有效图片' });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    const file = path.join(UPLOAD_DIR, name);
    if (!file.startsWith(UPLOAD_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    return sendJSON(res, 200, { url: '/uploads/' + name });
  }

  // 相册上传(仅站主):base64 图片 → photo/。与文章插图(uploads/)独立。
  if (pathname === '/api/photos' && req.method === 'POST') {
    if (!isOwner(req)) return sendJSON(res, 403, { error: '仅站主可上传' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const dataUrl = String((body && body.data) || '');
    const bm = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!bm) return sendJSON(res, 400, { error: '仅支持图片' });
    const ext = '.' + bm[1].replace('jpeg', 'jpg');
    const buf = Buffer.from(bm[2], 'base64');
    if (!sniffImage(ext, buf)) return sendJSON(res, 400, { error: '文件内容不是有效图片' });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    const file = path.join(PHOTO_DIR, name);
    if (!file.startsWith(PHOTO_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    return sendJSON(res, 200, { name, url: '/photo/' + encodeURIComponent(name) });
  }

  // 相册删除(仅站主):按文件名删除 photo/ 下的图片,防目录穿越。
  if (pathname === '/api/photos' && req.method === 'DELETE') {
    if (!isOwner(req)) return sendJSON(res, 403, { error: '仅站主可删除' });
    const qs = new URL(req.url, 'http://x').searchParams;
    const raw = String(qs.get('name') || '').trim();
    if (!raw) return sendJSON(res, 400, { error: '缺少 name 参数' });
    const name = path.basename(decodeURIComponent(raw)); // 只取文件名,杜绝 ../ 穿越
    const file = path.join(PHOTO_DIR, name);
    if (!file.startsWith(PHOTO_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    return fs.promises.unlink(file)
      .then(() => sendJSON(res, 200, { ok: true }))
      .catch(() => sendJSON(res, 404, { error: '图片不存在' }));
  }

  function cleanPost(b) {
    const p = b || {};
    const title = String(p.title || '').trim().slice(0, 200);
    const tag = String(p.tag || '').trim().slice(0, 50);
    const excerpt = String(p.excerpt || '').trim().slice(0, 500);
    const content = String(p.content || '');
    if (!title) return null;
    return { title, tag, excerpt, content };
  }

  if (pathname === '/api/posts' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const p = cleanPost(body);
    if (!p) return sendJSON(res, 400, { error: '标题不能为空' });
    const info = db.prepare('INSERT INTO posts (title, excerpt, tag, content) VALUES (?, ?, ?, ?)')
      .run(p.title, p.excerpt, p.tag, p.content);
    return sendJSON(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }

  m = pathname.match(/^\/api\/posts\/(\d+)$/);
  if (m && req.method === 'PUT') {
    const id = Number(m[1]);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const p = cleanPost(body);
    if (!p) return sendJSON(res, 400, { error: '标题不能为空' });
    const info = db.prepare(
      "UPDATE posts SET title=?, excerpt=?, tag=?, content=?, updated_at=datetime('now','localtime') WHERE id=?"
    ).run(p.title, p.excerpt, p.tag, p.content, id);
    if (info.changes === 0) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, { ok: true });
  }

  if (m && req.method === 'DELETE') {
    const info = db.prepare('DELETE FROM posts WHERE id = ?').run(Number(m[1]));
    if (info.changes === 0) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'not found' });
}

// ---- 服务器 ----
// 路由分层:/api/* 交给 JSON 接口(异步,带错误兜底),其余按静态文件服务。
http.createServer((req, res) => {
  setSecurityHeaders(res);
  const u = req.url.split('#')[0];
  const qidx = u.indexOf('?');
  const pathname = qidx >= 0 ? u.slice(0, qidx) : u;
  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname).catch((e) => {
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