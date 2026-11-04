# 开放题版 MBTI —— 公网部署镜像
#
# 前端与 API 同源部署：浏览器 → /api/* → 本进程 → 模型 API。
# 访客不需要登录，也不需要填 Key；密钥只存在于服务端环境变量，
# 任何时候都不会被下发到浏览器。
#
# 本项目零运行时依赖，因此不需要 npm install。

FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5173/api/health || exit 1

CMD ["node", "server.mjs"]
