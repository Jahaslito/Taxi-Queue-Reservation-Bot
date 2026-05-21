# SAN Queue — DigitalOcean Deployment Guide

## Recommended Droplet

| Spec | Minimum | Recommended |
|------|---------|-------------|
| Plan | Basic | Basic |
| RAM  | 2 GB ($12/mo) | 4 GB ($24/mo) |
| CPU  | 1 vCPU | 2 vCPU |
| OS   | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Region | Closest to San Diego | Closest to San Diego |

> **Why not the $5 plan?** Playwright/Chromium uses 300–500 MB per run.
> With Node + PostgreSQL on the same box, you need at least 2 GB or the
> OS will OOM-kill the bot mid-run.

---

## Step 1 — Create the Droplet

1. Go to DigitalOcean → Create → Droplets
2. Choose **Ubuntu 22.04 LTS**
3. Choose **Basic → Regular → 2GB** (or 4GB)
4. Add your SSH key (or use a password — SSH key is safer)
5. Create the droplet, note the IP address

---

## Step 2 — Point Your Domain

In your DNS provider, add an **A record**:

```
Type: A
Name: sanqueue   (or @ for root domain)
Value: YOUR_DROPLET_IP
TTL: 3600
```

Wait 5–15 minutes for DNS to propagate before getting SSL.

---

## Step 3 — First Login & System Setup

```bash
ssh root@YOUR_DROPLET_IP

# Update packages
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker

# Install Docker Compose plugin
apt install -y docker-compose-plugin

# Install nginx + certbot
apt install -y nginx certbot python3-certbot-nginx

# Verify
docker --version
docker compose version
nginx -v
```

---

## Step 4 — Clone the Repo

```bash
mkdir -p /opt/san-queue
cd /opt/san-queue

git clone https://github.com/YOUR_USERNAME/san-queue.git .
```

---

## Step 5 — Set Up Environment Variables

```bash
cp deploy/.env.production .env
nano .env
```

Fill in every value — especially:
- `DB_PASSWORD` — make it strong (random 32+ chars)
- `JWT_SECRET` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ENCRYPTION_KEY` — generate a **different** one the same way
- `ADMIN_PASSWORD` — your admin login password
- `APP_URL` — `https://your-domain.com`
- `MONITOR_QUEUE_URL`, `MONITOR_T1_URL`, `MONITOR_T2_URL` — copy from your local .env

---

## Step 6 — Start the Database + App

```bash
cd /opt/san-queue

# Start postgres first, then app
docker compose up -d

# Watch the startup logs
docker compose logs -f
```

You should see:
```
[DB] Migrations up to date
🚕  SAN Queue Scheduler running on port 3000
```

Test it's running:
```bash
curl http://localhost:3000/api/health
# → {"status":"ok",...}
```

---

## Step 7 — Configure nginx

```bash
# Copy the nginx config
cp /opt/san-queue/deploy/nginx.conf /etc/nginx/sites-available/san-queue

# Replace YOUR_DOMAIN with your actual domain
sed -i 's/YOUR_DOMAIN/sanqueue.yourdomain.com/g' /etc/nginx/sites-available/san-queue

# Enable it
ln -s /etc/nginx/sites-available/san-queue /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default   # remove the default placeholder

# Test the config
nginx -t

# Start nginx
systemctl enable nginx
systemctl start nginx
```

---

## Step 8 — Get SSL Certificate (Let's Encrypt)

```bash
certbot --nginx -d sanqueue.yourdomain.com
```

Follow the prompts:
- Enter your email
- Agree to Terms of Service
- Choose option **2** (redirect HTTP → HTTPS)

Certbot will automatically update your nginx config with the SSL cert paths.

Test SSL auto-renewal:
```bash
certbot renew --dry-run
```

---

## Step 9 — Verify Everything

```bash
# App health
curl https://sanqueue.yourdomain.com/api/health

# Logs
docker compose logs -f app

# Postgres
docker compose exec db psql -U san_queue -c "\dt"
```

Open in browser: `https://sanqueue.yourdomain.com`

---

## Updating the App (Future Deploys)

```bash
cd /opt/san-queue
bash deploy/deploy.sh
```

That's it — pulls code, rebuilds image, runs migrations, restarts app.

---

## Useful Commands

```bash
# Live logs
docker compose logs -f app

# Restart app only (no rebuild)
docker compose restart app

# Rebuild and restart after code change
docker compose up -d --build app

# Open a shell in the app container
docker compose exec app bash

# Connect to the database
docker compose exec db psql -U san_queue -d san_queue

# Check memory usage (watch for Playwright spikes)
docker stats

# Check disk usage
df -h
docker system df
```

---

## Firewall (Optional but Recommended)

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

This blocks all ports except SSH (22), HTTP (80), and HTTPS (443).
Port 3000 (the Node app) is only reachable from localhost via nginx.

---

## Backups

PostgreSQL data lives in a Docker named volume (`pgdata`).
Back it up with:

```bash
# Dump to a file
docker compose exec db pg_dump -U san_queue san_queue > backup_$(date +%Y%m%d).sql

# Restore from a dump
cat backup_20260521.sql | docker compose exec -T db psql -U san_queue -d san_queue
```

Consider setting up a daily cron for automated backups:
```bash
crontab -e
# Add:
0 3 * * * cd /opt/san-queue && docker compose exec -T db pg_dump -U san_queue san_queue > /opt/backups/san_queue_$(date +\%Y\%m\%d).sql
```
