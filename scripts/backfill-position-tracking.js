#!/usr/bin/env node
// Backfill missing actual_position values in the position_tracking table from
// historical log files.
//
// Why this exists: a bug in monitorService set hasBeenSeen=true on bot success
// BEFORE the poll loop could observe the driver in V Holding, so the
// updateActualPosition code path never ran for successful position-schedule
// fires. Result: position_tracking rows stayed at decision='fired' with
// actual_position=NULL forever (shown as "pending" in the admin UI).
//
// This script parses lines like:
//   [2026-05-24 05:33:40 PT] [INFO] [Pos] ✓ #0387 → pos #147
// and updates the matching position_tracking row (vehicle_number + tracking_date)
// with actual_position, landed_at, decision='completed'.
//
// Failed bot lines (`[Pos] ✓ #X → failed — ...`) are intentionally skipped —
// no actual landing position to record.
//
// Usage:
//   node scripts/backfill-position-tracking.js <log-file> [<log-file> ...]
//   node scripts/backfill-position-tracking.js --dry-run <log-file>
//
// Safe to re-run: only updates rows where actual_position IS NULL.

require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const db = require('../src/config/database');

const DRY_RUN = process.argv.includes('--dry-run');
const FILES   = process.argv.slice(2).filter((a) => a !== '--dry-run');

if (FILES.length === 0) {
  console.error('Usage: node scripts/backfill-position-tracking.js [--dry-run] <log-file> [<log-file> ...]');
  process.exit(1);
}

// Matches: [2026-05-24 05:33:40 PT] ... [Pos] ✓ #0387 → pos #147
// Skips:   [Pos] ✓ #X → failed — ...
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) PT\].*\[Pos\] ✓ #(\S+) → pos #(\d+)/;

async function collect(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events = [];
  for await (const line of rl) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    events.push({
      date:      m[1],                          // YYYY-MM-DD (PT day key)
      time:      m[2],                          // HH:MM:SS
      vehicle:   m[3],                          // raw — DB stores it the same way
      position:  parseInt(m[4], 10),
    });
  }
  return events;
}

async function main() {
  const allEvents = [];
  for (const file of FILES) {
    if (!fs.existsSync(file)) {
      console.error(`File not found, skipping: ${file}`);
      continue;
    }
    const before = allEvents.length;
    allEvents.push(...await collect(file));
    console.log(`Parsed ${allEvents.length - before} fire events from ${file}`);
  }

  if (allEvents.length === 0) {
    console.log('No matching log lines found. Nothing to backfill.');
    return;
  }

  // De-dupe: if the same (vehicle, date) appears more than once (multiple fires
  // somehow, or log lines duplicated by a session restart), keep the EARLIEST
  // entry — that's the one matching the original tracking row's fired_at.
  const earliest = new Map(); // key = `${date}|${vehicle}` → event
  for (const ev of allEvents) {
    const key = `${ev.date}|${ev.vehicle}`;
    const prev = earliest.get(key);
    if (!prev || ev.time < prev.time) earliest.set(key, ev);
  }

  console.log(`\n${earliest.size} unique (vehicle, date) fire events to consider.`);
  if (DRY_RUN) console.log('--- DRY RUN — no rows will be written ---\n');

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const ev of earliest.values()) {
    // Look up the matching row. We only touch rows that are still pending.
    const row = await db('position_tracking')
      .where({ vehicle_number: ev.vehicle, tracking_date: ev.date })
      .first();

    if (!row) {
      missing++;
      console.log(`  [no row]    ${ev.date} #${ev.vehicle} → pos #${ev.position}`);
      continue;
    }
    if (row.actual_position !== null && row.actual_position !== undefined) {
      skipped++;
      console.log(`  [has data]  ${ev.date} #${ev.vehicle} actual=${row.actual_position} (log says ${ev.position}) — skip`);
      continue;
    }

    const landedAt = new Date(`${ev.date}T${ev.time}-07:00`); // PT = UTC-7 (PDT during summer)
    console.log(`  [backfill]  ${ev.date} #${ev.vehicle} target=${row.target_position} → actual=${ev.position} (landed_at=${landedAt.toISOString()})`);

    if (!DRY_RUN) {
      await db('position_tracking').where({ id: row.id }).update({
        actual_position: ev.position,
        landed_at:       landedAt,
        decision:        'completed',
        decision_reason: 'backfilled_from_logs',
      });
    }
    updated++;
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`);
  console.log(`Skipped (already had actual_position): ${skipped}`);
  console.log(`No matching position_tracking row:     ${missing}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.destroy());
