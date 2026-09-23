// exe 客户端路由：登录(复用后台管理员密码) + 心跳上报当前焦点进程。
'use strict';
const { sendJSON, readBody } = require('../helpers');
const { verifyPassword, issueClientToken, requireClient } = require('../auth');
const { setStatus } = require('../status');

const routes = [
  // 客户端登录(公开):密码与后台管理员一致,成功返回一次性 client token
  { method: 'POST', match: /^\/api\/client\/login$/, handler: async (req, res) => {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    if (!verifyPassword((body && body.password) || '')) return sendJSON(res, 401, { error: '密码错误' });
    return sendJSON(res, 200, { ok: true, token: issueClientToken() });
  } },

  // 心跳上报(需 client token):进程名 + 窗口标题。exe 每 N 秒上报,维持在线。
  { method: 'POST', match: /^\/api\/client\/heartbeat$/, handler: async (req, res) => {
    if (!requireClient(req)) return sendJSON(res, 401, { error: '未登录' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const proc = String((body && body.proc) || '').trim().slice(0, 80);
    if (!proc) return sendJSON(res, 400, { error: '缺少 proc' });
    setStatus(proc, String((body && body.title) || '').trim().slice(0, 200));
    return sendJSON(res, 200, { ok: true });
  } },
];

module.exports = routes;