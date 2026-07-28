const { chromium } = require('playwright');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const proxyHealth  = require('./proxyHealthService');

// ─── Friendly error messages ──────────────────────────────────────────────────
// Converts raw technical errors into driver-readable messages.
function sanitizeError(msg = '') {
  const m = msg.toLowerCase();
  if (m.includes('executable') || m.includes('chromium') || m.includes('browser') || m.includes('playwright'))
    return 'Bot temporarily unavailable — please try again shortly';
  if (m.includes('timeout') || m.includes('timed out'))
    return 'The SAN website took too long to respond — please try again';
  if (m.includes('net::err') || m.includes('name not resolved') || m.includes('connection refused') || m.includes('econnrefused'))
    return 'Could not reach the SAN website — please try again';
  if (m.includes('invalid') || m.includes('incorrect') || m.includes('wrong') || m.includes('credentials'))
    return 'Invalid SAN eDispatch username or password — check your credentials';
  if (m.includes('not found'))
    return 'Vehicle number not found in SAN eDispatch';
  if (m.includes('navigation') || m.includes('page crashed'))
    return 'The SAN website is currently unavailable — please try again later';
  return 'Something went wrong — please try again or contact support';
}

// ─── Proxy rotation ───────────────────────────────────────────────────────────
// Returns a Playwright-compatible proxy config with a fresh session ID, or null
// when proxy use is disabled (env kill switch, PROXY_SERVER unset, or the
// circuit breaker tripped). Callers treat null as "use direct connection."
//
// Supported provider username formats:
//   Bright Data:  brd-customer-XXXX-zone-residential-session-{session}
//   Oxylabs:      customer-XXXX-sessid-{session}
//   Smartproxy:   user-XXXX-sessionid-{session}
//
// Set PROXY_USERNAME with {session} where the random ID should be inserted.
// Each addToQueue() call gets a unique session → a different residential IP.
function getProxyConfig() {
  if (!proxyHealth.shouldUseProxy()) return null;
  const sessionId = crypto.randomBytes(8).toString('hex');
  const username  = (process.env.PROXY_USERNAME || '').replace('{session}', sessionId);
  return { server: process.env.PROXY_SERVER, username, password: process.env.PROXY_PASSWORD || '' };
}

const DEBUG_DIR = process.env.BOT_DEBUG_DIR ?? '/tmp/san-bot-debug';
fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function debugCapture(page, vehicleNumber, label) {
  const ts   = Date.now();
  const slug = `${vehicleNumber}_${label}_${ts}`;
  const img  = path.join(DEBUG_DIR, `${slug}.png`);
  const txt  = path.join(DEBUG_DIR, `${slug}.txt`);
  try {
    await page.screenshot({ path: img, fullPage: true });
    const body = await page.textContent('body').catch(() => '(no body)');
    const content = `URL: ${page.url()}\n\n${body}`;
    fs.writeFileSync(txt, content, 'utf8');
    console.log(`[Bot:debug] ${vehicleNumber} — ${label}\n  screenshot: ${img}\n  text:       ${txt}\n  url:        ${page.url()}\n  body(200):  ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    console.warn(`[Bot:debug] capture failed (${label}): ${e.message}`);
  }
}

// Entry point — redirects to OIDC login, then back to the app after auth
const SAN_URL     = 'https://san.gtcvms.com/gsidispatch.edispatch';
const OIDC_HOST   = 'san.gtcvms.com/GsiIdentityServer';
const APP_HOST    = 'san.gtcvms.com/gsidispatch.edispatch';
const TIMEOUT     = 60000;   // 60s — OIDC handshake + SPA hydration can be slow
const NAV_TIMEOUT = 60000;   // Extra time for full page-navigation round-trips

// ─── SAN response text constants ─────────────────────────────────────────────
// Every literal string we look for in SAN's HTML lives here so updates (when
// SAN tweaks their UI) are a single-file edit instead of a grep-through-bot-code
// hunt. Add new strings here when debug captures reveal a state we don't
// currently recognize. Each entry includes the date and context of discovery
// so future maintainers know why we care about it.
const SAN_TEXT = {
  ADD_TO_QUEUE_BUTTON:    'Add To Queue',
  REMOVE_FROM_QUEUE:      'Remove From Queue',
  VEHICLE_NOT_FOUND:      'not found',
  NO_VEHICLE:             'No vehicle',
  NO_RESULTS:             'No results',
  INVALID_CREDENTIALS:    'Invalid username or password',
  // Discovered 2026-05-29 from debug captures for #142 and #700 morning
  // failures. SAN renders this within ~1s as a business-rule rejection. Until
  // it was added to the search-result matcher the bot waited 60s for a
  // string that would never appear, surfacing as "SAN took too long".
  VEHICLE_NOT_AVAILABLE:  'Vehicle not available for registration',
};

// Driver-facing copy for each non-success bot outcome. Kept here so the
// product/support team can edit messaging without touching control flow.
const DRIVER_ERROR_COPY = {
  VEHICLE_NOT_AVAILABLE: 'SAN says this vehicle is not currently eligible to join the queue — try again in a few minutes.',
  VEHICLE_NOT_FOUND:     'Vehicle number not found in SAN eDispatch',
};

// Strings that signal "the search step completed" — any of them appearing
// terminates the post-search waitForFunction. Order doesn't matter; we just
// need to stop waiting as soon as SAN tells us anything actionable.
const SEARCH_RESULT_STRINGS = [
  SAN_TEXT.ADD_TO_QUEUE_BUTTON,
  SAN_TEXT.REMOVE_FROM_QUEUE,
  SAN_TEXT.VEHICLE_NOT_FOUND,
  SAN_TEXT.NO_VEHICLE,
  SAN_TEXT.NO_RESULTS,
  SAN_TEXT.VEHICLE_NOT_AVAILABLE,
];

// ─── SAN error surfacing ─────────────────────────────────────────────────────
// Whenever the bot fails OR times out, we attempt to read whatever error
// message SAN actually rendered on the page rather than reporting a generic
// "SAN took too long". Three layers:
//
//   1. DOM selectors targeting common SAN error containers — fastest, most
//      reliable when SAN uses these conventions.
//   2. Substring/regex match against visible body text — catches free-form
//      error copy SAN renders inline.
//   3. Fallback: return null and let the caller's sanitizeError() take over.
//
// New patterns can be added without touching call sites — just append to
// KNOWN_SAN_ERROR_PATTERNS and they'll be picked up everywhere.

// Common containers Microsoft/Bootstrap-style ASP.NET sites use for errors.
// Empty matches are skipped silently.
const SAN_ERROR_SELECTORS = [
  '.validation-summary-errors',
  '.field-validation-error',
  '.alert-danger',
  '.alert-error',
  '.error-message',
  '[role="alert"]',
];

// Free-form text patterns we've observed SAN render at the body level (i.e.
// not inside one of the above containers). Strings match case-sensitively as
// SAN renders them; RegExp instances support broader matching. Anything we
// see in debug captures should land here so the next encounter surfaces a
// clean message.
const KNOWN_SAN_ERROR_PATTERNS = [
  SAN_TEXT.VEHICLE_NOT_AVAILABLE,
  SAN_TEXT.INVALID_CREDENTIALS,
  /Vehicle [\w\s]+? is not (?:eligible|authorized|available)/i,
  /Permit (?:expired|invalid|not found)/i,
  /Insurance (?:expired|invalid|not found)/i,
  /(?:Account|Driver) (?:locked|suspended|deactivated)/i,
  /You are not authorized/i,
];

// ─── Generic error catch-all ─────────────────────────────────────────────────
// When KNOWN_SAN_ERROR_PATTERNS doesn't match anything, we fall back to a
// keyword sniff so an unknown error still surfaces the actual text rather
// than disappearing into "SAN took too long". False positives are rare
// because (a) we skip lines that look like JS/CSS source and (b) we require
// at least one error-suggestive keyword.
const GENERIC_ERROR_KEYWORDS = /\b(error|invalid|denied|unauthorized|expired|locked|suspended|deactivated|disabled|blocked|forbidden|unable to|cannot|could not|failed|missing required|please contact|try again later|not eligible|not available|not allowed|not permitted)\b/i;

// Heuristic for "this line is page source, not human-readable text" — keeps
// us from surfacing inline JavaScript / CSS / template variables as errors.
const LOOKS_LIKE_CODE = /[{};=<>]|function\s|var\s|const\s|let\s|if\s*\(/;

const MIN_ERROR_LINE_LEN = 3;
const MAX_ERROR_LINE_LEN = 250;

/**
 * Pure: scan body text for any known SAN error pattern. Returns the matched
 * string (verbatim from the page so users see what SAN actually said) or null.
 * Exported via `_extractKnownErrorFromText` for unit testing without Playwright.
 */
function extractKnownErrorFromText(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return null;
  for (const pattern of KNOWN_SAN_ERROR_PATTERNS) {
    if (typeof pattern === 'string') {
      if (bodyText.includes(pattern)) return pattern;
    } else {
      const m = bodyText.match(pattern);
      if (m && m[0]) return m[0].trim();
    }
  }
  return null;
}

/**
 * Pure: generic catch-all — when we have no specific pattern for the error,
 * scan body lines and surface the first one that LOOKS like a human-readable
 * error message. The result lets admins see *something* from SAN rather than
 * a generic "took too long", even for error states we haven't catalogued.
 *
 * Heuristic:
 *   • Skip empty / very long / very short lines (likely script noise).
 *   • Skip lines matching LOOKS_LIKE_CODE (inline JS/CSS/templates).
 *   • Accept the first line containing a GENERIC_ERROR_KEYWORDS hit.
 *
 * Exported via `_extractGenericErrorFromText` for unit testing.
 */
function extractGenericErrorFromText(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return null;

  const lines = bodyText.split(/[\r\n]+/);
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < MIN_ERROR_LINE_LEN || line.length > MAX_ERROR_LINE_LEN) continue;
    if (LOOKS_LIKE_CODE.test(line)) continue;
    if (GENERIC_ERROR_KEYWORDS.test(line)) return line;
  }
  return null;
}

/**
 * Async: read whatever error SAN rendered on the page. Three layers, in
 * priority order:
 *
 *   1. Structured DOM containers (.validation-summary-errors, [role="alert"],
 *      etc.) — fastest, most precise when SAN uses these conventions.
 *   2. Known body-text patterns (the curated KNOWN_SAN_ERROR_PATTERNS list)
 *      — handles SAN's free-form errors we've already catalogued.
 *   3. Generic keyword sniff — catches NEW / uncatalogued errors so the
 *      driver never sees "SAN took too long" when SAN actually said something.
 *
 * Returns the first useful match, or null when even the generic sniff finds
 * nothing — at which point sanitizeError(err.message) is the last resort.
 *
 * Each selector lookup is bounded at 300ms so a degraded page doesn't add
 * seconds to the failure path; missing a slow-rendering error is preferable
 * to delaying the response further.
 */
async function extractSanErrorMessage(page) {
  if (!page) return null;

  // Layer 1: Structured error containers
  for (const sel of SAN_ERROR_SELECTORS) {
    try {
      const loc  = page.locator(sel).first();
      const text = await loc.innerText({ timeout: 300 });
      const cleaned = (text || '').trim();
      if (cleaned) return cleaned;
    } catch { /* selector missing / not visible — try the next one */ }
  }

  // Layers 2 & 3: read the body once, then run both extractors
  const body = await page.textContent('body').catch(() => '');
  return extractKnownErrorFromText(body) || extractGenericErrorFromText(body);
}

// ─── Failure classifier ──────────────────────────────────────────────────────
// debugCapture uses this label as the filename suffix so admins can grep the
// debug dir for specific failure modes without opening every PNG:
//   *_goto_timeout_*    → SAN didn't answer initial navigation (proxy/network)
//   *_login_timeout_*   → On OIDC login page, neither redirect nor matched
//                         error text within NAV_TIMEOUT (e.g., the
//                         email-as-username case for #4007 on 2026-05-26)
//   *_oidc_timeout_*    → Credentials were filled, OIDC callback never came back
//   *_search_timeout_*  → On the app, vehicle search / add-to-queue step hung
//   *_timeout           → Catch-all for timeouts whose URL doesn't classify
//   *_error             → Non-timeout failures
//
// Pure function — exported for tests. urlAtError is whatever page.url()
// returned at the moment of failure (or '' if the page was already closed).
function classifyFailure({ urlAtError = '', errorMessage = '' } = {}) {
  const isTimeout = /timeout|timed out|aborted due to timeout/i.test(errorMessage);
  if (!isTimeout) return 'error';
  if (!urlAtError || urlAtError === 'about:blank') return 'goto_timeout';
  if (urlAtError.includes('/Account/Login'))       return 'login_timeout';
  // signin-oidc is the redirect URL SAN posts the auth code back to — if we're
  // stuck here, the OIDC callback didn't complete after a successful login.
  if (urlAtError.includes('signin-oidc'))          return 'oidc_timeout';
  if (urlAtError.includes(OIDC_HOST))              return 'login_timeout';
  if (urlAtError.includes(APP_HOST))               return 'search_timeout';
  return 'timeout';
}

// ─── Session store ────────────────────────────────────────────────────────────
// In-memory cache of Playwright storage states (cookies + localStorage) keyed by
// SAN username. Lets subsequent runs skip the full OIDC login (~15 s saved).
//
// Lifecycle:
//   • Populated on every successful login — overwritten on every successful run.
//   • Evicted automatically after SESSION_TTL_MS (proactive expiry).
//   • Cleared immediately if SAN rejects the restored session (reactive expiry).
//   • Persisted to disk (atomic write) so a restart doesn't trigger the morning
//     login storm — see SESSION_PERSIST_PATH below.
//
// IdentityServer (the OIDC provider used by SAN) does not bind sessions to IP,
// so sessions remain valid across rotating residential proxy IPs.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const sessionStore   = new Map();            // sanUsername → { storageState, savedAt }

// ─── Disk persistence ─────────────────────────────────────────────────────────
// Mirrors the bot-latency-samples persistence pattern in monitorService:
// atomic write-to-temp + rename, throttled to one disk write per ~5 s so a
// burst of bot completions doesn't hammer the disk. Survives restarts so the
// 5 AM cold-start doesn't pay the OIDC login tax for every active driver.
const SESSION_PERSIST_PATH = process.env.BOT_SESSION_PERSIST_PATH
  ?? path.join(process.cwd(), 'data', 'bot-sessions.json');
const SESSION_PERSIST_THROTTLE_MS = 5000;
let sessionPersistTimer = null;

function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSION_PERSIST_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SESSION_PERSIST_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    let restored = 0;
    let skipped  = 0;
    for (const [username, entry] of Object.entries(raw)) {
      if (!entry?.storageState || !Number.isFinite(entry.savedAt)) continue;
      if (Date.now() - entry.savedAt > SESSION_TTL_MS) { skipped++; continue; }
      sessionStore.set(username, entry);
      restored++;
    }
    if (restored || skipped) {
      console.log(`[Bot:session] Restored ${restored} session(s) from disk` +
                  (skipped ? ` (${skipped} expired, skipped)` : ''));
    }
  } catch (err) {
    console.warn(`[Bot:session] Could not load sessions from disk (${err.message}) — starting fresh`);
  }
}

function schedulePersistSessions() {
  if (sessionPersistTimer) return; // already pending
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    const tmp = `${SESSION_PERSIST_PATH}.tmp`;
    try {
      fs.mkdirSync(path.dirname(SESSION_PERSIST_PATH), { recursive: true });
      const payload = Object.fromEntries(sessionStore);
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, SESSION_PERSIST_PATH); // atomic on POSIX
    } catch (err) {
      console.warn(`[Bot:session] Could not persist sessions: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }, SESSION_PERSIST_THROTTLE_MS).unref();
}

