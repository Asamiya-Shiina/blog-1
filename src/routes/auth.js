// 认证路由:登录 / 登出 / 当前态(me) / 首次设置密码。
'use strict';
const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');
const { OWNER_USERNAME } = require('../config');
const { sendJSON, readBody } = require('../helpers');
const {
  sessions, loginFails, verifyPassword, scryptHash, getCookie,
  getSession, isOwner, setSessionCookie, clearSessionCookie,
  MAX_LOGIN_FAILS, LOGIN_WINDOW,
} = require('../auth');

function createTokenSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { createdAt: Date.now(), username: OWNER_USERNAME });
  return token;
}

const routes = [
  // 登录(公开,带失败限流)
  { method: 'POST', match: /^\/api\/login$/, handler: async (req, res) => {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const ip = req.socket.remoteAddress || 'local';
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (rec && rec.until > now) {
      return sendJSON(res, 429, { error: '尝试次数过多,请 ' + Math.ceil((rec.until - now) / 1000) + ' 秒后再试' });
    }
    if (!verifyPassword((body && body.password) || '')) {
      // 连续失败计数:用 ts 判断是否仍在计次窗口内(间隔超 LOGIN_WINDOW 则重新计),
      // 累计到 MAX_LOGIN_FAILS 次即锁定 LOGIN_WINDOW。锁定时上面已 429 拦截。
      const inWindow = rec && rec.ts && (now - rec.ts < LOGIN_WINDOW);
      const count = (inWindow ? rec.count : 0) + 1;
      const until = count >= MAX_LOGIN_FAILS ? now + LOGIN_WINDOW : 0;
      loginFails.set(ip, { count, until, ts: now });
      if (loginFails.size > 10000) loginFails.delete(loginFails.keys().next().value); // 防 Map 无限增长
      return sendJSON(res, 401, { error: '密码错误' });
    }
    if (rec) loginFails.delete(ip);
    setSessionCookie(res, createTokenSession());
    res.end(JSON.stringify({ ok: true }));
    return;
  } },

  // 登出(公开)
  { method: 'POST', match: /^\/api\/logout$/, handler: async (req, res) => {
    const t = getCookie(req, 'blog_token');
    if (t) sessions.delete(t);
    clearSessionCookie(res);
    res.end(JSON.stringify({ ok: true }));
    return;
  } },

  // 当前登录态(公开):后台据此分流 设置密码 / 登录 / 管理区
  { method: 'GET', match: /^\/api\/me$/, handler: async (req, res) => {
    const s = getSession(req);
    return sendJSON(res, 200, {
      loggedIn: !!s,
      username: s ? s.username : null,
      canManage: isOwner(req), // 删除/上传仅对站主(muxi)开放
      needsSetup: !getSetting('admin_password_hash'), // 尚未设置管理员密码则引导进入设置页
    });
  } },

  // 首次设置管理员密码(公开,不需登录):仅当尚无密码时允许,一设即成登录态
  { method: 'POST', match: /^\/api\/setup$/, handler: async (req, res) => {
    if (getSetting('admin_password_hash')) return sendJSON(res, 409, { error: '管理员密码已设置' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const pw = (body && body.password) || '';
    if (pw.length < 6) return sendJSON(res, 400, { error: '密码至少 6 位' });
    setSetting('admin_password_hash', scryptHash(pw));
    setSessionCookie(res, createTokenSession());
    res.end(JSON.stringify({ ok: true }));
    return;
  } },
];

module.exports = routes;