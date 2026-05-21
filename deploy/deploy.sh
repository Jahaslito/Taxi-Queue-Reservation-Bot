#!/usr/bin/env bash
# ─── SAN Queue — Deployment Script ───────────────────────────────────────────
# Run on the droplet from /opt/san-queue:
#   bash deploy/deploy.sh
#
# First-time setup: use the step-by-step guide in deploy/SETUP.md instead.
# This script handles incremental updates only.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/san-queue"
COMPOSE="docker compose"

echo ""
echo "┌─────────────────────────────────────────┐"
echo "│         SAN Queue  Deploy                │"
echo "└─────────────────────────────────────────┘"
echo ""

cd "$APP_DIR"

# ── 1. Pull latest code ───────────────────────────────────────────────────────
echo "▶ Pulling latest code…"
git pull origin main

# ── 2. Rebuild app image (only if code changed) ───────────────────────────────
echo "▶ Building app image…"
$COMPOSE build app

# ── 3. Run migrations BEFORE swapping containers ─────────────────────────────
echo "▶ Running database migrations…"
$COMPOSE run --rm app node -e "
  require('dotenv').config();
  const knex = require('knex')(require('./knexfile')[process.env.NODE_ENV || 'production']);
  knex.migrate.latest()
    .then(([batch, files]) => {
      if (files.length) console.log('Ran migrations:', files);
      else console.log('Already up to date.');
      process.exit(0);
    })
    .catch(err => { console.error(err); process.exit(1); });
"

# ── 4. Restart app with zero-downtime window ──────────────────────────────────
echo "▶ Restarting app…"
$COMPOSE up -d --no-deps app

# ── 5. Health check ───────────────────────────────────────────────────────────
echo "▶ Waiting for health check…"
for i in $(seq 1 12); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health || true)
  if [ "$STATUS" = "200" ]; then
    echo "✓ App is healthy (${i}s)"
    break
  fi
  echo "  …waiting (${i}0s)"
  sleep 10
done

if [ "$STATUS" != "200" ]; then
  echo "✗ Health check failed after 120s — check logs:"
  echo "  docker compose logs --tail=50 app"
  exit 1
fi

# ── 6. Clean up old images ────────────────────────────────────────────────────
echo "▶ Pruning unused images…"
docker image prune -f

echo ""
echo "✅  Deploy complete!"
echo "   Logs: docker compose logs -f app"
