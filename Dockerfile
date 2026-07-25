FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY . .
RUN yarn build:client

FROM node:22-alpine

RUN addgroup -S tunnel && adduser -S tunnel -G tunnel

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/serve ./serve
COPY --from=build /app/dist ./dist

USER tunnel

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7860/__health || exit 1

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
