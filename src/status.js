// 前台"正在用"状态：当前焦点进程 + 改名映射 + 黑名单。数据存 settings KV 表。
'use strict';
const { getSetting, setSetting } = require('./db');
const bus = require('./events');

// 多久未上报视为离线(ms)
const OFFLINE_MS = 60 * 1000;

function setStatus(proc, title) {
  setSetting('status:proc', String(proc || ''));
  setSetting('status:title', String(title || ''));
  setSetting('status:updated_at', String(Date.now()));
  // 心跳落库后立刻广播,SSE 订阅者收到事件再去拉一次 /api/status 拿最新完整 payload
  bus.emit('status:changed');
}

function getNames() {
  const raw = getSetting('procnames');
  if (!raw) return {};
  try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; } catch { return {}; }
}
function setNames(obj) {
  const clean = {};
  for (const k of Object.keys(obj || {})) {
    const v = String(obj[k] || '').trim().slice(0, 40);
    // key 统一小写:Windows 客户端上报进程名时会 .lower(),这里对齐避免大小写不一致导致改名不生效
    const kk = String(k).trim().slice(0, 80).toLowerCase();
    if (kk && v) clean[kk] = v;
  }
  setSetting('procnames', JSON.stringify(clean));
}

function getBlocklist() {
  const raw = getSetting('blocklist');
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
function setBlocklist(list) {
  const seen = new Set();
  const clean = (list || [])
    .map((e) => String(e || '').trim().slice(0, 80))
    .filter((e) => e && !seen.has(e) && seen.add(e));
  setSetting('blocklist', JSON.stringify(clean));
}

// 组装前端展示载荷:online 过期判定 + 改名映射 + 黑名单。
// 改名映射优先级最高(配了就用你自定义名);未配置时直接显示原进程名(含 .exe 等后缀),
// 方便对照前台所见去后台改名文本框里照搬 key,不需要再去查实际进程名。
function readStatus(now = Date.now()) {
  const proc = getSetting('status:proc') || '';
  const title = getSetting('status:title') || '';
  const updatedAt = Number(getSetting('status:updated_at') || 0);
  const online = !!updatedAt && (now - updatedAt) <= OFFLINE_MS;
  const blocked = online && getBlocklist().includes(proc);
  let display = proc;
  if (proc) {
    const names = getNames();
    if (names[proc]) display = names[proc];
  }
  return {
    online,
    proc,
    title,
    display: online && !blocked ? display : proc,
    blocked,
    ts: updatedAt,
  };
}

module.exports = { setStatus, getNames, setNames, getBlocklist, setBlocklist, readStatus, OFFLINE_MS };