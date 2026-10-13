#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""沐玺博客 · 前台"正在用"客户端（Windows）。

常驻监测鼠标焦点窗口所属进程,登录后定时把 进程名 + 窗口标题 上报给博客后端,
首页即可展示"正在用 …"。改名映射与黑名单过滤由后端处理,本程序只负责无脑上报。

形态（打包成 exe 后）:
  - 首次运行(未配置密码) → 弹出设置窗口,填服务器/密码/间隔,「保存并开始」后台常驻。
  - 已配置密码 → 双击即静默后台跑(系统托盘有图标,右键可 显示设置/退出)。
  - 密码用 Windows DPAPI 加密后存 exe 旁 config.json,换机/换用户即解不开。

入口:
  python now_playing.py             # 源码方式:进 GUI(等价 --gui)
  python now_playing.py --gui       # 强制 GUI
  python now_playing.py --once      # 打印一次当前焦点进程后退出(调试)
  python now_playing.py --check     # 仅登录验证
打包: pyinstaller --windowed --onefile --name now_playing now_playing.py
"""
import argparse
import base64
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import re
import sys
import threading
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, 'config.json')

# Win32 常量
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
CRYPTPROTECT_UI_FORBIDDEN = 0x1

DEFAULT_CONFIG = {
    'server': 'http://127.0.0.1:8080',
    'password_b64': '',
    'interval': 3,           # 活跃时心跳间隔(秒)
    'idle_after_s': 120,     # 鼠标空闲多久后降频
    'idle_interval': 30,     # 空闲后心跳间隔(秒);仍报,后端不会判离线
    }


# ---------- 配置读写 ----------
def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    migrate_plaintext(cfg)  # 旧版明文 password → 加密 password_b64,并清掉明文
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def migrate_plaintext(cfg):
    """兼容旧版:config 里若只有明文 password(无 password_b64),自动加密并移除明文。"""
    if not cfg.get('password_b64') and cfg.get('password'):
        try:
            enc = base64.b64encode(dpapi_protect(str(cfg['password']))).decode('ascii')
        except Exception:
            return
        cfg['password_b64'] = enc
        cfg.pop('password', None)
        try:
            save_config(cfg)
        except Exception:
            pass


# ---------- DPAPI 加密 ----------
class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(wintypes.BYTE))]

_crypt32 = ctypes.windll.crypt32
_free = ctypes.windll.kernel32.LocalFree


def dpapi_protect(plain: str) -> bytes:
    secret = plain.encode('utf-16-le')
    buf = ctypes.create_string_buffer(secret, len(secret))
    blob_in = DATA_BLOB(len(secret), ctypes.cast(buf, ctypes.POINTER(wintypes.BYTE)))
    blob_out = DATA_BLOB()
    ok = _crypt32.CryptProtectData(ctypes.byref(blob_in), None, None, None, None,
                                   CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
    if not ok:
        raise OSError('DPAPI 加密失败(%d)' % ctypes.get_last_error())
    data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    _free(blob_out.pbData)
    return data


def dpapi_unprotect(payload: bytes) -> str:
    buf = ctypes.create_string_buffer(payload, len(payload))
    blob_in = DATA_BLOB(len(payload), ctypes.cast(buf, ctypes.POINTER(wintypes.BYTE)))
    blob_out = DATA_BLOB()
    ok = _crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None,
                                     CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
    if not ok:
        raise OSError('DPAPI 解密失败(%d)' % ctypes.get_last_error())
    data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    _free(blob_out.pbData)
    return data.decode('utf-16-le')


def decrypt_password(cfg):
    """返回明文密码;未存或解不开(换机/换用户/损坏)返回 None。"""
    raw = cfg.get('password_b64') or ''
    if not raw:
        return None
    try:
        return dpapi_unprotect(base64.b64decode(raw))
    except Exception:
        return None


# ---------- 焦点窗口检测(Win32 via ctypes) ----------
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def get_foreground_process():
    """返回 (进程名, 窗口标题);拿不到返回 (None, None)。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None, None
    title = ''
    length = user32.GetWindowTextLengthW(hwnd)
    if length:
        b = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, b, length + 1)
        title = b.value.strip()
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None, title or None
    hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not hproc:
        return None, title or None
    try:
        size = wintypes.DWORD(2048)
        b = ctypes.create_unicode_buffer(2048)
        if kernel32.QueryFullProcessImageNameW(hproc, 0, b, ctypes.byref(size)):
            return os.path.splitext(os.path.basename(b.value))[0], title
    finally:
        kernel32.CloseHandle(hproc)
    return None, title or None


