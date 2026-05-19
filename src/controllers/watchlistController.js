'use strict';

// ─── Watchlist Controller ─────────────────────────────────────────────────────
// REST handlers for the auto-monitored driver watchlist.
// All active drivers are watched automatically by monitorService.

const monitor = require('../services/monitorService');

// ─── GET /api/admin/watchlist/stats ──────────────────────────────────────────
// Aggregate counts for the stats bar — fast in-memory read.
function getStats(req, res) {
  res.json(monitor.getStats());
}

// ─── GET /api/admin/watchlist ─────────────────────────────────────────────────
// Paginated + filtered snapshot of all watched driver states.
// All computation is in-memory (no DB query per request).
function getWatchlist(req, res) {
  const {
    page    = '1',
    limit   = '50',
    search  = '',
    status  = 'all',
    sortBy  = 'vehicleNumber',
    sortDir = 'asc',
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  // Pull full state from service
  const { watches } = monitor.getState();
  let items = watches;

  // Filter by search
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    items = items.filter(
      (s) =>
        s.vehicleNumber.toLowerCase().includes(q) ||
        (s.driverName && s.driverName.toLowerCase().includes(q)),
    );
  }

  // Filter by status
  if (status && status !== 'all') {
    items = items.filter((s) => s.state === status);
  }

  // Sort
  items = [...items].sort((a, b) => {
    let va, vb;
    switch (sortBy) {
      case 'vehicleNumber':  va = a.vehicleNumber;  vb = b.vehicleNumber;  break;
      case 'driverName':     va = a.driverName || ''; vb = b.driverName || ''; break;
      case 'state':          va = a.state;           vb = b.state;          break;
      case 'requeuedToday':  va = a.requeueCountToday; vb = b.requeueCountToday; break;
      case 'lastRequeuedAt': va = a.lastRequeuedAt ? new Date(a.lastRequeuedAt).getTime() : 0;
                             vb = b.lastRequeuedAt ? new Date(b.lastRequeuedAt).getTime() : 0;
                             break;
      default:               va = a.vehicleNumber;  vb = b.vehicleNumber;
    }
    if (typeof va === 'string') return sortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  const total  = items.length;
  const offset = (pageNum - 1) * limitNum;
  const page_items = items.slice(offset, offset + limitNum);

  res.json({
    items:  page_items,
    total,
    page:   pageNum,
    limit:  limitNum,
    pages:  Math.ceil(total / limitNum) || 1,
  });
}

// ─── POST /api/admin/watchlist/run/:driverId ──────────────────────────────────
// Manually trigger the bot for a watched driver ("Run" button).
async function runBot(req, res, next) {
  try {
    const driverId = parseInt(req.params.driverId, 10);
    await monitor.manualRun(driverId);
    res.json({ message: 'Bot triggered — check the live feed for results.' });
  } catch (err) {
    err.statusCode = err.message.includes('not in watch list') ? 404 : 400;
    next(err);
  }
}

// ─── GET /api/admin/watchlist/stream ─────────────────────────────────────────
// SSE stream for the Watchlist page.
// Sends a lightweight init (stats only, no 1000-row payload) — the frontend
// loads the initial table via the REST GET endpoint, then patches rows via SSE.
function getStream(req, res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Lightweight init: stats + poll status (no full watch list dump)
  const initPayload = {
    stats:    monitor.getStats(),
    pollStats: monitor.getState().pollStats,
    jobQueue:  monitor.getState().jobQueue,
  };
  res.write(`data: ${JSON.stringify({ type: 'wl_init', payload: initPayload, ts: Date.now() })}\n\n`);

  // Heartbeat every 20s
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  // Forward all monitor events — frontend filters to what it cares about
  const unsubscribe = monitor.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

module.exports = { getStats, getWatchlist, runBot, getStream };
