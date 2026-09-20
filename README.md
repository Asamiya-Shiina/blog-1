# Ciallo～(∠・ω< )⌒☆ · 沐玺个人博客

沐玺（Mako）的个人博客，记录技术分享、随笔与生活日常。

一个**零第三方依赖**的 Node 服务：自建 http 静态服务器 + SQLite 数据库 + JSON API，配合原生前端。后端内置 `node:sqlite`，无需 `npm install`，`node server.js` 即可跑起来。

## 功能特性

- **前后端一体**：`server.js` 同时负责静态资源与 JSON API，零外部依赖
- **Markdown 写作**：后台所见即所得，前端 `markdown.js` 渲染（内置 HTML 转义 + 链接协议白名单，防 XSS）
- **后台管理**：文章增删改、图片上传、一键发布（`admin.html`）
- **SQLite 持久化**：文章与设置存 `blog.db`，可 Docker 命名卷外置
- **登录安全**：HttpOnly + SameSite cookie 会话、scrypt 加盐密码、登录失败限流、服务端会话过期
- **首次设置密码**：不写死默认密码，全新部署后进入后台自动引导设置管理员密码
- **图片上传**：base64 上传，魔数校验文件头，服务器生成文件名
- **悬浮音乐播放器**、响应式布局、毛玻璃导航、移动端汉堡菜单

## 目录结构

```
blog/
├── server.js            # 后端：http 静态服务 + SQLite + JSON API
├── assets/              # 全部前端源码（css / js / html 统一收纳于此）
│   ├── css/
│   │   ├── style.css    # 前台样式（变量 / 布局 / 组件）
│   │   ├── admin.css    # 后台专属样式
│   │   └── ripple.css   # 水波过渡层（页面跳转动画）
│   ├── js/
│   │   ├── main.js      # 首页交互 / 列表渲染
│   │   ├── post.js      # 文章详情渲染
│   │   ├── admin.js     # 后台逻辑（设置密码 / 登录 / 文章 CRUD / 上传）
│   │   ├── album.js     # 相册网格 / 上传交互
│   │   ├── player.js    # 悬浮音乐播放器（跨页持久化）
│   │   ├── clock.js     # 顶部时钟问候
│   │   ├── markdown.js  # Markdown → HTML 渲染器
│   │   └── ripple.js    # 水波过渡通用绑定（data-ripple 元素）
│   └── html/            # 页面；URL 由 server.js 映射为根级干净地址
│       ├── index.html   # 首页（文章列表 / Hero / 侧边栏）→ /
│       ├── post.html    # 文章详情页 → /post.html
│       ├── profile.html # 个人 Profile 页 → /profile.html
│       ├── admin.html   # 后台管理页 → /admin.html
│       └── 404.html     # 兜底 404 页 → 任何未命中 URL
├── music/               # 悬浮播放器的音频
├── background/          # 全站背景视频
├── blog.db              # SQLite 数据库（运行时生成）
├── uploads/             # 上传的图片（运行时生成）
├── photo/               # 相册原图（运行时生成）
├── Dockerfile           # 容器镜像（node:24-alpine，内置 node:sqlite）
└── docker-compose.yml   # 一键部署：命名卷持久化数据库与上传
```

## 快速开始（本地）

> 需要 Node.js ≥ 22.5（内置 `node:sqlite`）。

```bash
node server.js
# 打开 http://127.0.0.1:8080
```

- 首页/文章列表：`http://127.0.0.1:8080/`
- 后台管理：`http://127.0.0.1:8080/admin.html`
- **首次访问后台会自动进入"设置管理员密码"页**；设置后才是登录页。

也可用任意方式把 `server.js` 与静态文件丢到一台 Node 机器上运行。

## Docker 部署

```bash
docker compose up -d --build
```

容器内所有数据集中在 `/data`（数据库 `/data/blog.db`、插图 `/data/uploads`、相册 `/data/photo`），用命名卷 `blog-data` 持久化，重建不丢：

```yaml
volumes:
  - blog-data:/data   # 默认命名卷;想挂宿主目录改成 /绝对/路径/data 即可
```

默认监听 8080，可用 `BLOG_PORT` 换端口：

```bash
BLOG_PORT=9090 docker compose up -d --build
```

常用维护：`docker compose logs -f`（看日志）、`docker compose down`（停止不删数据）、<br>`docker compose down -v`（⚠️ 会删掉所有数据）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/posts` | 文章列表（不含正文） |
| GET | `/api/posts/:id` | 单篇文章全文 |
| POST | `/api/posts` | 新建文章（需登录） |
| PUT | `/api/posts/:id` | 更新文章（需登录） |
| DELETE | `/api/posts/:id` | 删除文章（需登录） |
| POST | `/api/login` | 登录，下发会话 cookie |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/me` | 当前登录态 + 是否需设置密码（`needsSetup`） |
| POST | `/api/setup` | 首次设置管理员密码（仅当未设置时允许） |
| POST | `/api/upload` | 上传图片（base64，需登录） |

## 技术栈

- Node.js（http / crypto / node:sqlite，零第三方依赖）
- SQLite（内置 `node:sqlite`）
- HTML5 / CSS3（Grid、Flex、CSS 变量、毛玻璃）
- 原生 JavaScript

## 安全说明

- SQL 全部参数化，无注入
- 前端 `innerHTML` 仅有文章正文一处，经 `markdown.js` 转义与协议白名单处理
- 密码 scrypt 加盐哈希，登录失败按 IP 限流
- 上传校验图片魔数，文件名服务端生成