function getStoredSession(username) {
  const entry = sessionStore.get(username);
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt > SESSION_TTL_MS) {
    sessionStore.delete(username);
    schedulePersistSessions();
    console.log(`[Bot:session] Evicted stale session for ${username}`);
    return undefined;
  }
  return entry.storageState;
}

function saveSession(username, storageState) {
  sessionStore.set(username, { storageState, savedAt: Date.now() });
  schedulePersistSessions();
}

function forgetSession(username) {
  if (sessionStore.delete(username)) schedulePersistSessions();
}

// Eagerly load on module import so the first bot run already has data.
loadSessionsFromDisk();

/**
 * Automates the full SAN eDispatch queue process for one driver.
 *
 * Flow (first run / session expired):
 *  1. Navigate to eDispatch → OIDC redirects to identity server login page
 *  2. Fill username + password, click Log In → OIDC callback → back on app
 *  3. Save storage state (cookies) for future runs
 *  4–9. Search, add to queue, read position
 *
 * Flow (session cached, < 4 hours old):
 *  1. Navigate to eDispatch with restored cookies → lands on app directly
 *  2. (login skipped — ~15 s saved)
 *  3. Refresh storage state
 *  4–9. Search, add to queue, read position
 */
async function addToQueue(sanUsername, sanPassword, vehicleNumber) {
  const startTime = Date.now();
  let browser = null;
  let page    = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const proxyConfig  = getProxyConfig();
    const savedSession = getStoredSession(sanUsername);

    if (proxyConfig) {
      console.log(`[Bot] ${vehicleNumber} → Using proxy session ${proxyConfig.username.split('-session-')[1] ?? '?'}`);
    }
    if (savedSession) {
      console.log(`[Bot] ${vehicleNumber} → Restoring saved session for ${sanUsername}`);
    }

    const context = await browser.newContext({
      // Mobile UA matches what the site expects (optimised for mobile)
      userAgent:    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      viewport:     { width: 390, height: 844 },
      permissions:     [],
      acceptDownloads: false,
      storageState:    savedSession,   // undefined = fresh context; object = restored session
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });

    page = await context.newPage();

    // Block fonts, images, media and stylesheets — the bot only needs page logic,
    // not visual rendering. This cuts proxy bandwidth by ~60-70%.
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    // ─── STEP 1: Navigate ─────────────────────────────────────────────────────
    // With a valid saved session the app loads directly (no OIDC redirect).
    // Without one (first run or expired) SAN redirects to the identity server.
    // We wait for whichever destination appears first.
    console.log(`[Bot] ${vehicleNumber} → Navigating to SAN eDispatch…`);
    await page.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await page.waitForURL(
      url => url.href.includes(OIDC_HOST) || url.href.includes(APP_HOST),
      { timeout: TIMEOUT },
    );

    // ─── STEP 2: Login only when OIDC redirected us ───────────────────────────
    if (page.url().includes(OIDC_HOST)) {
      if (savedSession) {
        // SAN rejected the restored cookies — clear the bad entry so the next
        // run doesn't waste time trying the same stale session again.
        forgetSession(sanUsername);
        console.log(`[Bot] ${vehicleNumber} → Saved session rejected by SAN — falling back to full login`);
      } else {
        console.log(`[Bot] ${vehicleNumber} → Redirected to OIDC login: ${page.url()}`);
      }

      await page.waitForSelector('input[placeholder="Enter Username"]', { timeout: TIMEOUT });
      console.log(`[Bot] ${vehicleNumber} → Filling credentials for ${sanUsername}…`);
      await page.fill('input[placeholder="Enter Username"]', sanUsername);
      await page.fill('input[placeholder="Enter Password"]', sanPassword);

      // Click Log In, then race the OIDC redirect against the "Invalid
      // username or password" error appearing on the same page. Without this
      // race, a credentials failure makes us wait the full NAV_TIMEOUT (60 s)
      // for a redirect that will never happen — and the resulting Playwright
      // timeout gets reported to the driver as "SAN took too long," sending
      // them to the wrong fix. Detecting the error text early lets us throw
      // with the correct message and lets the scheduler trip a day-scoped
      // breaker instead of retrying for hours.
      await page.click('button:has-text("Log In")');

      const winner = await Promise.race([
        page.waitForURL(`**/${APP_HOST}/**`, { timeout: NAV_TIMEOUT }).then(() => 'redirected'),
        page.locator('text=/Invalid username or password/i').first()
          .waitFor({ state: 'visible', timeout: NAV_TIMEOUT })
          .then(() => 'invalid_credentials'),
      ]).catch((err) => { throw err; });

      if (winner === 'invalid_credentials') {
        // Capture so admin can audit what SAN actually showed
        await debugCapture(page, vehicleNumber, 'invalid_credentials').catch(() => {});
        // The literal substring "Invalid SAN" is what sanitizeError matches
        // and what schedulerService.isTransientError keys off — keep it.
        throw new Error('Invalid SAN eDispatch username or password — check your credentials');
      }

      console.log(`[Bot] ${vehicleNumber} → OIDC callback complete — back on eDispatch.`);
    } else {
      console.log(`[Bot] ${vehicleNumber} → Session valid — skipped OIDC login.`);
    }

    // ─── STEP 3: Persist / refresh the session ───────────────────────────────
    // Always snapshot current cookies after reaching the app so the next run
    // can reuse them. Overwrites any previous entry for this username.
    const storageState = await context.storageState();
    saveSession(sanUsername, storageState);

    // Let the SPA fully hydrate before querying the DOM
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});

    // Debug: capture what the page looks like right after auth
    await debugCapture(page, vehicleNumber, 'after_login');

    // ─── STEP 4: Check for wrong-credentials error ────────────────────────────
    // If we're still on the identity server after the login attempt, auth failed.
    if (page.url().includes(OIDC_HOST)) {
      const errorText = await page.textContent('body').catch(() => '');
      const hint = errorText.includes('Invalid') || errorText.includes('incorrect')
        ? 'Invalid SAN username or password'
        : 'Login failed — check credentials';
      return { success: false, durationMs: Date.now() - startTime, error: hint, message: hint };
    }

    // ─── STEP 5: Wait for either the search page OR the WAIT screen ─────────────
    // When already queued, SAN skips the search page and shows the WAIT screen directly.
    // When dispatched to a terminal, SAN shows a /status page — detect and bail early.
    await page.waitForFunction(
      () => {
        const hasSearch    = document.querySelector('input[placeholder="Vehicle Dispatch Name"]') !== null;
        const onWaitScreen = document.body.innerText.includes('Remove From Queue');
        const onDispatch   = document.body.innerText.includes('Dispatched: T');
        return hasSearch || onWaitScreen || onDispatch;
      },
      null,
      { timeout: TIMEOUT }
    );

    // If SAN shows the driver is dispatched to a terminal, we cannot re-queue yet
    const isDispatched = await page.evaluate(() =>
      document.body.innerText.includes('Dispatched: T')
    ).catch(() => false);
    if (isDispatched) {
      const bodyText = await page.textContent('body').catch(() => '');
      const termMatch = bodyText.match(/Dispatched:\s*(T\d+)/i);
      const terminal = termMatch ? termMatch[1] : 'terminal';
      console.log(`[Bot] ${vehicleNumber} → Dispatched to ${terminal} — cannot re-queue yet.`);
      return {
        success: false,
        dispatched: true,
        durationMs: Date.now() - startTime,
        error: `Vehicle dispatched to ${terminal} — cannot re-queue while at terminal`,
        message: `Vehicle ${vehicleNumber} is currently dispatched to ${terminal}`,
      };
    }

    // If we landed on the WAIT screen directly → already queued
    if (await isWaitScreen(page)) {
      const info = await extractQueueInfo(page);
      console.log(`[Bot] ${vehicleNumber} → Already in queue (landed on WAIT screen directly).`);
      return { success: true, alreadyQueued: true, ...info, durationMs: Date.now() - startTime,
               message: `Vehicle already in queue at position ${info.position}` };
    }

    console.log(`[Bot] ${vehicleNumber} → On vehicle search page.`);

    // ─── STEP 6: Search by vehicle number ────────────────────────────────────
    // The field placeholder says "Vehicle Dispatch Name" but the actual value
    // entered is the numeric vehicle number (e.g. "4000")
    console.log(`[Bot] ${vehicleNumber} → Searching for vehicle ${vehicleNumber}…`);
    await page.fill('input[placeholder="Vehicle Dispatch Name"]', String(vehicleNumber));
    await page.click('button:has-text("Search")');

    // Wait for any of the known search-result strings (see SEARCH_RESULT_STRINGS
    // at the top of this file). Adding a new SAN response state means adding
    // one entry there — no change to this call.
    await page.waitForFunction(
      (needles) => needles.some((s) => document.body.innerText.includes(s)),
      SEARCH_RESULT_STRINGS,
      { timeout: TIMEOUT },
    );

    // ─── STEP 6.5: Detect SAN business-rule rejections ────────────────────────
    // Read the body once and dispatch on what SAN said. Cheaper than three
    // separate isVisible calls and surfaces a clear driver-facing error
    // instead of a misleading "vehicle not found" or "SAN took too long".
    const bodyText = await page.textContent('body').catch(() => '');

    if (bodyText.includes(SAN_TEXT.VEHICLE_NOT_AVAILABLE)) {
      console.log(`[Bot] ${vehicleNumber} → ${SAN_TEXT.VEHICLE_NOT_AVAILABLE} (SAN business-rule rejection)`);
      return {
        success:               false,
        vehicleNotAvailable:   true, // signal for callers — short cooldown, not a creds problem
        durationMs:            Date.now() - startTime,
        error:                 DRIVER_ERROR_COPY.VEHICLE_NOT_AVAILABLE,
        message:               DRIVER_ERROR_COPY.VEHICLE_NOT_AVAILABLE,
      };
    }

    // ─── STEP 7: Already queued after search? ────────────────────────────────
    if (await isWaitScreen(page)) {
      const info = await extractQueueInfo(page);
      return { success: true, alreadyQueued: true, ...info, durationMs: Date.now() - startTime,
               message: `Vehicle already in queue at position ${info.position}` };
    }

    // ─── STEP 8: Confirm vehicle was found ───────────────────────────────────
    const addToQueueVisible = await page.isVisible(`button:has-text("${SAN_TEXT.ADD_TO_QUEUE_BUTTON}")`).catch(() => false);
    if (!addToQueueVisible) {
      return {
        success:    false,
        durationMs: Date.now() - startTime,
        error:      `Vehicle "${vehicleNumber}" not found — check vehicle number`,
        message:    DRIVER_ERROR_COPY.VEHICLE_NOT_FOUND,
      };
    }

    // ─── STEP 9: Click Add To Queue ───────────────────────────────────────────
    console.log(`[Bot] ${vehicleNumber} → Clicking Add To Queue…`);
    await page.click('button:has-text("Add To Queue")');

    // Wait for WAIT confirmation screen — "Remove From Queue" is unique to this screen
    await page.waitForFunction(
      () => document.body.innerText.includes('Remove From Queue'),
      null,
      { timeout: TIMEOUT }
    );
    console.log(`[Bot] ${vehicleNumber} → ✓ Successfully added to queue!`);

    // ─── STEP 10: Extract queue details ──────────────────────────────────────
    const info = await extractQueueInfo(page);
    return {
      success: true,
      alreadyQueued: false,
      ...info,
      durationMs: Date.now() - startTime,
      message: `Added to queue — Position: ${info.position}, Location: ${info.location}`
    };

  } catch (err) {
    console.error(`[Bot] ${vehicleNumber} → ERROR: ${err.message}`);
    // Classify the failure so the debug screenshot's filename tells us at a
    // glance WHERE the bot got stuck — login page, post-OIDC callback, add to
    // queue, etc. Without this, every failure dumps as "*_error" and admins
    // have to open each PNG to find the one they're investigating.
    let urlAtError = '';
    try { urlAtError = page ? page.url() : ''; } catch { /* page closed */ }
    const failureLabel = classifyFailure({ urlAtError, errorMessage: err.message });
    if (page) await debugCapture(page, vehicleNumber, failureLabel);

    // Verify-on-timeout: SAN can be slow enough that our Playwright waitFor*
    // exceeds its 60 s limit AFTER the add-to-queue request actually went
    // through. Before reporting "took too long" to the driver, do a single
    // V Holding fetch and check whether the vehicle is in fact in the queue.
    // If it is, downgrade the failure to a success — same outcome the driver
    // would see in SAN's own UI, just observed via a different page.
    const looksLikeTimeout = /timeout|timed out|aborted due to timeout/i.test(err.message || '');
    if (looksLikeTimeout) {
      const verified = await verifyDriverInQueue(vehicleNumber).catch(() => null);
      if (verified && Number.isFinite(verified.position)) {
        console.log(`[Bot] ${vehicleNumber} → Timeout but driver IS in queue at #${verified.position} — treating as success`);
        return {
          success:       true,
          alreadyQueued: true,    // we didn't observe the add directly
          position:      verified.position,
          location:      verified.location ?? 'V Holding',
          queueTime:     null,    // not available from V Holding parse
          durationMs:    Date.now() - startTime,
          message:       `Added to queue — Position: ${verified.position}`,
          recoveredFromTimeout: true,
        };
      }
    }

    // Try to surface whatever SAN actually showed on the page. If we find a
    // visible error message we prefer it over the generic sanitizeError
    // copy — drivers (and admins reading logs) get to see exactly what SAN
    // said instead of a hand-wavy "took too long".
    const sanErrorText = await extractSanErrorMessage(page).catch(() => null);
    if (sanErrorText) {
      console.warn(`[Bot] ${vehicleNumber} → SAN said: "${sanErrorText}"`);
    }
    const friendly  = sanitizeError(err.message);
    const userError = sanErrorText ? `SAN: ${sanErrorText}` : friendly;
    return {
      success:      false,
      durationMs:   Date.now() - startTime,
      error:        userError,
      message:      userError,
      rawError:     err.message,    // Playwright/native error, server logs only
      sanErrorText: sanErrorText,   // raw page-visible text; null if none found
    };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── Lightweight V Holding verifier ──────────────────────────────────────────
// Used by the catch handler above. We import lazily to avoid a circular
// dependency (botService ← monitorService for the parseQueue helper).
// One snapshot fetch serves any number of vehicle lookups — the fire-visibility
// poller below checks every in-flight fire against a single fetch per tick.
async function fetchQueueSnapshot() {
  const { fetch: ufetch } = require('undici');
  const { _parseQueue } = require('./monitorService');
  const QUEUE_URL = process.env.MONITOR_QUEUE_URL
    ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-17';
  const res  = await ufetch(QUEUE_URL, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return _parseQueue(await res.text()); // { waiting, dispatched } maps
}

async function verifyDriverInQueue(vehicleNumber) {
  const snap = await fetchQueueSnapshot();
  if (!snap) return null;
  const { _norm } = require('./monitorService');
  const vn = _norm(vehicleNumber);
  if (snap.waiting.has(vn))    return { position: snap.waiting.get(vn),    location: 'V Holding' };
  if (snap.dispatched.has(vn)) return { position: snap.dispatched.get(vn), location: 'Dispatched' };
  return null;
}

/**
 * Post-fire landing verification: polls the authoritative V Holding list a few
 * times, because a confirmation TIMEOUT is not a failed add — the Blazor add is
 * a fire-and-forget SignalR event that SAN commits when its server processes
 * the click; the WAIT screen streaming back is the slow part (2026-07-06: all
 * 17 "timed out" storm fires were already in the queue). The parked armed page
 * proved the driver was NOT queued at arm time, so presence here is OUR add —
 * the same justification the HTTP-fire path uses — which makes the returned
 * position a genuine landing, safe for position tracking and the fleet probe.
 */
async function verifyAddLanded(vehicleNumber, attempts = ARM_VERIFY_ATTEMPTS) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, ARM_VERIFY_PAUSE_MS));
    const info = await verifyDriverInQueue(vehicleNumber).catch(() => null);
    if (info && Number.isFinite(info.position)) return info;
  }
  return null;
}

