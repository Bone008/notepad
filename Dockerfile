# ---- build stage -----------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/
COPY server/ server/
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:26-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    NOTEPAD_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/client/dist/ client/dist/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/dist/index.js"]
