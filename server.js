const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const dir = __dirname;
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(dir, 'blog.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(dir, 'uploads');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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
const sessions = new Map(); // token -> { createdAt }
let sessionSeq = 0;

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
};

// ---- 帮助函数 ----
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 与登录 cookie 的 Max-Age 一致(604800s)
function requireAuth(req) {
  const token = getCookie(req, 'blog_token');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return null; } // 服务端强制过期,可吊销
  return token;
}

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
  const file = path.normalize(path.join(root, p));
  // 精确判定边界,防兄弟目录前缀绕过(如 dir 是 "...(2)" 时误放行 "...(2)x"...)
  if (!(file === root || file.startsWith(root + path.sep))) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  } catch { res.writeHead(400); res.end('Bad request'); return; }
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
    sessions.set(token, { createdAt: Date.now() });
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
    return sendJSON(res, 200, {
      loggedIn: !!requireAuth(req),
      needsSetup: !getSetting('admin_password_hash'), // 尚未设置管理员密码则引导进入设置页
    });
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
    sessions.set(token, { createdAt: Date.now() });
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