// ─── Fire-visibility watch (live SAN-backlog signal + early landings) ─────────
// SAN stamps a fire's position when its server PROCESSES the click, but the
// WAIT-screen confirmation streams back much later under storm load (07-12/…/
// 07-18: 12–33 s while the queue moved 30–60). Two consequences this watch
// exploits, at the cost of one extra spacezone fetch per ~1.25 s while fires
// are in flight:
//
//  1. BACKLOG SIGNAL — a fired vehicle that is not yet VISIBLE in V Holding has
//     not been processed (visibility = processed + ≤5 s render + poll). The age
//     of the oldest such fire, times the display slope, estimates how many
//     positions of already-committed adds sit in SAN's pipe ahead of a click
//     made right now — the quantity that landed 07-15…07-18 fires +20…+59 past
//     target. monitorService reads it via oldestUnseenFireAgeMs() to open the
//     onset early-fire cap ONLY when a deep backlog is proven (see
//     MONITOR_ONSET_CAP_MAX). Crucially this stays near zero when confirm
//     latency is mere stream-back lag (07-19: 12 s confirms, backlog ~14 —
//     fires were visible within ~3 s), the case that must NOT deepen the cap.
//
//  2. EARLY LANDINGS — the position seen in V Holding is the landing, available
//     ~5–10 s before the WAIT-screen confirm mid-storm. It feeds the fleet
//     probe (recordFleetLanding via the listener) that much sooner.
//
// Entries live from click dispatch until fireClaimedSession reaches a verdict
// (confirm, vehicle_not_available, verify-recovery, or cold fallback) — exactly
// the in-flight window. FIRE_VIS_START_MS keeps the calm case free (a ~1.5 s
// confirm resolves before the first poll would even count it).
const FIRE_VIS_POLL_MS    = parseInt(process.env.BOT_FIRE_VIS_POLL_MS    ?? '1250', 10);
const FIRE_VIS_START_MS   = parseInt(process.env.BOT_FIRE_VIS_START_MS   ?? '2000', 10);
const FIRE_VIS_TIMEOUT_MS = parseInt(process.env.BOT_FIRE_VIS_TIMEOUT_MS ?? '60000', 10);

const pendingFireVis = new Map(); // vehicleNumber → { clickAtMs, seenAtMs }
let fireVisTimer     = null;
let fireVisListener  = null;      // ({ vehicleNumber, position }) — set by monitorService
let fetchSnapshotFn  = fetchQueueSnapshot; // injectable for tests

function setFireVisibilityListener(fn) { fireVisListener = fn; }

function beginFireVisibility(vehicleNumber, nowMs = Date.now()) {
  pendingFireVis.set(String(vehicleNumber), { clickAtMs: nowMs, seenAtMs: null });
  scheduleFireVisPoll();
}

function resolveFireVisibility(vehicleNumber) {
  pendingFireVis.delete(String(vehicleNumber));
  if (pendingFireVis.size === 0 && fireVisTimer) {
    clearTimeout(fireVisTimer);
    fireVisTimer = null;
  }
}

/** Age (ms) of the oldest in-flight fire not yet visible in V Holding — 0 when
 *  everything recent is processed. The monitor's backlog boost input. */
function oldestUnseenFireAgeMs(nowMs = Date.now()) {
  let oldest = 0;
  for (const rec of pendingFireVis.values()) {
    if (rec.seenAtMs) continue;
    const age = nowMs - rec.clickAtMs;
    if (age >= FIRE_VIS_START_MS && age <= FIRE_VIS_TIMEOUT_MS) oldest = Math.max(oldest, age);
  }
  return oldest;
}

function scheduleFireVisPoll() {
  if (fireVisTimer || pendingFireVis.size === 0) return;
  fireVisTimer = setTimeout(async () => {
    fireVisTimer = null;
    try { await fireVisPollOnce(); } catch { /* next tick retries */ }
    scheduleFireVisPoll();
  }, FIRE_VIS_POLL_MS);
  fireVisTimer.unref?.();
}

async function fireVisPollOnce(nowMs = Date.now()) {
  // Prune abandoned entries (verdict never resolved them — crash paths).
  for (const [veh, rec] of pendingFireVis) {
    if (nowMs - rec.clickAtMs > FIRE_VIS_TIMEOUT_MS) pendingFireVis.delete(veh);
  }
  const due = [...pendingFireVis.entries()]
    .filter(([, r]) => !r.seenAtMs && nowMs - r.clickAtMs >= FIRE_VIS_START_MS);
  if (due.length === 0) return;
  const snap = await fetchSnapshotFn().catch(() => null);
  if (!snap) return;
  const { _norm } = require('./monitorService');
  for (const [veh, rec] of due) {
    const pos = snap.waiting.get(_norm(veh));
    if (Number.isFinite(pos)) {
      rec.seenAtMs = nowMs;
      console.log(`[Arm] 👁 #${veh} visible in V Holding at ${pos} ` +
        `(${((nowMs - rec.clickAtMs) / 1000).toFixed(1)}s after click) — early landing signal`);
      try { fireVisListener?.({ vehicleNumber: veh, position: pos }); } catch { /* listener owns its errors */ }
    }
  }
}

/** Returns true if the WAIT confirmation screen is currently visible. */
async function isWaitScreen(page) {
  return page.evaluate(() => {
    const t = document.body.innerText;
    // "Remove From Queue" button is unique to the WAIT confirmation screen
    return t.includes('Remove From Queue');
  }).catch(() => false);
}

/**
 * Extracts Position, Location, and Time from the WAIT screen.
 * The screen text looks like:
 *   "Vehicle: 4000  WAIT  Location  V Holding  Position  401  Time  06:25:34"
 */
async function extractQueueInfo(page) {
  try {
    const bodyText = await page.textContent('body');
    const positionMatch = bodyText.match(/Position\s+(\d+)/i);
    const locationMatch = bodyText.match(/Location\s+([\s\S]+?)(?=\s*Position|\s*Time|\s*Special)/i);
    const timeMatch     = bodyText.match(/Time\s+([\d:]+)/i);
    return {
      position:  positionMatch ? parseInt(positionMatch[1]) : null,
      location:  locationMatch ? locationMatch[1].trim()    : null,
      queueTime: timeMatch     ? timeMatch[1].trim()        : null
    };
  } catch {
    return { position: null, location: null, queueTime: null };
  }
}

/**
 * Removes a driver from the SAN queue. Same login flow as addToQueue, but
 * clicks the "Remove From Queue" button on the WAIT screen instead of adding.
 *
 * Returns:
 *   { success: true, removed: true, durationMs, message }  → removed cleanly
 *   { success: false, notInQueue: true, ... }              → wasn't in queue
 *   { success: false, dispatched: true, ... }              → at terminal, can't remove
 *   { success: false, error, message, ... }                → other failures
 */
