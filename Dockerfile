# Multi-stage build: compiles React UI, then runs a single lean Node server
# serving both /api/* and the built SPA on port 3001.
FROM node:22-alpine AS ui-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache docker-cli bash curl openssh-client
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY --from=ui-builder /app/build ./build

ENV PORT=3001
ENV BIND_HOST=0.0.0.0
EXPOSE 3001
CMD ["node", "server/index.js"]
