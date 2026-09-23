// 路由分发：合并各 routes 模块的路由表,按 (method, regex) 匹配 dispatch。
'use strict';
const { sendJSON } = require('./helpers');
const posts = require('./routes/posts');
const uploads = require('./routes/uploads');
const auth = require('./routes/auth');
const client = require('./routes/client');
const status = require('./routes/status');

const table = [...posts, ...uploads, ...auth, ...client, ...status];

// 按 (method, regex) 匹配,命中则执行 handler(async)。返回 Promise 供 server 统一兜底 500。
// handler 内如同步抛错,这里转成 reject 让上层 catch。未命中返回 404 JSON。
function dispatch(req, res, pathname) {
  for (const r of table) {
    if (r.method !== req.method) continue;
    const m = r.match.exec(pathname);
    if (!m) continue;
    return Promise.resolve()
      .then(() => r.handler(req, res, m))
      .catch((e) => { throw e; }); // 统一交给 server 的 .catch 记日志并回 500
  }
  return Promise.resolve(sendJSON(res, 404, { error: 'not found' }));
}

module.exports = { dispatch };