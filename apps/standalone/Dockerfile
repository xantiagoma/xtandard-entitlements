# Standalone @xtandard/entitlements admin panel + customer portal + HTTP API.
# Build context is the repository ROOT:
#   docker build -f apps/standalone/Dockerfile -t xtandard-entitlements .
# Run with your catalog mounted:
#   docker run -p 3000:3000 -v $PWD/catalog.ts:/app/catalog.ts -e CATALOG_PATH=/app/catalog.ts xtandard-entitlements
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile || bun install

# Copy sources and build the bundled admin UI / portal (dist/ui).
COPY . .
RUN (bun run build:ui || echo "UI not built — the panel serves the JSON API and a build hint.") \
  && mkdir -p dist/ui

FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# The app runs the library from source (Bun executes TS), so we ship src + the
# built UI bundle + node_modules (valibot, storage / counter drivers).
COPY --from=build /app/src ./src
COPY --from=build /app/dist/ui ./dist/ui
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/apps/standalone ./apps/standalone

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthcheck').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "apps/standalone/src/index.ts"]
