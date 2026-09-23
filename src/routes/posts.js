// 文章路由 ：列表 / 单篇 / 新建 / 更新 / 删除，外加文章类型下拉(/api/categories)。
// 除 categories 外均需登录。行为与原 server.js 完全一致,仅拆成模块。
'use strict';
const { db } = require('../db');
const { CATEGORIES } = require('../config');
const { sendJSON, readBody } = require('../helpers');
const { requireAuth } = require('../auth');

// 清洗并校验文章字段:标题必填,各字段均限长。
function cleanPost(b) {
  const p = b || {};
  const title = String(p.title || '').trim().slice(0, 200);
  const tag = String(p.tag || '').trim().slice(0, 50);
  const excerpt = String(p.excerpt || '').trim().slice(0, 500);
  const content = String(p.content || '');
  // 多标签:逗号(中英文均可)/空格/顿号分隔,去空白去重,最多 12 个,每标签限 30 字
  const seen = new Set();
  const list = String(p.tags || '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim().slice(0, 30))
    .filter((s) => s && !seen.has(s) && seen.add(s));
  const tags = list.slice(0, 12).join(',');
  if (!title) return null;
  return { title, tag, excerpt, content, tags };
}

const routes = [
  // 文章列表(公开):主页/后台共用的最简单形态,按时间倒序,不分页。
  { method: 'GET', match: /^\/api\/posts$/, handler: async (req, res) => {
    const rows = db.prepare(
      'SELECT id, title, excerpt, tag, tags, created_at, updated_at FROM posts ORDER BY created_at DESC, id DESC'
    ).all();
    return sendJSON(res, 200, rows);
  } },

  // 文章类型下拉的可选项(公开):后台编辑器加载候选,主页侧栏借此列出预置分类
  { method: 'GET', match: /^\/api\/categories$/, handler: async (req, res) => {
    return sendJSON(res, 200, { categories: CATEGORIES });
  } },

  // 单篇查询(公开):后台编辑回填
  { method: 'GET', match: /^\/api\/posts\/(\d+)$/, handler: async (req, res, m) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(m[1]));
    if (!post) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, post);
  } },

  // 新建文章(需登录)
  { method: 'POST', match: /^\/api\/posts$/, handler: async (req, res) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
    const p = cleanPost(body);
    if (!p) return sendJSON(res, 400, { error: '标题不能为空' });
    const info = db.prepare('INSERT INTO posts (title, excerpt, tag, tags, content) VALUES (?, ?, ?, ?, ?)')
      .run(p.title, p.excerpt, p.tag, p.tags, p.content);
    return sendJSON(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  } },

  // 更新文章(需登录)
  { method: 'PUT', match: /^\/api\/posts\/(\d+)$/, handler: async (req, res, m) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
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
  } },

  // 删除文章(需登录)
  { method: 'DELETE', match: /^\/api\/posts\/(\d+)$/, handler: async (req, res, m) => {
    if (!requireAuth(req)) return sendJSON(res, 401, { error: '未登录' });
    const info = db.prepare('DELETE FROM posts WHERE id = ?').run(Number(m[1]));
    if (info.changes === 0) return sendJSON(res, 404, { error: '文章不存在' });
    return sendJSON(res, 200, { ok: true });
  } },
];

module.exports = routes;