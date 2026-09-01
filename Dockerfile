FROM oven/bun:1.2

ARG CODEX_VERSION=0.149.1
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && codex --version

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/bot.sqlite
ENV CODEX_HOME=/data/codex
ENV CODEX_WORKSPACE=/data/codex-workspace
ENV REPOSITORIES_PATH=/data/repositories
# Codex binary is installed at build time; credentials are supplied only at runtime.
# No auth file, secret, or Codex home is copied into this image.
ENV CODEX_BIN=codex

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e 'fetch("http://127.0.0.1:3000/health").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["bun", "run", "start"]
