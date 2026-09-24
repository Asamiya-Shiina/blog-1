// 实时状态存储：内存中维护所有设备的在线状态,支持 SSE 广播。
// 对齐上游 Asamiya-Shiina/blog 的行为：设备超 STALE_TIMEOUT_MS 未上报即判离线清除。
'use strict';

const STALE_TIMEOUT_MS = 45 * 1000;

// 设备状态:Map<deviceId, { active, app, title, icon, updatedAt }>
const devices = new Map();
// SSE 连接池(Set 自动去重)
const sseClients = new Set();

function cleanStaleDevices() {
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.updatedAt > STALE_TIMEOUT_MS) devices.delete(id);
  }
}

// 公开状态：清理过期设备后返回所有 active 设备,按更新时间倒序(最新在前)
function getPublicStatus() {
  cleanStaleDevices();
  const activeDevices = [];
  for (const [id, device] of devices) {
    if (device.active) {
      activeDevices.push({
        id,
        app: device.app,
        title: device.title,
        icon: device.icon,
        updatedAt: device.updatedAt,
      });
    }
  }
  activeDevices.sort((a, b) => b.updatedAt - a.updatedAt);
  return { devices: activeDevices };
}

// 向所有 SSE 客户端推全量 payload(推送即数据,前端无需再拉一次)
function broadcast() {
  const payload = 'data: ' + JSON.stringify(getPublicStatus()) + '\n\n';
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* 断开由 close 事件清理 */ }
  }
}

// 写入设备状态并广播;字段截断防恶意超长
function updateStatus(deviceId, data) {
  devices.set(deviceId, {
    active: !!data.active,
    app: String(data.app || '').slice(0, 100),
    title: String(data.title || '').slice(0, 300),
    icon: String(data.icon || '').slice(0, 50),
    updatedAt: Date.now(),
  });
  broadcast();
}

// 移除单个设备状态(主动离线/off);
function clearStatus(deviceId) {
  if (devices.delete(deviceId)) broadcast();
}

// 注册 SSE 客户端,断开自动移除
function addClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

setInterval(cleanStaleDevices, 30 * 1000);

module.exports = {
  updateStatus, clearStatus, getPublicStatus, addClient,
  get clientCount() { return sseClients.size; },
};