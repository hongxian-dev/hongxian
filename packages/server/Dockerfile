# syntax=docker/dockerfile:1
# 红线平台服务 · 单容器镜像（哑管道广场 + 加密信箱）
# 零知识：容器内无任何解密能力；无出网；数据卷外挂；删卷即删库。

FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
RUN npm ci
RUN npm run build

FROM node:22-slim
WORKDIR /repo
COPY --from=build /repo .
# 裁剪 devDependencies（typescript/vitest 等构建期依赖）
RUN npm prune --omit=dev && npm cache clean --force
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV HONGXIAN_SERVER_DATA=/data
ENV PORT=8787
ENV HONGXIAN_INSTANCE=localhost
EXPOSE 8787
VOLUME ["/data"]
USER node
CMD ["node", "packages/server/dist/index.js"]
