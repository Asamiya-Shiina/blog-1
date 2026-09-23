// 全局配置与常量：集中读环境变量 + 常量。各模块 require 本文件获取路径与设定。
'use strict';
const path = require('path');
const fs = require('fs');

const dir = __dirname; // __dirname 在本文件是 src/,项目根需再上一级
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
// resolve 统一路径分隔符(避免 Windows 下环境变量为 "/" 而 path.join 归一成 "\" 导致
// startsWith 目录校验误判为越权 forbidden)
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(ROOT, 'blog.db'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
const PHOTO_DIR = path.resolve(process.env.PHOTO_DIR || path.join(ROOT, 'photo'));

// 唯一管理员即站主(muxi)。删除/上传等敏感操作仅对站主开放;将来若加普通账号,isOwner 会拦下对方。
const OWNER_USERNAME = 'muxi';
// 文章类型(分类)预设:后台写文章以下拉选择,主页侧栏据此列出预置分类。
const CATEGORIES = ['前端开发', '技术随笔', '生活日常', '读书笔记'];
// 会话有效期,与登录 cookie 的 Max-Age 一致(604800s)
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
// 登录失败限流:每 IP 记录失败次数,超限后锁 10 分钟,防暴力破解
const MAX_LOGIN_FAILS = 5;
const LOGIN_WINDOW = 10 * 60 * 1000;

function ensureDirs() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

module.exports = {
  ROOT, PORT, HOST, DB_PATH, UPLOAD_DIR, PHOTO_DIR,
  OWNER_USERNAME, CATEGORIES, SESSION_TTL, MAX_LOGIN_FAILS, LOGIN_WINDOW,
  ensureDirs,
};