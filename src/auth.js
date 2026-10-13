// 认证与会话：scrypt 加盐密码、HttpOnly cookie 会话、登录失败限流、权限判定。
'use strict';
const crypto = require('crypto');
const { getSetting, setSetting } = require('./db');
const { OWNER_USERNAME, SESSION_TTL, MAX_LOGIN_FAILS, LOGIN_WINDOW } = require('./config');

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

// 登录失败限流:每 IP 记录失败次数,超限后锁 LOGIN_WINDOW,防暴力破解
const loginFails = new Map(); // ip -> { count, until, ts }

// ---- 会话(内存) ---- 重启即全部失效(需重新登录),适合单机/小规模场景。
const sessions = new Map(); // token -> { createdAt, username }
// exe 客户端的独立会话,与后台 admin 会话分离,各自鉴权互不污染。
const clientTokens = new Map(); // token -> { createdAt }

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

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

// ---- 客户端(exe)会话 ---- 用 X-Client-Token 请求头,不与 admin cookie 会话混用。
function issueClientToken() {
  const token = crypto.randomBytes(24).toString('hex');
  clientTokens.set(token, { createdAt: Date.now() });
  return token;
}
function getClientToken(req) {
  const token = req.headers['x-client-token'];
  if (!token) return null;
  const s = clientTokens.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { clientTokens.delete(token); return null; }
  return token;
}
function requireClient(req) { return !!getClientToken(req); }

// 建立会话并写入 HttpOnly cookie。token 由调用方生成并放入 sessions。
function setSessionCookie(res, token) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'blog_token=' + token + '; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800',
  });
}
function clearSessionCookie(res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'blog_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
  });
}

module.exports = {
  sessions, loginFails, clientTokens,
  verifyPassword, scryptHash, sha256, getCookie,
  getSession, requireAuth, isOwner, setSessionCookie, clearSessionCookie,
  issueClientToken, getClientToken, requireClient,
  MAX_LOGIN_FAILS, LOGIN_WINDOW,
};