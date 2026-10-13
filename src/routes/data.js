// 实时状态路由：对上对齐上游行为——内存设备存储 + SSE 直接推全量 + 客户端本地拉配置。
// 分四层：客户端上报(需 client token)、公开读状态、公开 SSE 流、管理配置(需站主)。
'use strict';
const { sendJSON, readBody, setSecurityHeaders } = require('../helpers');
const { verifyPassword, issueClientToken, requireClient, requireAuth, isOwner } = require('../auth');
const { OWNER_USERNAME } = require('../config');
const { getSetting, setSetting } = require('../db');
const store = require('../status-store');

// ---- 配置读写(存 settings KV 的单个 status_config JSON 块) ----
const EMPTY_CONFIG = {
  blacklist: [],            // 应用名黑名单(精确小写比较)
  blacklistPatterns: [],    // 黑名单正则
  appNames: {},             // 进程名 -> 显示名(精确)
  appNamePatterns: [],      // 正则 -> 显示名:[{pattern,name}]
  titleApps: [],            // 显示窗口标题的应用(精确)
  titleAppPatterns: [],     // 显示标题的正则
};

function getAllConfig() {
  let c = {};
  try { c = JSON.parse(getSetting('status_config') || '{}'); } catch { c = {}; }
  return {
    blacklist: Array.isArray(c.blacklist) ? c.blacklist : [],
    blacklistPatterns: Array.isArray(c.blacklistPatterns) ? c.blacklistPatterns : [],
    appNames: (c.appNames && typeof c.appNames === 'object') ? c.appNames : {},
    appNamePatterns: Array.isArray(c.appNamePatterns) ? c.appNamePatterns : [],
    titleApps: Array.isArray(c.titleApps) ? c.titleApps : [],
    titleAppPatterns: Array.isArray(c.titleAppPatterns) ? c.titleAppPatterns : [],
  };
}
function setConfig(partial) {
  const cur = getAllConfig();
  const next = Object.assign(cur, partial || {});
  setSetting('status_config', JSON.stringify(next));
}

// ---- 上报限流:固定窗口 15s / 30 次 ----
const RATE_WINDOW_MS = 15 * 1000;
const RATE_MAX = 30;
const _hits = new Map(); // ip -> number[]
function hitRate(ip) {
  const now = Date.now();
  let ts = _hits.get(ip);
  if (!ts) { ts = []; _hits.set(ip, ts); }
  while (ts.length && ts[0] <= now - RATE_WINDOW_MS) ts.shift();
  if (ts.length >= RATE_MAX) return false;
  ts.push(now);
  if (_hits.size > 10000) _hits.delete(_hits.keys().next().value); // 防 Map 无限增长
  return true;
}

const MAX_SSE = 50; // SSE 并发连接数上限,超限 429

const routes = [
  // 客户端登录(公开):密码与后台管理员一致,成功返回一次性 client token
  { method: 'POST', match: /^\/api\/client\/login$/, handler: async (req, res) => {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    if (!verifyPassword((body && body.password) || '')) return sendJSON(res, 401, { error: '密码错误' });
    return sendJSON(res, 200, { ok: true, token: issueClientToken() });
  } },

  // 客户端上报状态(需 client token):active=true 更新,active=false 主动离线
  { method: 'POST', match: /^\/api\/data$/, handler: async (req, res) => {
    if (!requireClient(req)) return sendJSON(res, 401, { error: '未登录' });
    if (!hitRate(req.socket.remoteAddress || 'local')) return sendJSON(res, 429, { error: '上报过于频繁' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    body = body || {};
    const active = !!body.active;
    const deviceName = String(body.deviceName || 'default').slice(0, 50);
    const deviceId = OWNER_USERNAME + '_' + deviceName;
    if (active) {
      store.updateStatus(deviceId, {
        active: true,
        app: String(body.app || '').slice(0, 100),
        title: String(body.title || '').slice(0, 300),
        icon: String(body.icon || '').slice(0, 50),
      });
    } else {
      store.clearStatus(deviceId);
    }
    return sendJSON(res, 200, { ok: true });
  } },

  // 主动离线(需 client token):clear 指定设备
  { method: 'POST', match: /^\/api\/data\/off$/, handler: async (req, res) => {
    if (!requireClient(req)) return sendJSON(res, 401, { error: '未登录' });
    if (!hitRate(req.socket.remoteAddress || 'local')) return sendJSON(res, 429, { error: '上报过于频繁' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const deviceName = String((body && body.deviceName) || 'default').slice(0, 50);
    store.clearStatus(OWNER_USERNAME + '_' + deviceName);
    return sendJSON(res, 200, { ok: true });
  } },

  // 客户端拉管理配置(需 client token):本地做黑名单/改名/标题应用
  { method: 'GET', match: /^\/api\/data\/config$/, handler: async (req, res) => {
    if (!requireClient(req)) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, getAllConfig());
  } },

  // 公开读当前所有活跃设备
  { method: 'GET', match: /^\/api\/data$/, handler: async (req, res) => {
    return sendJSON(res, 200, store.getPublicStatus());
  } },

  // SSE 实时推送(公开):长连接,状态变化时 store.broadcast() 直接把全量 JSON 推给所有客户端
  { method: 'GET', match: /^\/api\/data\/stream$/, handler: async (req, res) => {
    if (store.clientCount >= MAX_SSE) return sendJSON(res, 429, { error: '连接过多' });
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    try { res.write('data: ' + JSON.stringify(store.getPublicStatus()) + '\n\n'); } catch {}
    store.addClient(res); // 加入池,后续 broadcast 会推给它
    const ka = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 30000);
    const clear = () => clearInterval(ka);
    req.on('close', clear);
    req.on('error', clear);
  } },

  // 管理配置(需站主)：读
  { method: 'GET', match: /^\/api\/data\/admin\/config$/, handler: async (req, res) => {
    if (!(requireAuth(req) && isOwner(req))) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, getAllConfig());
  } },

  // 管理配置(需站主)：局部更新,只改提交字段
  { method: 'POST', match: /^\/api\/data\/admin\/config$/, handler: async (req, res) => {
    if (!(requireAuth(req) && isOwner(req))) return sendJSON(res, 401, { error: '未登录' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const partial = {};
    for (const k of Object.keys(EMPTY_CONFIG)) {
      if (k in body) partial[k] = body[k]; // 交给 setConfig 沿用现有数组/映射形态
    }
    setConfig(partial);
    return sendJSON(res, 200, { ok: true, config: getAllConfig() });
  } },
];

module.exports = routes;