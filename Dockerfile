# 博客后端运行于内置 node:sqlite,无需 npm 依赖,直接运行 server.js
FROM node:24-alpine

WORKDIR /app

COPY package.json* ./
# 无第三方依赖时跳过安装;若未来加了依赖,取消下行注释并保留 package.json
# RUN npm install --omit=dev || true

COPY index.html post.html profile.html admin.html ./
COPY assets/ ./assets/
COPY music/ ./music/
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