# The match runs it with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, and the map at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY bot.ts map.ts mechfight.ts package.json ./
ENTRYPOINT ["bun", "/bot/bot.ts"]
