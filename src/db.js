// SQLite 数据访问：单例 db + 建表 + 键值设置。其他模块 require 本文件统一拿 db。
'use strict';
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./config');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
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
  );
`);
// 老库迁移:如果 posts 尚无 tags 列(多标签,逗号分隔),补上;已存在则跳过
try { db.exec("ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT ''"); } catch (e) { /* already has tags */ }

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { db, getSetting, setSetting };