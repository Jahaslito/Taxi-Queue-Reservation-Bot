#!/usr/bin/env node
// ─── Emergency rescue for a BORROWED probe driver ────────────────────────────
//
// Use this if a driver lent to the tail probe (MONITOR_BORROW_PROBE) appears
// stuck in SAN's queue. It does two things, in order:
//   1) REMOVE — logs into SAN with the driver's own credentials and runs the
//      robust, server-verified two-step remove until the vehicle is confirmed
//      OUT of V Holding. This works even if the app/monitor is wedged.
//   2) RE-ARM — asks the running server (via the local admin API, using a
//      self-minted admin token) to stop borrowing this driver for the rest of
//      today AND re-arm the position scheduler, so they STILL land at their
//      real target. If the server is unreachable, step 1 still protected the
//      driver; re-arm them from the admin "Borrowed Drivers" table instead.
//
// Usage (from the host):
//   docker compose exec app node scripts/rescueBorrowedDriver.js <vehicleNumber>
//   docker compose exec app node scripts/rescueBorrowedDriver.js --id <driverId>
//
// Examples:
//   docker compose exec app node scripts/rescueBorrowedDriver.js 250
//   docker compose exec app node scripts/rescueBorrowedDriver.js --id 42
//
// Safe to re-run. Exits non-zero only if the SAN removal could not be confirmed.

require('dotenv').config();
const db          = require('../src/config/database');
const Driver      = require('../src/models/Driver');
const botService  = require('../src/services/botService');
const { decrypt } = require('../src/services/cryptoService');
const { generateToken } = require('../src/middleware/auth');

const PORT = process.env.PORT || 3000;

async function resolveDriver(args) {
  const idFlag = args.indexOf('--id');
  if (idFlag !== -1) {
    const id = parseInt(args[idFlag + 1], 10);
    return Driver.findByIdWithCredentials(id);
  }
  const vehicle = args.find((a) => !a.startsWith('--'));
  if (!vehicle) return null;
  const row = await Driver.findByVehicleNumber(vehicle);
  return row ? Driver.findByIdWithCredentials(row.id) : null;
}

async function rearmViaApi(driverId) {
  // Mint a short-lived admin token (JWT_SECRET is the same one the server uses)
  // and hit the local rescue endpoint so the in-memory monitor does the
  // retire + exclude + re-arm in its own process.
  try {
    const token = generateToken(0, 'admin', '5m');
    const res = await fetch(`http://localhost:${PORT}/api/admin/drivers/${driverId}/rescue-borrow`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`✓ Server re-armed driver ${driverId}: ${body.message ?? 'ok'}`);
      return true;
    }
    console.warn(`⚠ Re-arm API returned ${res.status}: ${body.error ?? 'unknown'}`);
    return false;
  } catch (err) {
    console.warn(`⚠ Could not reach the local server to re-arm (${err.message}).`);
    console.warn('  The SAN removal above still protected the driver — re-arm them from');
    console.warn('  the admin "Borrowed Drivers" table (🛟 Rescue & Re-arm) once the app is up.');
    return false;
  }
}

(async () => {
  const args   = process.argv.slice(2);
  const driver = await resolveDriver(args);
  if (!driver) {
    console.error('Driver not found. Usage: node scripts/rescueBorrowedDriver.js <vehicleNumber> | --id <driverId>');
    await db.destroy();
    process.exit(2);
  }
  if (!driver.san_username || !driver.san_password) {
    console.error(`Driver #${driver.vehicle_number} has no SAN credentials on file — cannot remove.`);
    await db.destroy();
    process.exit(2);
  }

  const vehicle = driver.vehicle_number;
  console.log(`🛟 Rescuing borrowed driver #${vehicle} (id=${driver.id})…`);

  let removeOk = false;
  try {
    const res = await botService.removeFromQueue(driver.san_username, decrypt(driver.san_password), vehicle);
    removeOk = !!res?.success;
    console.log(removeOk
      ? `✓ SAN confirms #${vehicle} is OUT of the queue.`
      : `⚠ SAN removal did NOT confirm for #${vehicle} (${res?.error ?? res?.notConfirmed ? 'not confirmed' : 'unknown'}). Check V Holding manually.`);
  } catch (err) {
    console.error(`✗ SAN removal failed for #${vehicle}: ${err.message}`);
  }

  await rearmViaApi(driver.id);

  await db.destroy();
  process.exit(removeOk ? 0 : 1);
})();
