# syntax=docker/dockerfile:1
# EvansClaw Web Gateway（个人助手 + 多人聊天室）镜像。
#
#   docker compose up -d --build
#
# 数据（SQLite、models.yaml、工作区）位于 /app/data，请挂载卷持久化。

ARG NODE_VERSION=22-bookworm-slim

# ---------- 构建前端 ----------
FROM node:${NODE_VERSION} AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 生产依赖 ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- 运行时 ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    EVANSCLAW_WEB_HOST=0.0.0.0 \
    EVANSCLAW_WEB_PORT=8787
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json models.example.yaml ./
COPY --chown=node:node src ./src
COPY --chown=node:node skills ./skills
COPY --from=web-build --chown=node:node /app/web/dist ./web/dist

RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.EVANSCLAW_WEB_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接启动 Gateway（前端已在构建阶段产出，不再走 npm 的 preweb 构建）。
CMD ["node", "--import", "tsx", "src/web-main.ts"]
