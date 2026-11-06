# Unit7 in one image. Node runs the TypeScript directly, so the only build is the web app.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:24-slim
ENV NODE_ENV=production UNIT7_HOME=/data UNIT7_HOST=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client git ca-certificates && rm -rf /var/lib/apt/lists/* && useradd -r -m -d /home/unit7 unit7 && mkdir /data && chown unit7 /data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY assets ./assets
RUN npm ci --omit=dev && chown -R unit7 /app
USER unit7
VOLUME /data
EXPOSE 4800
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4800/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts", "serve", "--host", "0.0.0.0"]