# ---------- HTTP 小助手(纯标准库) ----------
def _open(req, timeout):
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode('utf-8') or '{}'
        return json.loads(body)


def get_json(url, headers=None, timeout=6):
    req = urllib.request.Request(url, method='GET')
    if headers:
        req.headers.update(headers)
    return _open(req, timeout)


def post_json(url, data, headers=None, timeout=6, expected_code=200):
    req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), method='POST',
                                 headers={'Content-Type': 'application/json'})
    if headers:
        req.headers.update(headers)
    return _open(req, timeout)


def quick_verify(server, password, timeout=4):
    """返回 'ok' | 'bad' | 'unreachable':静默前验证密码是否对。"""
    base = (server or '').rstrip('/') + '/'
    try:
        r = post_json(base + 'api/client/login', {'password': password}, timeout=timeout)
        return 'ok' if r.get('token') else 'bad'
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 429):
            return 'bad'
        return 'unreachable'
    except Exception:
        return 'unreachable'


# ---------- 空闲检测(GetLastInputInfo,Win32) ----------
# 比全局低级鼠标钩子轻得多:一次 API 调用拿到"距最后一次键盘/鼠标输入的秒数",
# 天然覆盖键鼠且无线程/钩子回调;心跳线程按固定节奏轮询它即可。
class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.UINT), ('dwTime', wintypes.DWORD)]

kernel32.GetTickCount64.restype = ctypes.c_uint64

class IdleDetector:
    def idle_seconds(self):
        """返回距最后一次键盘/鼠标输入的秒数;取不到返回大值(视同空闲)。"""
        lii = _LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(_LASTINPUTINFO)
        if not user32.GetLastInputInfo(ctypes.byref(lii)):
            return 999.0
        # GetTickCount64 与 dwTime 同源单调时钟,相减得空闲毫秒(天然处理 32 位回绕)
        return max(0.0, (kernel32.GetTickCount64() - lii.dwTime) / 1000.0)


# ---------- 后台心跳线程 ----------
# 对齐上游行为:客户端启动后先拉 /api/data/config,本地做黑名单/改名(含正则)/标题应用,
# 再按 进程/空闲 判定上报 {active, app, title, icon, deviceName} 到 /api/data;
# 主动 active:false 离线。只在本机改名,上报即显示名。
REST_SECONDS = 300  # 空闲这么长判"休息中"(语义,区别于下面的降频节流阈值)
SELF_PROCS = ('python', 'pythonw', '状态客户端', 'status_client', 'now_playing')
DEDUP_SECONDS = 30  # 状态未变仅每 30s 保活上报,省请求也匹配服务端 45s 离线判定


