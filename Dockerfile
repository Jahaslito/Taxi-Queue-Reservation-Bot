# ─── SAN Queue — Production Dockerfile ───────────────────────────────────────
#
# Two-layer strategy for fast rebuilds:
#   Layer 1 (slow, rarely changes): node:22-slim base + system libs + npm deps
#                                   + Playwright downloads its own Chromium here
#   Layer 2 (fast, changes often):  COPY source code
#
# Result: rebuilds after a code change take ~10s because only Layer 2 re-runs.
# The base pull is ~70MB (node:22-bookworm-slim) vs the old 568MB Playwright image.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim

# ── System libraries required by Chromium at runtime ──────────────────────────
# Playwright downloads its own Chromium binary; these are the OS-level shared
# libraries that binary depends on. Installing them here keeps them in the
# cached layer so they don't re-download on every app code change.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium runtime
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libdbus-1-3 libxcb1 libxkbcommon0 libatspi2.0-0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    # Utilities needed by Playwright's install script
    ca-certificates curl wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Store Playwright browsers in a predictable location ───────────────────────
# This keeps the browser binaries OUT of node_modules and in a fixed path.
# The entire /ms-playwright dir is cached in this layer — only re-downloaded
# when the playwright version in package.json changes.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ── Install dependencies + Playwright's Chromium (cached layer) ───────────────
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install chromium

# ── Copy application source (changes on every deploy) ────────────────────────
COPY . .

# ── Runtime config ────────────────────────────────────────────────────────────
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', \
    r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "--no-warnings", "server.js"]
