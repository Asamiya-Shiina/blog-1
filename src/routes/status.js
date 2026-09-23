// 前台状态路由：公开读当前状态;改名映射与黑名单仅后台 admin 管理。
'use strict';
const { sendJSON, readBody, setSecurityHeaders } = require('../helpers');
const { getNames, setNames, getBlocklist, setBlocklist, readStatus } = require('../status');
const { requireAuth } = require('../auth');
const bus = require('../events');

const routes = [
  // 前端轮询用(公开):当前"正在用"状态
  { method: 'GET', match: /^\/api\/status$/, handler: async (req, res) => {
    return sendJSON(res, 200, readStatus());
  } },

  // SSE 实时推送(公开):订阅 'status:changed' 事件,前端收到后去拉 /api/status。
  // 长连接不走 sendJSON(res.end),handler 自己维持 res 生命周期并在 req close 时解绑。
  { method: 'GET', match: /^\/api\/status\/stream$/, handler: async (req, res) => {
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // 关闭 Nginx 等代理的缓冲,事件必须实时刷出
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const send = (event) => { try { res.write('event: ' + event + '\ndata: {}\n\n'); } catch {} };
    send('status:changed'); // 首帧立刻触发一次拉取,首屏免等
    const off = bus.subscribe('status:changed', () => send('status:changed'));
    // 25s 一条注释行当心跳:防止反代把空闲连接当死链掐掉,前端 EventSource 也会按这个节奏复活
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
    const cleanup = () => { clearInterval(ka); off(); try { res.end(); } catch {} };
    req.on('close', cleanup);
    req.on('error', cleanup);
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