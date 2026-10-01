FROM node:22-alpine

ENV NODE_ENV=development \
    PORT=3001

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server ./server

USER node

EXPOSE 3001

CMD ["node", "server/index.js"]