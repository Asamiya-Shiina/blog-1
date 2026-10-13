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
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(dir, 'uploads'));
const PHOTO_DIR = path.resolve(process.env.PHOTO_DIR || path.join(dir, 'photo'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    excerpt    TEXT NOT NULL DEFAULT '',
    tag        TEXT NOT NULL DEFAULT '',
    tags       TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);
try { db.exec("ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT ''"); } catch (e) { /* already has tags */ }

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

function scryptHash(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(pw) {
  const stored = getSetting('admin_password_hash') || '';
  try {
    if (stored.startsWith('scrypt$')) {
      const parts = stored.split('$');
      if (parts.length !== 3) return false;
      const salt = Buffer.from(parts[1], 'hex');
      const expected = Buffer.from(parts[2], 'hex');
      if (expected.length !== 32) return false;
      const h = crypto.scryptSync(String(pw), salt, 32);
      return h.length === expected.length && crypto.timingSafeEqual(h, expected);
    }
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(sha256(pw), 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) setSetting('admin_password_hash', scryptHash(pw));
    return ok;
  } catch { return false; }
}

const loginFails = new Map();
const MAX_LOGIN_FAILS = 5;
const LOGIN_WINDOW = 10 * 60 * 1000;
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(t);
  }
}, 10 * 60 * 1000).unref();

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

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const OWNER_USERNAME = 'muxi';
const CATEGORIES = ['前端开发', '技术随笔', '生活日常', '读书笔记'];
function getSession(req) {
  const token = getCookie(req, 'blog_token');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return null; }
  return s;
}
function clearSessionCookie(res) {
  try { res.setHeader('Set-Cookie', 'blog_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0'); } catch {}
}
function tryClearExpiredSessionCookie(req, res) {
  const token = getCookie(req, 'blog_token');
  if (!token) return;
  if (sessions.has(token)) return;
  clearSessionCookie(res);
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
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      data += c;
      if (bytes > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sniffImage(ext, b) {
  if (b.length < 12) return false;
  if (ext === '.png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ext === '.jpg' || ext === '.jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === '.gif') return b.slice(0, 6).toString('ascii') === 'GIF89a' || b.slice(0, 6).toString('ascii') === 'GIF87a';
  if (ext === '.webp') return b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

const HTML_DIR = path.join(dir, 'assets', 'html');
const HTML_PAGES = new Set(['/index.html', '/admin.html', '/post.html', '/profile.html', '/404.html']);
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
  if (p.includes('\0')) { res.writeHead(400); res.end('Bad request'); return; }
  if (p === '/') p = '/index.html';
  let root = dir;
  if (HTML_PAGES.has(p)) { root = HTML_DIR; p = p.slice(1); }
  else if (p.startsWith('/uploads/')) { root = UPLOAD_DIR; p = p.slice('/uploads'.length); }
  else if (p.startsWith('/photo/')) { root = PHOTO_DIR; p = p.slice('/photo'.length); }
  const file = path.normalize(path.join(root, p));
  if (!(file === root || file.startsWith(root + path.sep))) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { send404(res); return; }
    if (ext === '.mp4' || ext === '.webm' || ext === '.mp3') {
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = 0, end = stat.size - 1;
        if (m && m[1]) start = parseInt(m[1], 10);
        if (m && m[2]) end   = parseInt(m[2], 10);
        if (isNaN(start)) start = 0;
        if (m && !m[1] && m[2]) {
          const n = parseInt(m[2], 10);
          start = Math.max(0, stat.size - n);
          end = stat.size - 1;
        } else if (isNaN(end) || end >= stat.size) {
          end = stat.size - 1;
        }
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
    const cache = (ext === '.html') ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

async function handleAPI(req, res, pathname) {
  if (pathname === '/api/posts' && req.method === 'GET') {
    const rows = db.prepare(
      'SELECT id, title, excerpt, tag, tags, created_at, updated_at FROM posts ORDER BY created_at DESC, id DESC'
    ).all();
    return sendJSON(res, 200, rows);
  }
  if (pathname === '/api/categories' && req.method === 'GET') {
    return sendJSON(res, 200, { categories: CATEGORIES });
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    tryClearExpiredSessionCookie(req, res);
    const s = getSession(req);
    return sendJSON(res, 200, {
      loggedIn: !!s,
      username: s ? s.username : null,
      canManage: isOwner(req),
      needsSetup: !getSetting('admin_password_hash'),
    });
  }
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
      .sort((a, b) => b.mtime - a.mtime);
    return sendJSON(res, 200, list);
  }
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
      const inWindow = rec && rec.ts && (now - rec.ts < LOGIN_WINDOW);
      const count = (inWindow ? rec.count : 0) + 1;
      const until = count >= MAX_LOGIN_FAILS ? now + LOGIN_WINDOW : 0;
      loginFails.set(ip, { count, until, ts: now });
      if (loginFails.size > 10000) loginFails.delete(loginFails.keys().next().value);
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
  if (pathname === '/api/photos' && req.method === 'DELETE') {
    if (!isOwner(req)) return sendJSON(res, 403, { error: '仅站主可删除' });
    const qs = new URL(req.url, 'http://x').searchParams;
    const raw = String(qs.get('name') || '').trim();
    if (!raw) return sendJSON(res, 400, { error: '缺少 name 参数' });
    const name = path.basename(raw);
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
    const seen = new Set();
    const list = String(p.tags || '')
      .split(/[,，、\s]+/)
      .map((s) => s.trim().slice(0, 30))
      .filter((s) => s && !seen.has(s) && seen.add(s));
    const tags = list.slice(0, 12).join(',');
    if (!title) return null;
    return { title, tag, excerpt, content, tags };
  }
  if (pathname === '/api/posts' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const p = cleanPost(body);
    if (!p) return sendJSON(res, 400, { error: '标题不能为空' });
    const info = db.prepare('INSERT INTO posts (title, excerpt, tag, tags, content) VALUES (?, ?, ?, ?, ?)')
      .run(p.title, p.excerpt, p.tag, p.tags, p.content);
    return sendJSON(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }
  let m = pathname.match(/^\/api\/posts\/(\d+)$/);
  if (m && req.method === 'PUT') {
    const id = Number(m[1]);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const p = cleanPost(body);
    if (!p) return sendJSON(res, 400, { error: '标题不能为空' });
    const info = db.prepare(
      "UPDATE posts SET title=?, excerpt=?, tag=?, tags=?, content=?, updated_at=datetime('now','localtime') WHERE id=?"
    ).run(p.title, p.excerpt, p.tag, p.tags, p.content, id);
    if (info.changes === 0) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, { ok: true });
  }
  if (m && req.method === 'DELETE') {
    const info = db.prepare('DELETE FROM posts WHERE id = ?').run(Number(m[1]));
    if (info.changes === 0) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, { ok: true });
  }
  tryClearExpiredSessionCookie(req, res);
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
    if (!sniffImage(ext, buf)) return sendJSON(res, 400, { error: '文件内容不是有效图片' });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    const file = path.join(UPLOAD_DIR, name);
    if (!file.startsWith(UPLOAD_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    return sendJSON(res, 200, { name, url: '/uploads/' + encodeURIComponent(name) });
  }
  return sendJSON(res, 404, { error: 'not found' });
}

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
  console.log('Ciallo～ 博客运行中 →  http://' + HOST + ':' + PORT);
  console.log('后台管理 →  http://' + HOST + ':' + PORT + '/admin.html');
  if (!getSetting('admin_password_hash')) console.log('尚未设置管理员密码,首次访问后台将引导设置');
});
