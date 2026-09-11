# Build context is the Assembly_AI/ project root (not server/), because
# server/index.js serves the static frontend via a relative "../public"
# path -- the image needs both directories in that same relative layout.

FROM node:24-alpine

WORKDIR /app

# Install deps first so this layer is cached unless package*.json changes.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY public ./public

WORKDIR /app/server
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
