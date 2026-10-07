#!/usr/bin/env node
/**
 * Re-run the add bot for every driver whose add FAILED today and never
 * succeeded afterwards (e.g. after an EAGAIN "Bot temporarily unavailable" outage).
 *
 * Reads today's log (PT), diffs `[Scheduler] ✗ NAME →` against `[Scheduler] ✓ NAME →`
 * (remove-bot lines ignored), then calls the LIVE app's
 * POST /api/admin/drivers/:id/trigger one driver at a time — so every run goes
 * through the running app's BotSemaphore instead of spawning browsers here.
 *
 * Dry run by default. Inside the container:
 *   docker compose exec app node scripts/retrigger-failed.js            # list only
 *   docker compose exec app node scripts/retrigger-failed.js --confirm  # run them
 * Optional: --date YYYY-MM-DD to read another day's log.
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../src/config/database');
const { port, jwtSecret } = require('../src/config/env');
const jwt  = require('jsonwebtoken');

const args    = process.argv.slice(2);
const confirm = args.includes('--confirm');
const dateArg = args[args.indexOf('--date') + 1];
const today   = args.includes('--date') ? dateArg
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const logDir  = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs');

async function main() {
  const text = fs.readFileSync(path.join(logDir, `${today}.log`), 'utf8');
  const failed = new Set();
  const ok     = new Set();
  for (const line of text.split('\n')) {
    if (line.includes('(remove)')) continue;
    let m = line.match(/\[Scheduler\] ✗ (.+?) → /);
    if (m) { failed.add(m[1].trim()); continue; }
    m = line.match(/\[Scheduler\] ✓ (.+?) → /);
    if (m) ok.add(m[1].trim());
  }
  const pending = [...failed].filter((n) => !ok.has(n));
  console.log(`${today}: ${failed.size} failed, ${failed.size - pending.length} recovered, ${pending.length} still not added`);

  const drivers = pending.length
    ? await db('drivers').whereIn('name', pending).where({ is_active: true }).select('id', 'name', 'vehicle_number')
    : [];
  const found = new Set(drivers.map((d) => d.name));
  for (const n of pending) if (!found.has(n)) console.log(`  – skip ${n} (not found or inactive)`);
  for (const d of drivers) console.log(`  • #${d.vehicle_number} ${d.name} (id ${d.id})`);

  if (!confirm) { console.log('\nDry run — re-run with --confirm to trigger these.'); return; }

  const admin = await db('admin_users').where(function () {
    this.whereNull('role').orWhere('role', 'super_admin');
  }).first('id');
  if (!admin) throw new Error('No super_admin found in admin_users');
  const token = jwt.sign({ id: admin.id, role: 'admin' }, jwtSecret, { expiresIn: '1h' });

  for (const d of drivers) {
    process.stdout.write(`→ #${d.vehicle_number} ${d.name} … `);
    try {
      const res  = await fetch(`http://localhost:${port}/api/admin/drivers/${d.id}/trigger`, {
        method: 'POST', headers: { cookie: `token=${token}` },
      });
      const body = await res.json().catch(() => ({}));
      const r    = body.result ?? body;
      console.log(res.ok ? (r.success ? `✓ ${r.message ?? ''}` : `✗ ${r.message ?? r.error ?? JSON.stringify(r)}`) : `HTTP ${res.status} ${body.error ?? ''}`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => db.destroy());
