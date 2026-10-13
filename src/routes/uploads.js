// 图片上传路由：
//  /api/upload   —— 文章插图,base64 → UPLOAD_DIR/,需登录
//  /api/photos   —— 相册图:GET 列表(公开) / POST 上传(仅站主) / DELETE 删除(仅站主)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOAD_DIR, PHOTO_DIR } = require('../config');
const { sendJSON, readBody, sniffImage } = require('../helpers');
const { requireAuth, isOwner } = require('../auth');

const IMG = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

// 解析 data:image/base64 载荷,返回 { ext, buf } 或 null;并做魔数校验
function parseImage(dataUrl) {
  const bm = String(dataUrl || '').match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
  if (!bm) return null;
  const ext = '.' + bm[1].replace('jpeg', 'jpg');
  const buf = Buffer.from(bm[2], 'base64');
  if (!sniffImage(ext, buf)) return null; // 校验文件头魔数,拒绝"披着 png 外衣的任意内容"
  return { ext, buf };
}

const routes = [
  // 文章插图上传(需登录):base64 图片 → uploads/
  { method: 'POST', match: /^\/api\/upload$/, handler: async (req, res) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const img = parseImage(body && body.data);
    if (!img) return sendJSON(res, 400, { error: '文件内容不是有效图片' });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + img.ext;
    const file = path.join(UPLOAD_DIR, name);
    if (!file.startsWith(UPLOAD_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(file, img.buf);
    return sendJSON(res, 200, { url: '/uploads/' + name });
  } },

  // 相册图片列表(公开):按修改时间倒序,新上传的靠前,不限数量
  { method: 'GET', match: /^\/api\/photos$/, handler: async (req, res) => {
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
  } },

  // 相册上传(仅站主):base64 图片 → photo/。与文章插图(uploads/)独立。
  { method: 'POST', match: /^\/api\/photos$/, handler: async (req, res) => {
    if (!isOwner(req)) return sendJSON(res, 403, { error: '仅站主可上传' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const img = parseImage(body && body.data);
    if (!img) return sendJSON(res, 400, { error: '文件内容不是有效图片' });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + img.ext;
    const file = path.join(PHOTO_DIR, name);
    if (!file.startsWith(PHOTO_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(file, img.buf);
    return sendJSON(res, 200, { name, url: '/photo/' + encodeURIComponent(name) });
  } },

  // 相册删除(仅站主):按文件名删除 photo/ 下的图片,防目录穿越
  { method: 'DELETE', match: /^\/api\/photos$/, handler: async (req, res) => {
    if (!isOwner(req)) return sendJSON(res, 403, { error: '仅站主可删除' });
    const qs = new URL(req.url, 'http://x').searchParams;
    const raw = String(qs.get('name') || '').trim();
    if (!raw) return sendJSON(res, 400, { error: '缺少 name 参数' });
    const name = path.basename(raw); // qs.get 已做一次 URL 解码,只取文件名杜绝 ../ 穿越,避免二次解码抛 URIError
    const file = path.join(PHOTO_DIR, name);
    if (!file.startsWith(PHOTO_DIR + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
    return fs.promises.unlink(file)
      .then(() => sendJSON(res, 200, { ok: true }))
      .catch(() => sendJSON(res, 404, { error: '图片不存在' }));
  } },
];

module.exports = routes;