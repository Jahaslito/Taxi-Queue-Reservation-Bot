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
async function verifyDriverInQueue(vehicleNumber) {
  const { fetch: ufetch } = require('undici');
  const { _parseQueue, _norm } = require('./monitorService');
  const QUEUE_URL = process.env.MONITOR_QUEUE_URL
    ?? 'https://san.gtcvms.com/GSIDispatchmobile/spacezone/10-17';
  const res  = await ufetch(QUEUE_URL, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const { waiting, dispatched } = _parseQueue(html);
  const vn = _norm(vehicleNumber);
  if (waiting.has(vn))    return { position: waiting.get(vn),    location: 'V Holding' };
  if (dispatched.has(vn)) return { position: dispatched.get(vn), location: 'Dispatched' };
  return null;
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

    // ─── STEP 7: click Remove From Queue ─────────────────────────────────────
    console.log(`[Bot] ${vehicleNumber} (remove) → clicking Remove From Queue…`);
    await page.click('button:has-text("Remove From Queue")');

    // Wait for confirmation — page transitions back to the search/vehicle page
    await page.waitForFunction(
      () => document.querySelector('input[placeholder="Vehicle Dispatch Name"]') !== null
         || !document.body.innerText.includes('Remove From Queue'),
      null,
      { timeout: TIMEOUT },
    );

    console.log(`[Bot] ${vehicleNumber} (remove) → ✓ successfully removed from queue`);
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

module.exports = {
  addToQueue,
  removeFromQueue,
  warmSession,
  sanitizeError,
  sessionStore,
  // Exposed for the warmer service and tests.
  saveSession,
  getStoredSession,
  forgetSession,
  SESSION_TTL_MS,
  // Exposed for unit tests — pure failure classifier.
  _classifyFailure:               classifyFailure,
  _extractKnownErrorFromText:     extractKnownErrorFromText,
  _extractGenericErrorFromText:   extractGenericErrorFromText,
};