async function removeFromQueue(sanUsername, sanPassword, vehicleNumber) {
  const startTime = Date.now();
  let browser = null;
  let page    = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const proxyConfig  = getProxyConfig();
    const savedSession = getStoredSession(sanUsername);

    if (proxyConfig)  console.log(`[Bot] ${vehicleNumber} (remove) → proxy session active`);
    if (savedSession) console.log(`[Bot] ${vehicleNumber} (remove) → restoring saved session for ${sanUsername}`);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      permissions: [],
      acceptDownloads: false,
      storageState: savedSession,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });

    page = await context.newPage();

    // Block heavy resources to keep the bot fast (~60% bandwidth saved)
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    // ─── STEP 1: navigate ────────────────────────────────────────────────────
    console.log(`[Bot] ${vehicleNumber} (remove) → navigating to SAN eDispatch…`);
    await page.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForURL(
      url => url.href.includes(OIDC_HOST) || url.href.includes(APP_HOST),
      { timeout: TIMEOUT },
    );

    // ─── STEP 2: login if redirected to OIDC ─────────────────────────────────
    if (page.url().includes(OIDC_HOST)) {
      if (savedSession) {
        forgetSession(sanUsername);
        console.log(`[Bot] ${vehicleNumber} (remove) → saved session rejected — full login`);
      }
      await page.waitForSelector('input[placeholder="Enter Username"]', { timeout: TIMEOUT });
      await page.fill('input[placeholder="Enter Username"]', sanUsername);
      await page.fill('input[placeholder="Enter Password"]', sanPassword);
      await Promise.all([
        page.waitForURL(`**/${APP_HOST}/**`, { timeout: NAV_TIMEOUT }),
        page.click('button:has-text("Log In")'),
      ]);
      console.log(`[Bot] ${vehicleNumber} (remove) → OIDC callback complete`);
    }

    // Persist refreshed session for next runs
    saveSession(sanUsername, await context.storageState());

    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
    await debugCapture(page, vehicleNumber, 'remove_after_login');

    // ─── STEP 3: verify we're not back at OIDC (auth failed) ─────────────────
    if (page.url().includes(OIDC_HOST)) {
      const hint = 'Invalid SAN username or password';
      return { success: false, durationMs: Date.now() - startTime, error: hint, message: hint };
    }

    // ─── STEP 4: wait for one of: WAIT screen, search page, or dispatched ────
    await page.waitForFunction(
      () => {
        const hasSearch    = document.querySelector('input[placeholder="Vehicle Dispatch Name"]') !== null;
        const onWaitScreen = document.body.innerText.includes('Remove From Queue');
        const onDispatch   = document.body.innerText.includes('Dispatched: T');
        return hasSearch || onWaitScreen || onDispatch;
      },
      null,
      { timeout: TIMEOUT },
    );

    // ─── STEP 5: dispatched → can't remove ───────────────────────────────────
    const isDispatched = await page.evaluate(() =>
      document.body.innerText.includes('Dispatched: T'),
    ).catch(() => false);
    if (isDispatched) {
      const bodyText  = await page.textContent('body').catch(() => '');
      const termMatch = bodyText.match(/Dispatched:\s*(T\d+)/i);
      const terminal  = termMatch ? termMatch[1] : 'terminal';
      console.log(`[Bot] ${vehicleNumber} (remove) → dispatched to ${terminal} — cannot remove`);
      return {
        success: false,
        dispatched: true,
        durationMs: Date.now() - startTime,
        error: `Already dispatched to ${terminal} — cannot remove`,
        message: `You're currently dispatched to ${terminal}. Wait until you clear the terminal, then try again.`,
      };
    }

    // ─── STEP 6: not on the WAIT screen → not in queue, nothing to remove ────
    if (!(await isWaitScreen(page))) {
      console.log(`[Bot] ${vehicleNumber} (remove) → not currently in queue`);
      return {
        success: false,
        notInQueue: true,
        durationMs: Date.now() - startTime,
        error: 'Vehicle is not currently in queue',
        message: 'You are not currently in the queue — nothing to remove.',
      };
    }

    // ─── STEP 7: click Remove From Queue, then VERIFY against V Holding ───────
    // SAN is a Blazor Server app — "Remove From Queue" is a SignalR WebSocket
    // event the server processes asynchronously. The old code trusted a
    // client-side DOM transition ("Remove From Queue" text gone) and then closed
    // the browser, which dropped the WebSocket BEFORE the server committed — so
    // it logged success while the driver stayed in V Holding. We now trust SAN's
    // authoritative V Holding list: click, then poll verifyDriverInQueue until the
    // vehicle is actually gone (re-clicking once if needed), keeping the page —
    // and its WebSocket — open until removal is confirmed.

    // Accept any native confirm() the button might raise — Playwright dismisses
    // dialogs by default, which would silently CANCEL the remove.
    page.on('dialog', (d) => d.accept().catch(() => {}));

    const clickRemoveButton = async () => {
      // STEP A — on the WAIT screen, click "Remove From Queue".
      await page.waitForFunction(
        () => document.body.innerText.includes('Remove From Queue'),
        null, { timeout: 8000 },
      ).catch(() => {});
      await page.click('button:has-text("Remove From Queue")').catch(() => {});

      // STEP B — SAN then shows a CONFIRMATION screen ("Remove vehicle from
      // queue?" → Remove / Cancel) UNLESS the driver ticked "Don't ask this
      // again". The actual removal only happens when the confirm "Remove" is
      // clicked. `:text-is("Remove")` matches the exact-text confirm button, not
      // the "Remove From Queue" button. Without this step the remove never fires
      // and the driver stays queued (the original bug).
      const onConfirm = await page.waitForFunction(
        () => /remove vehicle from queue/i.test(document.body.innerText),
        null, { timeout: 5000 },
      ).then(() => true).catch(() => false);
      if (onConfirm) {
        await page.click('button:text-is("Remove")').catch(() => {});
      }

      // best-effort settle — NOT the source of truth (the V Holding poll is).
      await page.waitForFunction(
        () => document.querySelector('input[placeholder="Vehicle Dispatch Name"]') !== null
           || !/remove from queue|remove vehicle from queue/i.test(document.body.innerText),
        null, { timeout: 3000 },
      ).catch(() => {});
    };

    console.log(`[Bot] ${vehicleNumber} (remove) → clicking Remove From Queue…`);
    await clickRemoveButton();

    // Confirm via SAN's authoritative V Holding list — the only reliable signal.
    const REMOVE_CONFIRM_TRIES = 6;       // ~1.5 s apart ⇒ up to ~9 s of polling
    let confirmedGone = false;
    for (let attempt = 1; attempt <= REMOVE_CONFIRM_TRIES; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const info = await verifyDriverInQueue(vehicleNumber).catch(() => null);
      if (!info || !Number.isFinite(info.position)) { confirmedGone = true; break; }
      if (info.location && /dispatch/i.test(info.location)) {
        console.log(`[Bot] ${vehicleNumber} (remove) → dispatched during remove — cannot remove`);
        return {
          success: false, dispatched: true, durationMs: Date.now() - startTime,
          error: 'Dispatched before removal completed — cannot remove',
          message: 'You were dispatched before the removal completed.',
        };
      }
      // Halfway through, re-issue the remove in case the first WS event was dropped.
      if (attempt === Math.ceil(REMOVE_CONFIRM_TRIES / 2)) {
        console.log(`[Bot] ${vehicleNumber} (remove) → still queued at #${info.position} — re-clicking Remove`);
        await page.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
        await clickRemoveButton();
      }
    }

    if (!confirmedGone) {
      console.warn(`[Bot] ${vehicleNumber} (remove) → ✗ SAN still shows the vehicle queued — remove NOT confirmed`);
      return {
        success: false, removed: false, notConfirmed: true,
        durationMs: Date.now() - startTime,
        error: 'Remove not confirmed — vehicle still in queue',
        message: 'We could not confirm removal — you may still be in the queue. Please try again.',
      };
    }

    console.log(`[Bot] ${vehicleNumber} (remove) → ✓ confirmed removed from V Holding`);
    return {
      success:    true,
      removed:    true,
      durationMs: Date.now() - startTime,
      message:    'Successfully removed from queue.',
    };

  } catch (err) {
    console.error(`[Bot] ${vehicleNumber} (remove) → ERROR: ${err.message}`);
    // Same classifier as addToQueue, prefixed so admins can tell remove-flow
    // captures apart from add-flow ones in the debug dir.
    let urlAtError = '';
    try { urlAtError = page ? page.url() : ''; } catch { /* page closed */ }
    const failureLabel = `remove_${classifyFailure({ urlAtError, errorMessage: err.message })}`;
    if (page) await debugCapture(page, vehicleNumber, failureLabel);

    const sanErrorText = await extractSanErrorMessage(page).catch(() => null);
    if (sanErrorText) {
      console.warn(`[Bot] ${vehicleNumber} (remove) → SAN said: "${sanErrorText}"`);
    }
    const friendly  = sanitizeError(err.message);
    const userError = sanErrorText ? `SAN: ${sanErrorText}` : friendly;
    return {
      success:      false,
      durationMs:   Date.now() - startTime,
      error:        userError,
      message:      userError,
      rawError:     err.message,
      sanErrorText: sanErrorText,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Logs into SAN eDispatch and persists the resulting storageState — without
 * adding the vehicle to the queue. Used by sessionWarmerService to pre-warm
 * sessions BEFORE the morning surge so the real fire bypasses the ~15-25 s
 * OIDC login and runs in ~5 s.
 *
 * The login flow is intentionally a structural subset of addToQueue() — same
 * navigation, same race against the "Invalid credentials" error, same session
 * caching. The only thing missing is the vehicle search + Add-to-Queue click.
 *
 *   Result shape: { success, durationMs, error?, message?, rawError?, reused? }
 *     reused: true  → existing cached session was still valid; no login performed.
 *     reused: false → full OIDC login succeeded; new storageState saved.
 *
 * vehicleNumber is only used for log tagging — it's not sent to SAN here.
 */
async function warmSession({ sanUsername, sanPassword, vehicleNumber }) {
  const startTime = Date.now();
  let browser = null;
  let page    = null; // lifted from try-block so the catch can debugCapture

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const proxyConfig  = getProxyConfig();
    const savedSession = getStoredSession(sanUsername);

    if (proxyConfig) {
      console.log(`[Warm] ${vehicleNumber} → proxy session ${proxyConfig.username.split('-session-')[1] ?? '?'}`);
    }
    if (savedSession) {
      console.log(`[Warm] ${vehicleNumber} → trying restored session for ${sanUsername}`);
    }

    const context = await browser.newContext({
      userAgent:    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      viewport:     { width: 390, height: 844 },
      permissions:     [],
      acceptDownloads: false,
      storageState:    savedSession,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });

    page = await context.newPage();

    // Same bandwidth-saver as addToQueue — we don't render anything.
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    console.log(`[Warm] ${vehicleNumber} → Navigating to SAN eDispatch…`);
    await page.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await page.waitForURL(
      url => url.href.includes(OIDC_HOST) || url.href.includes(APP_HOST),
      { timeout: TIMEOUT },
    );

    let reused = false;
    if (page.url().includes(OIDC_HOST)) {
      if (savedSession) {
        forgetSession(sanUsername);
        console.log(`[Warm] ${vehicleNumber} → restored session rejected by SAN — full login`);
      }

      await page.waitForSelector('input[placeholder="Enter Username"]', { timeout: TIMEOUT });
      console.log(`[Warm] ${vehicleNumber} → Filling credentials for ${sanUsername}…`);
      await page.fill('input[placeholder="Enter Username"]', sanUsername);
      await page.fill('input[placeholder="Enter Password"]', sanPassword);
      await page.click('button:has-text("Log In")');

      // Same race as addToQueue: detect bad-credentials promptly instead of
      // waiting for the full NAV_TIMEOUT.
      const winner = await Promise.race([
        page.waitForURL(`**/${APP_HOST}/**`, { timeout: NAV_TIMEOUT }).then(() => 'redirected'),
        page.locator('text=/Invalid username or password/i').first()
          .waitFor({ state: 'visible', timeout: NAV_TIMEOUT })
          .then(() => 'invalid_credentials'),
      ]);

      if (winner === 'invalid_credentials') {
        // Same wording as addToQueue — credentialLockoutService matches on it.
        throw new Error('Invalid SAN eDispatch username or password — check your credentials');
      }
      console.log(`[Warm] ${vehicleNumber} → OIDC callback complete — session warmed.`);
    } else {
      reused = true;
      console.log(`[Warm] ${vehicleNumber} → restored session accepted by SAN — no login needed.`);
    }

    const storageState = await context.storageState();
    saveSession(sanUsername, storageState);

    return {
      success:    true,
      reused,
      durationMs: Date.now() - startTime,
      message:    reused ? 'session_reused' : 'session_warmed',
    };
  } catch (err) {
    console.error(`[Warm] ${vehicleNumber} → ERROR: ${err.message}`);
    // Same classifier as addToQueue, "warm_" prefix to keep flows separate
    // in the debug dir listings.
    let urlAtError = '';
    try { urlAtError = page ? page.url() : ''; } catch { /* page closed */ }
    const failureLabel = `warm_${classifyFailure({ urlAtError, errorMessage: err.message })}`;
    if (page) await debugCapture(page, vehicleNumber, failureLabel).catch(() => {});

    const sanErrorText = await extractSanErrorMessage(page).catch(() => null);
    if (sanErrorText) {
      console.warn(`[Warm] ${vehicleNumber} → SAN said: "${sanErrorText}"`);
    }
    const friendly  = sanitizeError(err.message);
    const userError = sanErrorText ? `SAN: ${sanErrorText}` : friendly;
    return {
      success:      false,
      durationMs:   Date.now() - startTime,
      error:        userError,
      message:      userError,
      rawError:     err.message,
      sanErrorText: sanErrorText,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Live SAN credential check — a login-only round-trip (no queue action) used to
 * CONFIRM a driver's SAN password actually works. Wraps warmSession and maps the
 * outcome to the day-scoped credential breaker so the answer is authoritative:
 *
 *   verified: true   → SAN accepted the login. Lockout cleared.
 *   verified: false  → SAN rejected the username/password. Lockout armed.
 *   verified: null   → couldn't reach SAN (timeout/network). Lockout left as-is
 *                      so a transient blip can't strand or falsely clear a driver.
 *
 * driverId is optional (a pre-save check has no row yet); when omitted the
 * breaker is not touched and only the classification is returned.
 */
async function verifyCredentials({ driverId, sanUsername, sanPassword, vehicleNumber }) {
  const credentialLockout = require('./credentialLockoutService');
  // Force a fresh full login with the password under test — don't let a stale
  // accepted cookie jar mask a now-wrong password.
  forgetSession(sanUsername);

  const result = await warmSession({ sanUsername, sanPassword, vehicleNumber })
    .catch((err) => ({ success: false, rawError: err.message, error: err.message }));

  if (result.success) {
    if (Number.isInteger(driverId)) credentialLockout.clearLockout(driverId);
    return { verified: true, durationMs: result.durationMs };
  }
  if (credentialLockout.isCredentialError(result.rawError || result.error || '')) {
    if (Number.isInteger(driverId)) credentialLockout.lockOut(driverId, result.rawError || result.error);
    return { verified: false, reason: 'invalid_credentials', error: result.error || 'SAN rejected the username or password.' };
  }
  return { verified: null, reason: 'unreachable', error: result.error || 'Could not reach SAN to verify.' };
}

// ─── Pre-armed fire sessions ──────────────────────────────────────────────────
//
// WHY: the position scheduler's landing error is
//        (queue growth between fire decision and SAN assigning the slot)
//      − (lead it fired early by).
// The lead is clamped to the ±10 undershoot budget (see monitorService
// POS_MAX_LEAD), so the only remaining lever on OVERSHOOT is the decision→slot
// latency. A cold fire costs ~3.5 s (Chromium launch + navigate + search) and
// queues behind MONITOR_CONCURRENCY (Jun 09: the second batch of simultaneous
// fires waited ~3.5 s extra and landed +25 past the first). During a 7/s burst
// every second of latency costs 7 positions.
//
// HOW: for each driver approaching their fire window, park a logged-in page on
// SAN's vehicle-search result with the "Add To Queue" button already visible.
// Firing is then a single click + WAIT-screen confirmation (~1 s), and needs no
// browser launch — so it also bypasses the launch-capped jobQueue entirely.
//
// SHAPE: a small pool of shared Chromiums (BOT_ARMED_BROWSERS, ~180 MB each)
// with one context+page per driver (~35 MB each), balanced by session count.
// One browser was enough at 10 armed drivers, but same-tick fires serialise on
// a single browser's event loop (2026-06-30: 9 clicks on one tick, 2.2–2.5 s
// each vs the ~1 s a lone click takes) — spreading contexts across processes
// cuts that contention roughly by the pool size. 40 armed + 3 browsers ≈ 2 GB
// worst case, inside the 4096M container limit alongside the cold bots.
// monitorService declares the desired set every poll via syncFireSessions
// (wanted) and this module converges: arms the missing, refreshes the stale,
// disarms the no-longer-wanted.
//
// FIRE-TIME HAND-OFF: the fire decision flips positionFiredToday, which drops
// the driver from the wanted set on the very same tick — so the reconciler
// would disarm the parked page while the fire is still doing its DB roundtrips
// (Jun 11–12 production: 30 of 30 fires lost their armed shot this way).
// monitorService therefore claims the session SYNCHRONOUSLY at decision time
// (claimArmedSession — removes it from the map before any await) and passes
// the claimed record down to schedulerService, which fires it via
// fireClaimedSession. Every path degrades to the cold bot — fireClaimedSession
// returns null rather than throwing, and schedulerService falls through to
// addToQueue() (gated back into the monitor's jobQueue via coldGate so a
// failed armed shot can't stampede uncapped Chromium launches).
//
// SAN-side safety: arming performs the same login + search any bot run does,
// once per driver per morning (+ a fresh navigate+search every ~90 s as
// keep-alive) — far below the polling traffic. Credential failures register
// the same day-scoped lockout the warmer uses, so bad passwords can't cause
// login storms.

const credentialLockout = require('./credentialLockoutService');

// Hard cap on simultaneously armed contexts (memory guard). Must cover the
// WHOLE day's position roster, not just the nearest fires: a chunk storm
// collapses everyone's secsToFire to zero on one tick, and anyone unarmed at
// that moment falls to the concurrency-3 cold path at peak burst (2026-06-30:
// the old cap of 10 left 7 drivers cold → landings +46…+127 past target).
// ~35 MB per context ⇒ 48 armed ≈ 1.7 GB, inside the 5120M container limit.
// Sized to the pool's slot capacity (BOT_ARMED_BROWSERS_MAX × sessions per
// browser = 12 × 4); a cap below that starves fires to the cold path (07-27:
// 40 left 9 of 78 cold → +74…+154 past target).
const ARMED_MAX             = parseInt(process.env.BOT_ARMED_MAX             ?? '48', 10);
// Shared Chromium processes armed contexts are spread across. Same-tick armed
// clicks serialise per browser process (06-30: 9 clicks on one tick took
// 2.2–2.5 s each on a single browser; 07-06: 12 claims across 3 browsers = 4
// serialized clicks each → 9.7 s per fire). The pool therefore scales WITH the
// armed-session count instead of sitting on a constant: BOT_ARMED_BROWSERS is
// the floor (back-compat — small fleets behave exactly as before), and one
// extra browser is opened per BOT_ARMED_SESSIONS_PER_BROWSER sessions up to
// BOT_ARMED_BROWSERS_MAX. Memory: each browser process ≈ 180 MB on top of the
// ~35 MB/context; measured baseline is ~2–2.5 GB RSS at 3 browsers/40 armed,
// so the max-8 worst case ≈ +0.9 GB ≈ 3.2 GB — under pm2's 3584M restart
// limit. Raising MAX past 8 needs a matching pm2 max_memory_restart bump.
const ARMED_BROWSERS_MIN         = Math.max(1, parseInt(process.env.BOT_ARMED_BROWSERS ?? '3', 10));
const ARMED_BROWSERS_MAX         = Math.max(ARMED_BROWSERS_MIN, parseInt(process.env.BOT_ARMED_BROWSERS_MAX ?? '8', 10));
const ARMED_SESSIONS_PER_BROWSER = Math.max(1, parseInt(process.env.BOT_ARMED_SESSIONS_PER_BROWSER ?? '6', 10));

/** Pool slots the current session count deserves — roster-scaled, clamped. */
function desiredArmedSlots(sessionCount) {
  return Math.min(
    ARMED_BROWSERS_MAX,
    Math.max(ARMED_BROWSERS_MIN, Math.ceil(sessionCount / ARMED_SESSIONS_PER_BROWSER)),
  );
}
// Re-validate a parked page when its last check is older than this.
const ARM_REFRESH_MS        = parseInt(process.env.BOT_ARM_REFRESH_MS        ?? '90000', 10);
// Skip the keep-alive refresh when the fire is expected within this many
// seconds — never have the page mid-navigation at the moment we need to click.
const ARM_REFRESH_SKIP_SECS = parseInt(process.env.BOT_ARM_REFRESH_SKIP_SECS ?? '45', 10);
// After a failed arm attempt, don't retry this driver for this long.
const ARM_RETRY_COOLDOWN_MS = parseInt(process.env.BOT_ARM_RETRY_COOLDOWN_MS ?? '180000', 10);
// Persistent 'vehicle_not_available' is an ACCOUNT problem (the #142/#70/#4006
// class), not a transient SAN state: on 2026-06-30 the 180 s cooldown alone
// let #70 and #4006 burn 47 arm attempts (= 47 SAN logins) each in one day.
// After this many consecutive not-available arms, suspend re-arming for
// ARM_NOT_AVAIL_SUSPEND_MS (default 6 h — covers the rest of the morning
// window; a genuine SAN-side fix gets retried the same afternoon).
const ARM_NOT_AVAIL_MAX        = parseInt(process.env.BOT_ARM_NOT_AVAIL_MAX        ?? '3', 10);
const ARM_NOT_AVAIL_SUSPEND_MS = parseInt(process.env.BOT_ARM_NOT_AVAIL_SUSPEND_MS ?? '21600000', 10);
// Arm/refresh operations run through a small semaphore — arming is a full
// login+search (~4 s) off the critical path. 4 wide: the pool must be able to
// rebuild mid-storm (06-30: arms were completing DURING the burst at 2-wide,
// ~4.5 s each, and lost the race for 7 drivers).
const ARM_OPS_CONCURRENCY   = parseInt(process.env.BOT_ARM_OPS_CONCURRENCY   ?? '4', 10);
// Fire click → WAIT-screen confirmation wait. The Blazor add COMMITS when
// SAN's server processes the click event; this wait only covers the WAIT
// screen streaming back, so its expiry means "SAN is slow", almost never
// "the add failed" (2026-07-06: 17 fires blew a fixed 12 s ceiling in one
// storm — every one of them was already committed, and the cold fallback
// "discovered" them as already-in-queue). The timeout is therefore ADAPTIVE:
// 2 × the rolling p95 of recent armed-fire durations, clamped between
// BOT_ARM_FIRE_TIMEOUT_MS (floor — calm-day behaviour unchanged) and
// BOT_ARM_FIRE_TIMEOUT_MAX_MS. Timeouts themselves are recorded, so repeated
// slow confirmations escalate the ceiling instead of thrashing against it.
const ARM_FIRE_TIMEOUT_MS        = parseInt(process.env.BOT_ARM_FIRE_TIMEOUT_MS        ?? '12000', 10);
const ARM_FIRE_TIMEOUT_MAX_MS    = Math.max(ARM_FIRE_TIMEOUT_MS,
  parseInt(process.env.BOT_ARM_FIRE_TIMEOUT_MAX_MS ?? '45000', 10));
// Durations older than this no longer describe SAN's current mood — a storm
// is minutes long, and yesterday's latencies must not inflate today's floor.
const ARM_FIRE_LATENCY_WINDOW_MS = parseInt(process.env.BOT_ARM_FIRE_LATENCY_WINDOW_MS ?? '900000', 10);
// Post-timeout verification against the authoritative V Holding list: how many
// reads, how far apart. Covers an add that SAN is still processing when the
// confirmation wait expired.
const ARM_VERIFY_ATTEMPTS        = Math.max(1, parseInt(process.env.BOT_ARM_VERIFY_ATTEMPTS ?? '4', 10));
const ARM_VERIFY_PAUSE_MS        = parseInt(process.env.BOT_ARM_VERIFY_PAUSE_MS ?? '1500', 10);
// ─── Fast page release (2026-07-21 pipeline-declog) ──────────────────────────
// WHY: as the fleet grew ~15→68, a single queue jump now makes ~25 drivers fire
// at once (was ~4-6). The old fire path HELD each browser page in
// `page.waitForFunction` until SAN streamed the WAIT confirmation screen back —
// 10-25 s under storm load. 25 pages jammed for 20 s saturates the shared
// browser CPU, delaying every OTHER fire's click and ballooning SAN's effective
// slot-latency from ~0.3 s (good small-fleet days) to ~1.6 s — which at 40/s IS
// the entire +30→+50 overshoot regression. The storm rate (15-20/s) and
// burstiness (+30-44 jumps) are UNCHANGED vs the good days; only our own
// concurrent volume grew.
// FIX: stop holding the page for the slow WAIT screen. Wait only FIRE_RELEASE_MS
// for it; if it hasn't rendered by then (i.e. we're under load — the exact case
// that clogs the pipeline), DISPOSE the page immediately (frees the browser for
// the next fires) and confirm the committed add via the lightweight authoritative
// V Holding read (verifyAddLanded / spacezone HTTP GET) instead. The Blazor add
// is a fire-and-forget SignalR frame committed when SAN processes the click, so
// the page is not needed after the click — the slot is readable from V Holding.
// Contract-safe: changes only HOW we confirm, never WHEN we fire, so undershoot
// is untouched. Calm days keep the fast in-page read (WAIT screen shows in ~1-2 s).
// TUNED 2026-07-24 3000→1000: the 07-24 storm fired 29 drivers on ONE tick,
// serialising ~4 deep across 7 browsers; at 3 s/hold the tail landed 11 s late
// (+48…+59 overshoot vs +32 for the first-out driver — the delta is pure
// per-browser hold time). Under storm load the WAIT screen takes 10-25 s to
// stream back, so a 3 s hold never catches it anyway — it's wasted latency that
// jams the pool. 1 s frees each browser ~3× sooner (zero undershoot cost); calm
// fires whose WAIT screen is slower than 1 s just confirm via V Holding instead.
const FIRE_RELEASE_MS            = parseInt(process.env.BOT_FIRE_RELEASE_MS ?? '1000', 10);
// After the fast release, confirm the committed add via V Holding with a LONGER
// window than the cold-timeout verify — because we must never concede to the
// cold fallback while the add is merely slow to appear (the cold bot would
// re-add, find the driver already there, and write "already in queue" to the
// Position Accuracy table). Authorized adds ALWAYS commit (5 storms, ~320 fires,
// 0 genuine failures), and a fired driver becomes visible in V Holding within
// ~2-10 s even under load, so this window (12 × 1.5 s ≈ 18 s of lightweight
// HTTP polling — NOT a held browser) reliably catches the landing and records it
// as a genuine position. Only a SAN-benched "Not Authorized" driver never
// appears; that falls through to the cold path, which reports Not-Authorized —
// never "already in queue".
const FIRE_RELEASE_VERIFY_ATTEMPTS = Math.max(ARM_VERIFY_ATTEMPTS,
  parseInt(process.env.BOT_FIRE_RELEASE_VERIFY_ATTEMPTS ?? '12', 10));

// Rolling window of armed-fire durations (successes, rejections, timeouts —
// every round-trip that measures SAN's confirmation latency).
const armedFireLatencies = []; // { t, ms }

function recordArmedFireDuration(ms, now = Date.now()) {
  armedFireLatencies.push({ t: now, ms });
  // Prune opportunistically so the array can't grow unbounded on busy days.
  while (armedFireLatencies.length > 0 && now - armedFireLatencies[0].t > ARM_FIRE_LATENCY_WINDOW_MS) {
    armedFireLatencies.shift();
  }
}

function adaptiveFireTimeoutMs(now = Date.now()) {
  while (armedFireLatencies.length > 0 && now - armedFireLatencies[0].t > ARM_FIRE_LATENCY_WINDOW_MS) {
    armedFireLatencies.shift();
  }
  if (armedFireLatencies.length === 0) return ARM_FIRE_TIMEOUT_MS;
  const sorted = armedFireLatencies.map((e) => e.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
  return Math.min(ARM_FIRE_TIMEOUT_MAX_MS, Math.max(ARM_FIRE_TIMEOUT_MS, 2 * p95));
}

// ─── HTTP-fire latency cut (overshoot fix — see ±10 accuracy notes) ───────────
// The armed *click* serialises on the shared Chromium: 8 simultaneous fires on
// 2026-06-14 each took ~5 s (one timed out at 2 s) because the contexts contend
// for the one browser's event loop. The fix is to replay SAN's "Add To Queue"
// as a direct HTTP request on the parked context's *cookie jar* (Playwright's
// context.request) — no second tab, no render/JS contention, ~200 ms, and N
// parallel requests don't contend like N Chromiums.
//
// Two flags, both default OFF so production behaviour is unchanged until we have
// proof of SAN's add endpoint:
//   BOT_CAPTURE_FIRE_REQUEST=1  → observe-only: log the real add request the
//                                 next time a click fires, so we learn the exact
//                                 method/url/headers/body without guessing.
//   BOT_HTTP_FIRE=1             → use the HTTP path (needs the captured shape);
//                                 always falls back to the click on any doubt.
const CAPTURE_FIRE_REQUEST  = process.env.BOT_CAPTURE_FIRE_REQUEST === '1';
const HTTP_FIRE_ENABLED     = process.env.BOT_HTTP_FIRE === '1';
const HTTP_FIRE_TIMEOUT_MS  = parseInt(process.env.BOT_HTTP_FIRE_TIMEOUT_MS  ?? '4000', 10);
// Only requests whose URL matches this host/path are treated as "the add call"
// (set from the capture). Anything else the click triggers is ignored.
const HTTP_FIRE_URL_MATCH   = process.env.BOT_HTTP_FIRE_URL_MATCH ?? 'gtcvms.com';

/** driverId → armed session record */
const armedSessions = new Map();
// driverId → epoch ms until which arm attempts are suppressed (failure cooldown)
const armCooldownUntil = new Map();
// driverId → consecutive 'vehicle_not_available' arm outcomes. Cleared by a
// successful arm; drives the ARM_NOT_AVAIL_MAX suspension.
const notAvailableStreak = new Map();
// driverIds with an arm operation currently in flight (dedup across sync ticks)
const armingInFlight = new Set();
// driverIds in the most recent syncFireSessions wanted set — null until the
// first sync so direct calls (tests) are never gated. An arm op can spend
// seconds queued on the arm-ops semaphore or mid-login while its driver fires
// anyway (usually cold) and leaves the wanted set; without a re-check the op
// finishes a full SAN login and parks a session nobody will use, on browsers
// that are busy draining fire clicks (07-27: 35 logins ran inside the fire
// minute, several for drivers whose fire was already in flight). armFireSession
// re-checks this set after acquiring the semaphore and again before parking.
let lastSyncWantedIds = null;
// driverIds whose session has been CLAIMED for an in-flight fire (removed from
// armedSessions, not yet disposed). Tracked so closeArmedBrowserIfIdle can't
// close the shared browser under a click that hasn't happened yet.
const claimedInFlight = new Set();

// Pool of shared Chromiums — lazily launched per slot, all closed when idle.
// Sized to the MAX; how many slots are actually used follows the session
// count via desiredArmedSlots (roster-scaled — see the constant block above).
const armedBrowsers         = new Array(ARMED_BROWSERS_MAX).fill(null); // Browser | null
const armedBrowserLaunching = new Array(ARMED_BROWSERS_MAX).fill(null); // in-flight launch promise (dedup)

// Tiny semaphore for arm/refresh ops. Deliberately local — schedulerService's
// BotSemaphore caps *browser launches*; this caps page work inside the one
// shared browser, a different resource.
let armOpsActive = 0;
const armOpsWaiting = [];
function acquireArmOp() {
  if (armOpsActive < ARM_OPS_CONCURRENCY) { armOpsActive++; return Promise.resolve(); }
  return new Promise((resolve) => armOpsWaiting.push(resolve));
}
function releaseArmOp() {
  const next = armOpsWaiting.shift();
  if (next) next();
  else armOpsActive = Math.max(0, armOpsActive - 1);
}

/**
 * Launch (or reuse) one slot of the armed-browser pool.
 * No --single-process here: armed contexts all hit the same site, so default
 * Chromium shares one renderer across them anyway — and a renderer crash then
 * can't take the browser process down with it. 'disconnected' drops only the
 * sessions parked on THAT slot (their pages died with the process); the next
 * sync re-arms them, on whichever slots are healthy.
 */
async function ensureArmedBrowser(slot) {
  if (armedBrowsers[slot]?.isConnected()) return armedBrowsers[slot];
  if (armedBrowserLaunching[slot]) return armedBrowserLaunching[slot];

  armedBrowserLaunching[slot] = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      // Parked pages are exactly what Chromium's background throttling
      // punishes: occluded, no focus, idle for minutes — then we need their
      // JS to run a click handler NOW. Throttled timers/rAF delay the Blazor
      // click dispatch and the WAIT-screen render, inflating fire latency.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  }).then((browser) => {
    browser.on('disconnected', () => {
      if (armedBrowsers[slot] !== browser) return;
      armedBrowsers[slot] = null;
      const lost = [...armedSessions.values()].filter((s) => s.browserSlot === slot);
      if (lost.length > 0) {
        console.warn(`[Arm] browser[${slot}] disconnected — dropping ${lost.length} armed session(s) parked on it; next sync re-arms`);
        for (const s of lost) armedSessions.delete(s.driverId);
      }
    });
    armedBrowsers[slot] = browser;
    const active = armedBrowsers.filter((b) => b?.isConnected()).length;
    console.log(`[Arm] browser[${slot}] launched (${active} active, pool max ${ARMED_BROWSERS_MAX})`);
    return browser;
  }).finally(() => { armedBrowserLaunching[slot] = null; });

  return armedBrowserLaunching[slot];
}

// driverId → slot chosen for an arm still in flight. pickArmedSlot must count
// these too: arms run ARM_OPS_CONCURRENCY-wide, so counting only COMPLETED
// sessions would send a whole concurrent batch to the same slot (from empty,
// the first 4 arms would all pick slot 0 — one browser, no contention split).
const armingSlotInFlight = new Map();

/** Slot with the fewest armed/arming sessions — keeps same-tick fire clicks
 *  spread across browser processes instead of serialising on one event loop.
 *  The slot count is roster-scaled: it grows one browser per
 *  ARMED_SESSIONS_PER_BROWSER sessions (counting this one and the arms in
 *  flight), so a 36-driver storm roster gets ~9 browsers instead of packing
 *  12 clicks onto 3. */
function pickArmedSlot() {
  const slots = desiredArmedSlots(armedSessions.size + armingSlotInFlight.size + 1);
  const counts = new Array(slots).fill(0);
  for (const s of armedSessions.values()) {
    if (Number.isInteger(s.browserSlot) && s.browserSlot < slots) counts[s.browserSlot]++;
  }
  for (const slot of armingSlotInFlight.values()) {
    if (Number.isInteger(slot) && slot < slots) counts[slot]++;
  }
  let best = 0;
  for (let i = 1; i < slots; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

/** Close every pool browser once nothing is armed (memory back to baseline). */
async function closeArmedBrowserIfIdle() {
  // armingInFlight guard: an arm op building its context holds no map entry
  // yet — closing the browser under it would kill the arm for nothing.
  // claimedInFlight guard: a claimed session is out of the map but its page
  // is about to be clicked — same hazard from the other direction.
  if (armedSessions.size !== 0 || armingInFlight.size !== 0 || claimedInFlight.size !== 0) return;
  const closing = [];
  for (let slot = 0; slot < ARMED_BROWSERS_MAX; slot++) {
    const b = armedBrowsers[slot];
    if (!b) continue;
    armedBrowsers[slot] = null;
    closing.push(b.close().catch(() => {}));
  }
  if (closing.length > 0) {
    await Promise.all(closing);
    console.log('[Arm] armed browsers closed (no armed sessions)');
  }
}

/**
 * Drive a page to the vehicle-search result with "Add To Queue" visible.
 * Used by armFireSession on a fresh context. Resolves to:
 *   'armed'                 — button visible, page parked and ready
 *   'already_queued'        — WAIT screen: the driver is in the queue already
 *   'vehicle_not_available' — SAN business-rule rejection (retryable later)
 *   'not_found'             — vehicle number unknown to SAN
 * Throws on navigation/timeout/credential errors.
 */
async function driveToAddButton(page, { sanUsername, sanPassword, vehicleNumber }) {
  await page.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForURL(
    (url) => url.href.includes(OIDC_HOST) || url.href.includes(APP_HOST),
    { timeout: TIMEOUT },
  );

  if (page.url().includes(OIDC_HOST)) {
    // Restored cookies rejected (or none) — full login, same flow as addToQueue.
    forgetSession(sanUsername);
    await page.waitForSelector('input[placeholder="Enter Username"]', { timeout: TIMEOUT });
    await page.fill('input[placeholder="Enter Username"]', sanUsername);
    await page.fill('input[placeholder="Enter Password"]', sanPassword);
    await page.click('button:has-text("Log In")');

    const winner = await Promise.race([
      page.waitForURL(`**/${APP_HOST}/**`, { timeout: NAV_TIMEOUT }).then(() => 'redirected'),
      page.locator('text=/Invalid username or password/i').first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT })
        .then(() => 'invalid_credentials'),
    ]);
    if (winner === 'invalid_credentials') {
      // Literal "Invalid SAN" — what credentialLockout.isCredentialError matches.
      throw new Error('Invalid SAN eDispatch username or password — check your credentials');
    }
  }

  // Reaching the app proves the session — snapshot it for every other bot path.
  const storageState = await page.context().storageState();
  saveSession(sanUsername, storageState);

  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return document.querySelector('input[placeholder="Vehicle Dispatch Name"]') !== null
        || t.includes('Remove From Queue')
        || t.includes('Dispatched: T');
    },
    null,
    { timeout: TIMEOUT },
  );

  if (await isWaitScreen(page)) return 'already_queued';

  await page.fill('input[placeholder="Vehicle Dispatch Name"]', String(vehicleNumber));
  await page.click('button:has-text("Search")');
  await page.waitForFunction(
    (needles) => needles.some((s) => document.body.innerText.includes(s)),
    SEARCH_RESULT_STRINGS,
    { timeout: TIMEOUT },
  );

  const bodyText = await page.textContent('body').catch(() => '');
  if (bodyText.includes(SAN_TEXT.VEHICLE_NOT_AVAILABLE)) return 'vehicle_not_available';
  if (await isWaitScreen(page))                           return 'already_queued';

  const buttonVisible = await page
    .isVisible(`button:has-text("${SAN_TEXT.ADD_TO_QUEUE_BUTTON}")`)
    .catch(() => false);
  return buttonVisible ? 'armed' : 'not_found';
}

/**
 * Dispose a session RECORD (claimed or still mapped). Idempotent — the fire
 * path, the monitor's error path, and the disarm path can all call it without
 * coordinating, and only the first call closes the context.
 */
async function disposeClaimedSession(session, reason) {
  if (!session || session._disposed) return;
  session._disposed = true;
  claimedInFlight.delete(session.driverId);
  await session.context.close().catch(() => {});
  console.log(`[Arm] #${session.vehicleNumber} disarmed (${reason})`);
  await closeArmedBrowserIfIdle();
}

/** Dispose one armed session's context. Safe to call twice. */
async function disarmFireSession(driverId, reason) {
  const session = armedSessions.get(driverId);
  if (!session) return;
  armedSessions.delete(driverId);
  await disposeClaimedSession(session, reason);
}

/**
 * Claim an armed session for an imminent fire. SYNCHRONOUS on purpose: the
 * fire decision flips positionFiredToday, which drops the driver from the
 * pre-arm wanted set on the SAME poll tick — so syncFireSessions would disarm
 * the parked page before the fire's DB roundtrips reach the click (Jun 11–12
 * production: 30 of 30 fires lost their armed shot to exactly this race).
 * Removing the session from the map before the caller's first await makes the
 * reconciler blind to it; the claimer owns disposal from here (fireClaimedSession
 * always disposes in its finally; error paths call disposeClaimedSession).
 */
function claimArmedSession(driverId) {
  const session = armedSessions.get(driverId);
  if (!session) return null;
  armedSessions.delete(driverId);
  claimedInFlight.add(driverId);
  return session;
}

/** Dispose everything (end of position window / shutdown). No-op when empty. */
async function disarmAllFireSessions(reason) {
  if (armedSessions.size === 0) return;
  const ids = [...armedSessions.keys()];
  console.log(`[Arm] disarming all ${ids.length} session(s) — ${reason}`);
  for (const id of ids) await disarmFireSession(id, reason);
}

function hasArmedFireSession(driverId) {
  return armedSessions.has(driverId);
}

/** Lightweight stats for the admin/monitor UI and tests. */
function armedFireSessionStats() {
  return {
    armed:    armedSessions.size,
    arming:   armingInFlight.size,
    browser:  armedBrowsers.some((b) => b?.isConnected()),
    browsers: armedBrowsers.filter((b) => b?.isConnected()).length,
    sessions: [...armedSessions.values()].map((s) => ({
      driverId:       s.driverId,
      vehicleNumber:  s.vehicleNumber,
      browserSlot:    s.browserSlot,
      armedAt:        s.armedAt,
      lastVerifiedAt: s.lastVerifiedAt,
    })),
  };
}

/**
 * Arm one driver: fresh context in the shared browser, parked on the search
 * result. Failures cool the driver down (ARM_RETRY_COOLDOWN_MS) so a broken
 * account can't login-storm SAN at 1 s poll cadence; credential failures
 * additionally register the standard day-scoped lockout.
 */
async function armFireSession({ driverId, vehicleNumber, getCredentials }) {
  if (armedSessions.has(driverId) || armingInFlight.has(driverId)) return;
  if ((armCooldownUntil.get(driverId) ?? 0) > Date.now()) return;

  armingInFlight.add(driverId);
  await acquireArmOp();

  let context = null;
  try {
    // The driver may have fired (usually cold) while this op sat queued on the
    // semaphore — abort before spending a login on them.
    if (lastSyncWantedIds && !lastSyncWantedIds.has(driverId)) {
      console.log(`[Arm] #${vehicleNumber} arm skipped — dropped from wanted set while queued (fired or unscheduled meanwhile)`);
      return;
    }
    const creds = await getCredentials();
    if (!creds) throw new Error('credentials unavailable');
    const { sanUsername, sanPassword } = creds;

    const slot         = pickArmedSlot();
    armingSlotInFlight.set(driverId, slot);
    const browser      = await ensureArmedBrowser(slot);
    const proxyConfig  = getProxyConfig();
    const savedSession = getStoredSession(sanUsername);

    context = await browser.newContext({
      userAgent:    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      viewport:     { width: 390, height: 844 },
      permissions:     [],
      acceptDownloads: false,
      storageState:    savedSession,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    const outcome = await driveToAddButton(page, { sanUsername, sanPassword, vehicleNumber });

    if (outcome !== 'armed') {
      // already_queued → monitor's next poll flips hasBeenSeen and drops the
      // driver from the wanted set; not_available/not_found can clear on SAN's
      // side, so the cooldown lets us re-try a few minutes later.
      let cooldownMs = ARM_RETRY_COOLDOWN_MS;
      if (outcome === 'vehicle_not_available') {
        // Repeated not-available = broken account/vehicle data, not a queue
        // state that will clear. Suspend instead of looping logins all morning.
        const streak = (notAvailableStreak.get(driverId) ?? 0) + 1;
        notAvailableStreak.set(driverId, streak);
        if (streak >= ARM_NOT_AVAIL_MAX) {
          cooldownMs = ARM_NOT_AVAIL_SUSPEND_MS;
          console.warn(`[Arm] ⚠ #${vehicleNumber} vehicle_not_available ×${streak} — suspending re-arm for ${Math.round(cooldownMs / 60000)} min; SAN account/vehicle needs manual attention`);
        }
      }
      armCooldownUntil.set(driverId, Date.now() + cooldownMs);
      await context.close().catch(() => {});
      console.log(`[Arm] #${vehicleNumber} not armed (${outcome}) — cooldown ${Math.round(cooldownMs / 1000)}s`);
      await closeArmedBrowserIfIdle();
      return;
    }

    notAvailableStreak.delete(driverId);
    // The driver may have fired mid-login — don't park a session nobody will
    // use (the next sync would only disarm it again).
    if (lastSyncWantedIds && !lastSyncWantedIds.has(driverId)) {
      await context.close().catch(() => {});
      console.log(`[Arm] #${vehicleNumber} armed too late — no longer wanted (fired mid-login); session released`);
      await closeArmedBrowserIfIdle();
      return;
    }
    armedSessions.set(driverId, {
      driverId,
      vehicleNumber,
      sanUsername,
      context,
      page,
      browserSlot:    slot,      // which pool browser the page lives in
      getCredentials,            // kept for the keep-alive re-drive (decrypted on use)
      armedAt:        Date.now(),
      lastVerifiedAt: Date.now(),
      refreshing:     null,
    });
    console.log(`[Arm] ✓ #${vehicleNumber} armed — fire is now a single click`);
  } catch (err) {
    armCooldownUntil.set(driverId, Date.now() + ARM_RETRY_COOLDOWN_MS);
    if (context) await context.close().catch(() => {});
    if (credentialLockout.isCredentialError(err.message)) {
      credentialLockout.lockOut(driverId, `armer: ${err.message}`);
    }
    console.warn(`[Arm] ✗ #${vehicleNumber} arm failed: ${err.message} — cooldown ${ARM_RETRY_COOLDOWN_MS / 1000}s`);
    await closeArmedBrowserIfIdle();
  } finally {
    armingInFlight.delete(driverId);
    armingSlotInFlight.delete(driverId);
    releaseArmOp();
  }
}

/**
 * Keep-alive: re-drive the parked page through the full navigate→search flow
 * so (a) the SAN session stays active server-side and (b) we notice a dead
 * page BEFORE fire time. Any failure disarms — the next sync tick re-arms if
 * the driver still wants a session. Stores the in-flight promise so a fire
 * arriving mid-refresh can briefly await it instead of clicking on a
 * navigating page.
 *
 * Why a full re-drive and not just re-running the search in place: the parked
 * page is SAN's search RESULT screen, which does not render the
 * "Vehicle Dispatch Name" input. The original keep-alive page.fill'd that
 * input and therefore timed out after 30 s on EVERY refresh (Jun 11–12: every
 * armed session flapped disarm→re-arm ~every 2 min, ~55 full SAN logins per
 * driver per morning, each hung fill pinning one of the two arm-op slots).
 * driveToAddButton starts from a fresh goto, so it works regardless of which
 * screen the page is currently showing, and it's the exact flow that armed
 * the page in the first place.
 */
function refreshArmedSession(driverId) {
  const session = armedSessions.get(driverId);
  if (!session || session.refreshing) return session?.refreshing ?? Promise.resolve();

  session.refreshing = (async () => {
    await acquireArmOp();
    try {
      const { page, vehicleNumber } = session;
      const creds = await session.getCredentials();
      if (!creds) throw new Error('credentials unavailable');
      const outcome = await driveToAddButton(page, { ...creds, vehicleNumber });
      if (outcome !== 'armed') {
        // WAIT screen (someone queued the driver) or SAN state change —
        // either way this page can no longer fire.
        await disarmFireSession(driverId, `keep-alive found page no longer fireable (${outcome})`);
        return;
      }
      session.lastVerifiedAt = Date.now();
    } catch (err) {
      console.warn(`[Arm] #${session.vehicleNumber} keep-alive failed: ${err.message}`);
      await disarmFireSession(driverId, 'keep-alive failure');
    } finally {
      session.refreshing = null;
      releaseArmOp();
    }
  })();
  return session.refreshing;
}

/**
 * Fire a CLAIMED session: click "Add To Queue", confirm the WAIT screen,
 * read the assigned position. Returns an addToQueue-shaped result, or NULL
 * meaning "no armed shot was taken" — caller falls back to the cold bot.
 * The record is consumed either way: one armed session, one shot. Accepts
 * null/already-disposed records so callers can pass a failed claim through.
 */
// ─── Fire-request capture (observe-only; BOT_CAPTURE_FIRE_REQUEST=1) ──────────
// Records the real network request SAN's "Add To Queue" click triggers, so the
// HTTP-fire path can replay the exact shape instead of guessing. Secrets
// (cookie / authorization / *token*) are redacted to length + 8-char prefix;
// the POST body (vehicle/zone/CSRF) is logged in full — that's what we need.
// A no-op object is returned when the flag is off, so the hot path pays nothing.
function redactHeaderValue(name, value) {
  const lower = String(name).toLowerCase();
  if (lower === 'cookie' || lower === 'authorization' || lower.includes('token')) {
    return `«${value.length} chars, "${value.slice(0, 8)}…"»`;
  }
  return value;
}

function installFireCapture(page, vehicleNumber, label) {
  if (!CAPTURE_FIRE_REQUEST) return { dump: async () => {} };
  const hits = [];
  const onReqFinished = async (req) => {
    try {
      if (req.method() === 'GET') return;
      const url = req.url();
      if (!url.includes(HTTP_FIRE_URL_MATCH)) return;
      // Never capture the OIDC/login request — its body carries credentials.
      // The armed path is parked post-login, so this should never fire anyway.
      if (url.includes(OIDC_HOST)) return;
      const resp = await req.response().catch(() => null);
      const status = resp ? resp.status() : null;
      const bodySnippet = resp
        ? await resp.text().then((t) => t.slice(0, 400)).catch(() => null)
        : null;
      const safeHeaders = {};
      for (const [k, v] of Object.entries(req.headers())) safeHeaders[k] = redactHeaderValue(k, v);
      hits.push({ method: req.method(), url, headers: safeHeaders, postData: req.postData(), status, bodySnippet });
    } catch { /* best-effort diagnostic capture */ }
  };
  page.on('requestfinished', onReqFinished);
  return {
    async dump() {
      page.off('requestfinished', onReqFinished);
      // Where does the SPA keep its auth? Log localStorage KEYS only (not values),
      // before the context closes — this tells us whether HTTP-fire needs a
      // bearer header or whether the cookie jar alone authenticates.
      let authKeys = [];
      try {
        const ss = await page.context().storageState();
        authKeys = (ss.origins || []).flatMap((o) =>
          (o.localStorage || []).map((e) => `${o.origin} → ${e.name}`));
      } catch { /* context may already be closing */ }
      console.log(`[Arm:capture] #${vehicleNumber} (${label}) — ${hits.length} non-GET ${HTTP_FIRE_URL_MATCH} request(s) during fire:`);
      for (const h of hits) {
        console.log(`[Arm:capture]   → ${h.method} ${h.url}  [${h.status ?? '?'}]`);
        console.log(`[Arm:capture]     headers: ${JSON.stringify(h.headers)}`);
        console.log(`[Arm:capture]     body:    ${h.postData ?? '(none)'}`);
        if (h.bodySnippet) console.log(`[Arm:capture]     resp:    ${h.bodySnippet.replace(/\s+/g, ' ')}`);
      }
      console.log(`[Arm:capture]   storageState localStorage keys: ${authKeys.join(', ') || '(none)'}`);
    },
  };
}

/**
 * HTTP-fire: replay "Add To Queue" as a direct request on the parked context's
 * cookie jar (Playwright APIRequestContext) — no second browser tab, so N
 * simultaneous fires don't serialise on the one Chromium event loop the way N
 * clicks did (2026-06-14: ~5 s each, one 2 s timeout).
 *
 * DRAFT — default OFF (BOT_HTTP_FIRE). The request shape comes from a capture
 * (BOT_CAPTURE_FIRE_REQUEST); until session.addRequest is populated by the arm
 * step this returns null and the caller uses the proven click. Returns null on
 * ANY doubt so the click fallback owns the hard cases. Never records a position
 * it can't confirm via SAN's own V Holding (preserves the bias-contamination
 * guard — see markAlreadyQueued / the +116 #631 incident).
 */
async function fireViaHttp(session) {
  if (!HTTP_FIRE_ENABLED) return null;
  const { context, vehicleNumber } = session;
  const reqSpec = session.addRequest; // { url, method, headers, body } — set at arm time from capture
  if (!context || !reqSpec || !reqSpec.url) return null;

  const startTime = Date.now();
  try {
    // context.request shares the parked context's cookies → authenticated with
    // no render. If SAN needs a bearer token, the arm step copies it into
    // reqSpec.headers (captured from localStorage).
    const resp = await context.request.fetch(reqSpec.url, {
      method:  reqSpec.method || 'POST',
      headers: reqSpec.headers || undefined,
      data:    reqSpec.body ?? undefined,
      timeout: HTTP_FIRE_TIMEOUT_MS,
    });
    if (!resp.ok()) {
      console.warn(`[Arm] ✗ #${vehicleNumber} HTTP fire ${resp.status()} — falling back to click`);
      return null;
    }
    // Position is SAN-authoritative from V Holding; the parked page proved we
    // were NOT already queued, so a confirmed entry now is OUR add.
    const info = await verifyDriverInQueue(vehicleNumber).catch(() => null);
    if (!info || !Number.isFinite(info.position)) {
      console.warn(`[Arm] #${vehicleNumber} HTTP fire sent but position unconfirmed — falling back to click to verify`);
      return null;
    }
    console.log(`[Arm] ⚡ #${vehicleNumber} fired via HTTP in ${Date.now() - startTime} ms → position ${info.position}`);
    return {
      success:         true,
      alreadyQueued:   false,
      viaArmedSession: true,
      viaHttp:         true,
      ...info,
      durationMs:      Date.now() - startTime,
      message:         `Added to queue — Position: ${info.position}`,
    };
  } catch (err) {
    console.warn(`[Arm] ✗ #${vehicleNumber} HTTP fire failed (${err.message}) — falling back to click`);
    return null;
  }
}

async function fireClaimedSession(session) {
  if (!session || session._disposed) return null;

  const startTime = Date.now();
  const { page, vehicleNumber } = session;

  // Fast path: replay the add over HTTP (no Chromium contention). Returns null
  // when disabled/unconfigured or on any uncertainty → the click below runs.
  const httpResult = await fireViaHttp(session);
  if (httpResult) {
    await disposeClaimedSession(session, 'fired via HTTP — session consumed');
    return httpResult;
  }

  // A keep-alive refresh may be mid-navigation — give it a moment to settle
  // rather than racing a click against it. Refreshes are skipped inside the
  // imminent-fire window (ARM_REFRESH_SKIP_SECS) so this rarely engages.
  if (session.refreshing) {
    await Promise.race([
      session.refreshing,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {});
    if (session._disposed) return null; // refresh disarmed it mid-claim
  }

  const cap = installFireCapture(page, vehicleNumber, 'armed');
  try {
    // Fast path: dispatch the click INSIDE the page — runs the button's own
    // onclick (elementFunctions.prepareStatusPageElements → hidden Blazor
    // button → SignalR frame) with none of Playwright's actionability
    // pipeline (scroll-into-view, hit-testing, trial clicks), which is where
    // a contended/just-unthrottled renderer spends its time. Falls back to
    // the proven page.click when the button can't be found in-page.
    const fastClicked = await page.evaluate((label) => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim().includes(label) && !b.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    }, SAN_TEXT.ADD_TO_QUEUE_BUTTON).catch(() => false);
    if (!fastClicked) {
      await page.click(`button:has-text("${SAN_TEXT.ADD_TO_QUEUE_BUTTON}")`, { timeout: 2000 });
    }
    // Click dispatched — the add is committed whenever SAN processes it. Watch
    // V Holding for it from here: not-yet-visible age is the live backlog
    // signal, and first visibility is an early landing (see the watch above).
    beginFireVisibility(vehicleNumber);

    // Wait only a SHORT window for the WAIT screen (see FIRE_RELEASE_MS). On a
    // calm day it renders in ~1-2 s and we read the slot straight from the page
    // (the fast in-page path, unchanged). Under storm load it takes 10-25 s —
    // holding the page that long is exactly what jams the pool and inflates
    // everyone's slot-latency, so we DON'T wait: we release below and confirm
    // via the authoritative V Holding read instead.
    let waitScreenSeen = true;
    try {
      await page.waitForFunction(
        (needles) => needles.some((s) => document.body.innerText.includes(s)),
        [SAN_TEXT.REMOVE_FROM_QUEUE, SAN_TEXT.VEHICLE_NOT_AVAILABLE],
        { timeout: FIRE_RELEASE_MS },
      );
    } catch {
      waitScreenSeen = false;
    }

    if (waitScreenSeen) {
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText.includes(SAN_TEXT.VEHICLE_NOT_AVAILABLE)) {
        recordArmedFireDuration(Date.now() - startTime);
        console.log(`[Arm] #${vehicleNumber} → ${SAN_TEXT.VEHICLE_NOT_AVAILABLE} (SAN business-rule rejection)`);
        return {
          success:             false,
          vehicleNotAvailable: true,
          viaArmedSession:     true,
          durationMs:          Date.now() - startTime,
          error:               DRIVER_ERROR_COPY.VEHICLE_NOT_AVAILABLE,
          message:             DRIVER_ERROR_COPY.VEHICLE_NOT_AVAILABLE,
        };
      }

      const info = await extractQueueInfo(page);
      recordArmedFireDuration(Date.now() - startTime);
      console.log(`[Arm] ⚡ #${vehicleNumber} fired via armed session in ${Date.now() - startTime} ms → position ${info.position}`);
      return {
        success:         true,
        alreadyQueued:   false,
        viaArmedSession: true,
        ...info,
        durationMs:      Date.now() - startTime,
        message:         `Added to queue — Position: ${info.position}, Location: ${info.location}`,
      };
    }

    // ─── Fast release (under load) ───────────────────────────────────────────
    // The WAIT screen hasn't streamed back in FIRE_RELEASE_MS — we're in the
    // storm case that clogs the pool. Free this browser NOW so the fires behind
    // us click without contention, then confirm the committed add via the
    // lightweight V Holding read (one spacezone GET per attempt). Disposing here
    // is safe: the click already dispatched the add; the page is not needed.
    await disposeClaimedSession(session, 'fast-release: confirming via V Holding');
    // Persistent confirm (no held browser) — never concede to cold while the
    // committed add is merely slow to appear, so the table shows a real landing,
    // not "already in queue" (see FIRE_RELEASE_VERIFY_ATTEMPTS).
    const landed = await verifyAddLanded(vehicleNumber, FIRE_RELEASE_VERIFY_ATTEMPTS);
    const elapsedMs = Date.now() - startTime;
    recordArmedFireDuration(elapsedMs);
    if (landed) {
      console.log(`[Arm] ⚡ #${vehicleNumber} fast-released at ${FIRE_RELEASE_MS} ms, add COMMITTED → position ${landed.position} (V Holding, ${elapsedMs} ms total)`);
      return {
        success:              true,
        // Parked page proved not-queued at arm time ⇒ this V Holding presence is
        // OUR add: a genuine landing (same justification as the verify-on-timeout
        // recovery), safe for position tracking + the fleet probe.
        alreadyQueued:        false,
        viaArmedSession:      true,
        recoveredFromTimeout: true,
        ...landed,
        durationMs:           elapsedMs,
        message:              `Added to queue — Position: ${landed.position}, Location: ${landed.location}`,
      };
    }
    // Not visible yet — likely a genuine failure or a very slow add. The cold
    // fallback takes over (idempotent: it detects an in-queue add as already_queued).
    console.warn(`[Arm] ✗ #${vehicleNumber} fast-released but not in V Holding after ${elapsedMs} ms — falling back to cold bot`);
    return null;
  } catch (err) {
    // A confirmation error is NOT a failed add: the click is a fire-and-forget
    // SignalR event, committed when SAN's server processes it. Record the
    // elapsed time (escalates the adaptive timeout for the fires behind us),
    // then check the authoritative V Holding list before conceding — the
    // 2026-07-06 storm turned 17 committed adds into cold fallbacks and a wall
    // of "already in queue" rows precisely because this path assumed failure.
    const elapsedMs = Date.now() - startTime;
    recordArmedFireDuration(elapsedMs);
    const landed = await verifyAddLanded(vehicleNumber);
    if (landed) {
      console.log(`[Arm] ⚡ #${vehicleNumber} confirmation timed out at ${elapsedMs} ms but add COMMITTED → position ${landed.position} (verified)`);
      return {
        success:         true,
        // alreadyQueued stays false: the parked page proved the driver was NOT
        // queued at arm time, so this is OUR add — a genuine landing (unlike
        // the cold path's recovery, which can't rule out a pre-existing entry).
        alreadyQueued:   false,
        viaArmedSession: true,
        // Same flag the cold addToQueue recovery uses (see its catch handler),
        // so downstream consumers treat both timeout-recoveries uniformly.
        recoveredFromTimeout: true,
        ...landed,
        durationMs:      Date.now() - startTime,
        message:         `Added to queue — Position: ${landed.position}, Location: ${landed.location}`,
      };
    }
    // Genuinely not in the queue — the cold bot takes over. If the add lands
    // even later, the fallback finds the WAIT screen and reports alreadyQueued
    // with the real position (idempotent).
    console.warn(`[Arm] ✗ #${vehicleNumber} armed fire failed after ${elapsedMs} ms (${err.message}) — not in V Holding, falling back to cold bot`);
    await debugCapture(page, vehicleNumber, 'armed_fire_error').catch(() => {});
    return null;
  } finally {
    // Every verdict path ends the in-flight window: confirm, not-available,
    // verify-recovery, or cold fallback (no-op if the click never dispatched).
    resolveFireVisibility(vehicleNumber);
    await cap.dump();
    await disposeClaimedSession(session, 'fire attempt consumed the session');
  }
}

/** Claim-and-fire convenience: the one-step path for callers that did not
 *  claim at decision time (cold position fires that find a session anyway). */
async function fireArmedSession(driverId) {
  return fireClaimedSession(claimArmedSession(driverId));
}

/**
 * Reconcile armed sessions with the desired set (called every monitor poll).
 *
 * wanted: [{ driverId, vehicleNumber, secondsUntilFire, getCredentials }]
 *   getCredentials: async () => ({ sanUsername, sanPassword }) | null
 *   — credentials are only fetched/decrypted when an arm actually happens.
 *
 * Fire-and-forget per driver; returns after this tick's operations settle so
 * tests can await deterministically. Self-throttling: in-flight dedup, failure
 * cooldowns, ARMED_MAX cap, and the arm-ops semaphore all live below this.
 */
async function syncFireSessions(wanted) {
  const wantedById = new Map(wanted.map((w) => [w.driverId, w]));
  lastSyncWantedIds = new Set(wantedById.keys());

  // Disarm sessions whose driver no longer wants one (fired, seen, target gone).
  const ops = [];
  for (const driverId of [...armedSessions.keys()]) {
    if (!wantedById.has(driverId)) ops.push(disarmFireSession(driverId, 'no longer scheduled'));
  }

  // Arm the closest-to-fire first; the cap bounds memory, and anyone past the
  // cap simply stays on the cold path (correct, just slower).
  const ranked = [...wanted].sort(
    (a, b) => (a.secondsUntilFire ?? Infinity) - (b.secondsUntilFire ?? Infinity),
  );
  let budget = ARMED_MAX;
  for (const w of ranked) {
    if (budget <= 0) break;
    budget--;
    const session = armedSessions.get(w.driverId);
    if (session) {
      const stale    = Date.now() - session.lastVerifiedAt > ARM_REFRESH_MS;
      const imminent = (w.secondsUntilFire ?? Infinity) < ARM_REFRESH_SKIP_SECS;
      if (stale && !imminent && !session.refreshing) ops.push(refreshArmedSession(w.driverId));
    } else if (!armingInFlight.has(w.driverId)) {
      ops.push(armFireSession(w));
    }
  }

  await Promise.allSettled(ops);
}

module.exports = {
  addToQueue,
  removeFromQueue,
  warmSession,
  verifyCredentials,
  sanitizeError,
  sessionStore,
  // Exposed for the warmer service and tests.
  saveSession,
  getStoredSession,
  forgetSession,
  SESSION_TTL_MS,
  // Pre-armed fire sessions (±10 position accuracy — see section above).
  syncFireSessions,
  claimArmedSession,
  fireClaimedSession,
  disposeClaimedSession,
  fireArmedSession,
  hasArmedFireSession,
  disarmAllFireSessions,
  armedFireSessionStats,
  // Exposed for unit tests — pure failure classifier.
  _classifyFailure:               classifyFailure,
  _extractKnownErrorFromText:     extractKnownErrorFromText,
  _extractGenericErrorFromText:   extractGenericErrorFromText,
  // Exposed for unit tests — adaptive fire timeout + roster-scaled pool.
  _adaptiveFireTimeoutMs:         adaptiveFireTimeoutMs,
  _recordArmedFireDuration:       recordArmedFireDuration,
  _desiredArmedSlots:             desiredArmedSlots,
  _verifyAddLanded:               verifyAddLanded,
  // Exposed for tailProbeService — same login/search/read flows the bot uses,
  // so the probe can never drift from the proven page interactions.
  _driveToAddButton:              driveToAddButton,
  _extractQueueInfo:              extractQueueInfo,
  _isWaitScreen:                  isWaitScreen,
  _SAN_TEXT:                      SAN_TEXT,
  verifyDriverInQueue,
  // Fire-visibility watch — backlog signal + early landings (see the section).
  setFireVisibilityListener,
  oldestUnseenFireAgeMs,
  // Exposed for unit tests.
  _beginFireVisibility:           beginFireVisibility,
  _resolveFireVisibility:         resolveFireVisibility,
  _fireVisPollOnce:               fireVisPollOnce,
  _setFetchSnapshotFn:            (fn) => { fetchSnapshotFn = fn; },
  _pendingFireVis:                pendingFireVis,
};
