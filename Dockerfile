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

CMD ["node", "server.js"]