class Heartbeat:
    """登录 + 拉配置 + 周期性上报;独立线程,可停止。status_cb(status) 每次变化回调(tkinter 安全侧自行判断线程)。

    键鼠空闲超过 idle_after_s 秒 → 降频到 idle_interval 秒一次;动 → 回 interval。空闲 REST_SECONDS 报"休息中"。
    """

    def __init__(self, server, password, interval, status_cb=None,
                 idle_after_s=120, idle_interval=30, mouse=None, focus_cb=None):
        # 可能是从浏览器地址栏复制的网址(带 /index.html),剥掉只留站点根,否则拼到 API 上会 404
        raw = re.sub(r'/index\.html$', '', (server or '').strip())
        self.server = raw.rstrip('/') + '/'
        self.password = password
        self.interval = max(1, int(interval or 3))
        self.idle_after_s = max(1, int(idle_after_s or 120))
        self.idle_interval = max(self.interval, int(idle_interval or 30))
        self.device_name = 'PC'  # 单设备,固定名;后端多设备协议仍兼容
        self.focus_cb = focus_cb or (lambda s: None)  # 实时汇报当前读到的焦点,用于监测是否正常
        # 共用外部 IdleDetector 实例;不传则建一个(纯轮询,无线程/句柄,无需显式 start/stop)
        self.mouse = mouse or IdleDetector()
        self.status_cb = status_cb or (lambda s: None)
        self.config = None  # 服务端下发的过滤/改名配置,登录后拉取
        self._last_key = None
        self._last_sent_ts = 0.0
        self._headers = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _emit(self, s):
        try:
            self.status_cb(s)
        except Exception:
            pass

    def _current_interval(self):
        idle_for = self.mouse.idle_seconds()
        return self.idle_interval if idle_for >= self.idle_after_s else self.interval

    # ---- 本地过滤/改名(照搬上游判定次序,可在 config 里配正则) ----
    def is_blacklisted(self, proc, title):
        if not self.config:
            return False
        name = proc.lower()
        for b in self.config.get('blacklist', []):
            if b and b.lower() == name:
                return True
        for pat in self.config.get('blacklistPatterns', []):
            try:
                if re.search(pat, proc, re.I) or re.search(pat, title, re.I):
                    return True
            except Exception:
                pass
        return False

    def resolve_app_name(self, proc):
        if not self.config:
            return proc
        an = self.config.get('appNames', {})
        if proc in an:
            return an[proc]
        low = proc.lower()
        for k, v in an.items():
            if k.lower() == low:
                return v
        for item in self.config.get('appNamePatterns', []):
            try:
                if re.search(item.get('pattern', ''), proc, re.I):
                    return item.get('name', proc)
            except Exception:
                pass
        return proc

    def should_show_title(self, proc):
        if not self.config:
            return False
        ta = self.config.get('titleApps', [])
        if proc in ta:
            return True
        low = proc.lower()
        for i in ta:
            if i.lower() == low:
                return True
        for item in self.config.get('titleAppPatterns', []):
            try:
                if re.search(item.get('pattern', ''), proc, re.I):
                    return True
            except Exception:
                pass
        return False

    # ---- 单次采集:生成 payload 并上报(带去重) ----
    def _report(self, payload):
        key = json.dumps(payload, ensure_ascii=False)
        now = time.monotonic()
        if key == self._last_key and (now - self._last_sent_ts) < DEDUP_SECONDS:
            return
        try:
            post_json(self.server + 'api/data', payload, headers=self._headers)
        except Exception as e:
            self._emit('上报失败: %s' % e)
            return
        self._last_key = key
        self._last_sent_ts = now
        if payload.get('active') and payload.get('icon') != 'break':
            self._emit('正在用 %s' % (payload.get('app') or ''))

    def _emit_focus(self, text):
        try: self.focus_cb(text)
        except Exception: pass

    def _tick(self):
        device = self.device_name
        idle_for = self.mouse.idle_seconds()
        if idle_for >= REST_SECONDS:
            # 离开电脑很久 → 报"休息中",仍 active 维持在线
            self._emit_focus('休息中 (已离开 %d 分钟)' % (idle_for // 60))
            self._report({'active': True, 'app': '休息中', 'title': '', 'icon': 'break', 'deviceName': device})
            return
        win = get_foreground_process()
        if not win or not win[0]:
            self._emit_focus('未检测到前台窗口')
            return  # 无前台普通窗口,保留上次状态
        proc, title = win or ('', '')
        pl = proc.lower()
        # 进程是自己(状态客户端)→ 不上报,避免循环检测
        if pl in SELF_PROCS:
            self._emit_focus('%s(本客户端)' % proc)
            return
        if self.is_blacklisted(proc, title):
            self._emit_focus('%s(已隐藏)' % proc)
            self._report({'active': True, 'app': '休息一下,马上回来', 'title': '', 'icon': 'break', 'deviceName': device})
            return
        app = self.resolve_app_name(proc)
        if pl == 'explorer' and title == 'Program Manager':
            app = '桌面'
        elif pl == 'windowsterminal':
            app = '消耗Token死命调试中....'
        show_title = self.should_show_title(proc)
        self._emit_focus(app + (' · ' + title if show_title and title else ''))
        self._report({
            'active': True,
            'app': app,
            'title': title if show_title else '',
            'icon': pl,
            'deviceName': device,
        })

    def _run(self):
        base = self.server
        try:
            res = post_json(base + 'api/client/login', {'password': self.password})
            token = res.get('token')
        except Exception as e:
            self._emit('连接服务器失败: %s' % e)
            return
        if not token:
            self._emit('登录失败(密码错误或服务器未开)')
            return
        self._headers = {'X-Client-Token': token}
        # 拉过滤/改名配置;拿不到就用空(仍可上报原始进程名)
        try:
            self.config = get_json(base + 'api/data/config', headers=self._headers)
        except Exception as e:
            self._emit('拉取配置失败(将只用原始进程名): %s' % e)
        self._emit('已连接')
        last_mode = None
        while not self._stop.is_set():
            cur = self._current_interval()
            mode = 'idle' if cur >= self.idle_interval else 'active'
            if mode != last_mode:
                self._emit('空闲降频中(每 %ds)' % cur if mode == 'idle' else '已恢复活跃(每 %ds)' % cur)
                last_mode = mode
            try:
                self._tick()
            except Exception as e:
                self._emit('上报失败: %s' % e)
            # 每 0.5s 醒来重判间隔:一动鼠标最多 0.5s 内切回活跃节奏,不用等完一整个 idle_interval。
            slept = 0.0
            while slept < cur and not self._stop.is_set():
                self._stop.wait(min(0.5, cur - slept))
                slept += 0.5
                if self._current_interval() < cur:
                    break


# ---------- 托盘图标(惰性导入,避免无 GUI 环境报错) ----------
try:
    from PIL import Image, ImageDraw
    import pystray as _pystray
    _TRAY_AVAILABLE = True
except Exception:
    _TRAY_AVAILABLE = False


def _make_tray_image():
    """画一个红→橙渐变圆(博客 logo 风格)作为托盘图标。"""
    img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(64):
        for j in range(64):
            dist = ((i - 31.5) ** 2 + (j - 31.5) ** 2) ** 0.5
            if dist <= 31.5:
                t = dist / 31.5
                col = (int(192 + t * (230 - 192)), int(57 + t * (126 - 57)), int(43 + t * (51 - 43)))
                d.point((i, j), fill=col)
    return img


# ---------- GUI(设置窗口 + 托盘) ----------
def run_gui():
    import tkinter as tk
    from tkinter import ttk

    cfg = load_config()
    saved_pw = decrypt_password(cfg)
    hb = [None]  # 存 Heartbeat,便于停止

    root = tk.Tk()
    root.title('沐玺 · 正在用客户端')
    root.geometry('420x380')
    root.resizable(False, False)

    icon_img = _make_tray_image() if _TRAY_AVAILABLE else None
    tray = [None]

    def set_status(txt, color='#333'):
        status_lbl.config(text=txt, fg=color)

    def on_focus(text):
        # 焦点信息可能来自后台线程,经 root.after 调度到主线程刷新窗口与托盘 tooltip
        def apply():
            focus_lbl.config(text='当前焦点: ' + text)
            if tray[0] is not None:
                try: tray[0].title = '正在用 · ' + text
                except Exception: pass
        root.after(0, apply)

    def stop_hb():
        if hb[0]:
            hb[0].stop()
            hb[0] = None

    def start_hb(server, password, interval, cb, idle_after_s=None, idle_interval=None, focus_cb=None):
        stop_hb()
        hb[0] = Heartbeat(server, password, interval, cb,
                          idle_after_s=idle_after_s if idle_after_s is not None else cfg.get('idle_after_s', 120),
                          idle_interval=idle_interval if idle_interval is not None else cfg.get('idle_interval', 30),
                          focus_cb=focus_cb)
        hb[0].start()

    def make_tray():
        if not (_TRAY_AVAILABLE and tray[0] is None):
            return
        def on_show(icon, item):
            root.after(0, root.deiconify)
            root.after(0, root.lift)
        def on_quit(icon, item):
            root.after(0, quit_app)
        menu = _pystray.Menu(
            _pystray.MenuItem('显示设置', on_show, default=True),
            _pystray.MenuItem('退出', on_quit),
        )
        tray[0] = _pystray.Icon('now_playing', icon_img, '沐玺 · 正在用', menu)
        tray[0].run_detached()

    def quit_app():
        stop_hb()
        if tray[0]:
            tray[0].stop()
        root.destroy()

    def on_save_start():
        server = server_var.get().strip()
        interval = interval_var.get().strip()
        pw = pw_var.get()
        if not server:
            set_status('请填写服务器地址', '#c0392b')
            return
        if not pw:
            set_status('请填写后台管理员密码', '#c0392b')
            return
        try:
            enc = base64.b64encode(dpapi_protect(pw)).decode('ascii')
        except Exception as e:
            set_status('密码加密失败: %s' % e, '#c0392b')
            return
        cfg['server'] = server
        cfg['password_b64'] = enc
        try:
            cfg['interval'] = int(interval) if interval else 3
        except ValueError:
            cfg['interval'] = 3
        try:
            save_config(cfg)
        except Exception as e:
            set_status('写入配置失败: %s' % e, '#c0392b')
            return
        start_hb(server, pw, cfg['interval'],
                 lambda s: root.after(0, lambda: set_status(s, '#2e7d32')),
                 idle_after_s=cfg.get('idle_after_s'),
                 idle_interval=cfg.get('idle_interval'),
                 focus_cb=on_focus)
        root.withdraw()
        make_tray()

    def on_quit_btn():
        quit_app()

    pad = {'padx': 12, 'pady': 4}
    padx = {'padx': 12}  # 与显式 pady 配合,避免 pack 参数重复冲突
    # 界面布局
    frm = ttk.Frame(root, padding=8)
    frm.pack(fill='both', expand=True)

    ttk.Label(frm, text='服务器地址（如 http://127.0.0.1:8080）').pack(anchor='w', **padx)
    server_var = tk.StringVar(value=cfg.get('server') or DEFAULT_CONFIG['server'])
    ttk.Entry(frm, textvariable=server_var).pack(fill='x', **padx)

    ttk.Label(frm, text='后台管理员密码').pack(anchor='w', **padx)
    pw_var = tk.StringVar()
    pw_entry = ttk.Entry(frm, textvariable=pw_var, show='*')
    pw_entry.pack(fill='x', **padx)
    show_pw = tk.BooleanVar()
    def toggle_pw():
        pw_entry.config(show='' if show_pw.get() else '*')
    ttk.Checkbutton(frm, text='显示密码', variable=show_pw, command=toggle_pw).pack(anchor='w', **padx)

    ttk.Label(frm, text='上报间隔（秒，默认 3）').pack(anchor='w', **padx)
    interval_var = tk.StringVar(value=str(cfg.get('interval') or 3))
    ttk.Entry(frm, textvariable=interval_var, width=8).pack(anchor='w', **padx)

    ttk.Button(frm, text='保存并开始', command=on_save_start).pack(anchor='w', pady=(12, 4), **padx)
    ttk.Button(frm, text='退出', command=on_quit_btn).pack(anchor='w', **padx)

    focus_lbl = ttk.Label(frm, text='当前焦点: —', foreground='#2e7d32')
    focus_lbl.pack(anchor='w', pady=(2, 0), **padx)
    status_lbl = ttk.Label(frm, text='', foreground='#333')
    status_lbl.pack(anchor='w', pady=(8, 0), **padx)
    tip = ttk.Label(frm, text='提示:最小化后转系统托盘常驻;密码加密存于本机;托盘悬停可见当前焦点',
                    foreground='#888', font=('', 9))
    tip.pack(anchor='w', pady=(4, 0), **padx)

    root.protocol('WM_DELETE_WINDOW', lambda: (root.withdraw(), make_tray()))

    # 静默模式:已配好密码且验证可连通 → 后台跑,不弹窗;密码不对/服务器连不上则照常弹窗由用户处理。
    if saved_pw is not None:
        pw_var.set(saved_pw)
        v = quick_verify(cfg.get('server') or DEFAULT_CONFIG['server'], saved_pw)
        if v != 'bad':
            start_hb(cfg.get('server') or DEFAULT_CONFIG['server'], saved_pw,
                     cfg.get('interval') or 3,
                     lambda s: root.after(0, lambda: set_status(s, '#2e7d32')),
                     idle_after_s=cfg.get('idle_after_s'),
                     idle_interval=cfg.get('idle_interval'),
                     focus_cb=on_focus)
            root.withdraw()
            make_tray()

    root.mainloop()


# ---------- 命令行入口(调试用) ----------
def main():
    ap = argparse.ArgumentParser(description='前台"正在用"客户端')
    ap.add_argument('--gui', action='store_true', help='打开设置窗口')
    ap.add_argument('--once', action='store_true', help='打印一次当前焦点进程后退出')
    ap.add_argument('--check', action='store_true', help='仅登录验证')
    ap.add_argument('--server')
    ap.add_argument('--password')
    ap.add_argument('--interval', type=int)
    ap.add_argument('--idle-after-s', type=int, help='鼠标空闲多少秒后降频(覆盖 cfg)')
    ap.add_argument('--idle-interval', type=int, help='空闲后心跳间隔秒(覆盖 cfg)')
    args = ap.parse_args()

    if args.gui:
        run_gui()
        return

    cfg = load_config()
    if args.server:
        cfg['server'] = args.server
    if args.password:
        cfg['password'] = args.password
    elif cfg.get('password_b64'):
        d = decrypt_password(cfg)
        if d is not None:
            cfg['password'] = d
    password = cfg.get('password') or ''

    if not password:
        print('未配置密码:去 GUI 填一次(python now_playing.py --gui),或 --password 传。')
        sys.exit(1)

    class _Gui:
        def show(self, s): print(s)
    base = (cfg.get('server') or DEFAULT_CONFIG['server']).rstrip('/') + '/'
    interval = max(1, int(cfg.get('interval') or 3))

    if args.once:
        p, t = get_foreground_process()
        print('proc  =', p)
        print('title =', t)
        return

    if args.check:
        res = post_json(base + 'api/client/login', {'password': password})
        print('登录', '成功' if res.get('token') else '失败')
        return

    hb = Heartbeat(base, password, interval, _Gui().show,
                   idle_after_s=args.idle_after_s if args.idle_after_s is not None else cfg.get('idle_after_s', 120),
                   idle_interval=args.idle_interval if args.idle_interval is not None else cfg.get('idle_interval', 30))
    print(f'[loop] 开始上报(活跃 {interval}s / 空闲 {hb.idle_interval}s,阈值 {hb.idle_after_s}s),Ctrl+C 退出…')
    hb.start()
    try:
        while not hb._stop.is_set():
            hb._stop.wait(0.5)
    except KeyboardInterrupt:
        hb.stop()
        print('\n已停止。')


if __name__ == '__main__':
    if '--gui' in sys.argv[1:] or (getattr(sys, 'frozen', False) and not any(a.startswith('--') for a in sys.argv[1:])):
        run_gui()
    else:
        main()