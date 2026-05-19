# Use the official Playwright image — has all Chromium dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.42.1-jammy

WORKDIR /app

# Install Node dependencies first (separate layer for better caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose HTTP port
EXPOSE 3000

# Railway uses this to know when the container is healthy and ready for traffic
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
