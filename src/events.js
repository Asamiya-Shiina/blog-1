// 进程内事件总线:模块间解耦的发布订阅,SSE 推送靠它广播。
// 设计目标是"够用且不漏":同步派发,监听器内异常被吞(防止一个坏订阅者拖垮其他人),
// unsubscribe 必须幂等(EventSource close 时路由 handler 会再调一次)。
'use strict';

const listeners = new Map(); // event -> Set<fn>

function subscribe(event, fn) {
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  set.add(fn);
  return () => unsubscribe(event, fn);
}

function unsubscribe(event, fn) {
  const set = listeners.get(event);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) listeners.delete(event);
}

function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error('[bus] listener for %s threw:', event, e); }
  }
}

module.exports = { subscribe, unsubscribe, emit };
