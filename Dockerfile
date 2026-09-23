# 博客后端运行于内置 node:sqlite,无需 npm 依赖,直接运行 server.js
FROM node:24-alpine

WORKDIR /app

COPY package.json* ./
# 无第三方依赖时跳过安装;若未来加了依赖,取消下行注释并保留 package.json
# RUN npm install --omit=dev || true

# HTML 页在 assets/html/ 下,随 assets/ 一并拷入,无需单独 COPY
COPY assets/ ./assets/
COPY music/ ./music/
# 模块化后端(src/):路由/认证/DB 等逻辑所在,server.js 依赖它,必须一并拷入
COPY src/ ./src/
# 全站背景视频,首页 _bg.html 通过 /background/Scene1.mp4 引用
COPY background/ ./background/
COPY server.js ./

EXPOSE 8080

# 生产默认:监听所有网卡,数据库与上传/相册目录放 /data(由 compose 的命名卷持久化)
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/blog.db \
    UPLOAD_DIR=/data/uploads \
    PHOTO_DIR=/data/photo

CMD ["node", "server.js"]