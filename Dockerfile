# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4317
# Mount the plugin's events.jsonl at this path (read-only):
#   docker run -p 4317:4317 -v /abs/project/.claude-team/events.jsonl:/data/events.jsonl:ro claude-board
ENV EVENTS_LOG=/data/events.jsonl
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 4317
CMD ["node", "server.js"]
