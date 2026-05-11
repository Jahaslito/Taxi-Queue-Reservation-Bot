# Use the official Playwright image — has all browser deps pre-installed
FROM mcr.microsoft.com/playwright:v1.42.1-jammy

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Create persistent data directory for SQLite
RUN mkdir -p data

# Expose port
EXPOSE 3000

CMD ["node", "server.js"]
