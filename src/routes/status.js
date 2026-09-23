// 前台状态路由：公开读当前状态;改名映射与黑名单仅后台 admin 管理。
'use strict';
const { sendJSON, readBody } = require('../helpers');
const { getNames, setNames, getBlocklist, setBlocklist, readStatus } = require('../status');
const { requireAuth } = require('../auth');

const routes = [
  // 前端轮询用(公开):当前"正在用"状态
  { method: 'GET', match: /^\/api\/status$/, handler: async (req, res) => {
    return sendJSON(res, 200, readStatus());
  } },

  // 改名映射:进程名 → 显示名(admin)
  { method: 'GET', match: /^\/api\/names$/, handler: async (req, res) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, { names: getNames() });
  } },
  { method: 'PUT', match: /^\/api\/names$/, handler: async (req, res) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    setNames(body && body.names);
    return sendJSON(res, 200, { ok: true });
  } },

  // 黑名单:命中则前台隐藏并显示温和文案(admin)
  { method: 'GET', match: /^\/api\/blocklist$/, handler: async (req, res) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, { list: getBlocklist() });
  } },
  { method: 'PUT', match: /^\/api\/blocklist$/, handler: async (req, res) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    setBlocklist(body && body.list);
    return sendJSON(res, 200, { ok: true });
  } },
];

module.exports = routes;