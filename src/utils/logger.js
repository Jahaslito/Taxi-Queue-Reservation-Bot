'use strict';

/**
 * Daily-rotating file logger.
 *
 * • One log file per calendar day (Pacific Time): logs/YYYY-MM-DD.log
 * • Writes a header line when a new file is created or a session resumes after restart.
 * • Writes a footer line when the date rolls over, naming the next file.
 * • Overrides console.log / console.warn / console.error globally so all existing
 *   log calls are captured automatically — no changes needed elsewhere.
 * • Console output is preserved as-is (PM2 / Docker adds its own timestamps there).
 * • File lines include a PT timestamp prefix for easy grepping without PM2.
 *
 * Initialise once at server startup:
 *   require('./src/utils/logger');
 */

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Internal state ───────────────────────────────────────────────────────────
let _currentDate   = '';  // YYYY-MM-DD in PT
let _currentStream = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _datePT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** Human-readable PT timestamp: "2026-05-23 05:17:44 PT" */
function _stampPT() {
  const s = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  });
  // toLocaleString gives "05/23/2026, 05:17:44" — reformat to ISO-ish
  const [datePart, timePart] = s.split(', ');
  const [month, day, year]   = datePart.split('/');
  return `${year}-${month}-${day} ${timePart} PT`;
}

/** Serialise a single console argument to a string. */
function _serialize(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error)    return `${arg.message}\n${arg.stack ?? ''}`;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

// ─── Stream management ────────────────────────────────────────────────────────
/**
 * Returns the write-stream for today's log file.
 * Rotates automatically when the PT date changes.
 */
function _getStream() {
  const date = _datePT();
  if (date === _currentDate && _currentStream) return _currentStream;

  const nextFile = path.join(LOG_DIR, `${date}.log`);

  // Close the old stream with a footer that names the next file
  if (_currentStream) {
    try {
      _currentStream.write(
        `\n=== Logging ended ${_stampPT()} — continuing in ${date}.log ===\n`,
      );
      _currentStream.end();
    } catch { /* ignore — process may be exiting */ }
  }

  // Check whether the file already exists (server restart mid-day)
  let existingBytes = 0;
  try { existingBytes = fs.statSync(nextFile).size; } catch { /* new file */ }

  _currentDate   = date;
  _currentStream = fs.createWriteStream(nextFile, { flags: 'a' });

  const header = existingBytes === 0
    ? `=== Log file created ${_stampPT()} ===\n`
    : `\n=== Session resumed ${_stampPT()} (server restart) ===\n`;

  _currentStream.write(header);
  return _currentStream;
}

// ─── Write helper ─────────────────────────────────────────────────────────────
function _write(level, args) {
  const message = args.map(_serialize).join(' ');
  const line    = `[${_stampPT()}] [${level}] ${message}\n`;
  try {
    _getStream().write(line);
  } catch { /* never let logger crash the app */ }
}

// ─── Override console.* globally ─────────────────────────────────────────────
// Preserve the originals so PM2 / Docker still receives unmodified output.
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log = (...args) => {
  _write('INFO',  args);
  _origLog(...args);
};

console.warn = (...args) => {
  _write('WARN',  args);
  _origWarn(...args);
};

console.error = (...args) => {
  _write('ERROR', args);
  _origError(...args);
};

// ─── Write a final line on clean exit ────────────────────────────────────────
process.on('exit', () => {
  try {
    if (_currentStream) {
      _currentStream.write(`=== Process exiting ${_stampPT()} ===\n`);
      _currentStream.end();
    }
  } catch { /* ignore */ }
});

// ─── Exported helpers (optional direct use) ──────────────────────────────────
module.exports = {
  log:   (...args) => { _write('INFO',  args); _origLog(...args);   },
  warn:  (...args) => { _write('WARN',  args); _origWarn(...args);  },
  error: (...args) => { _write('ERROR', args); _origError(...args); },
};
