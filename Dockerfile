FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client/package.json ./client/package.json

RUN npm ci && npm run build -w shared

ENV PORT=8787
EXPOSE 8787

CMD ["node", "--import", "tsx", "server/src/main.ts"]
