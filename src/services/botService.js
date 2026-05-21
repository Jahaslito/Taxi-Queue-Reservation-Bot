const { chromium } = require('playwright');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');

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
    return 'Invalid SAN username or password — check your credentials';
  if (m.includes('not found'))
    return 'Vehicle number not found in SAN eDispatch';
  if (m.includes('navigation') || m.includes('page crashed'))
    return 'The SAN website is currently unavailable — please try again later';
  return 'Something went wrong — please try again or contact support';
}

// ─── Proxy rotation ───────────────────────────────────────────────────────────
// Returns a Playwright-compatible proxy config with a fresh session ID, or null
// if PROXY_SERVER is not set (proxy disabled — all traffic goes via server IP).
//
// Supported providers and their username formats:
//   Bright Data:  brd-customer-XXXX-zone-residential-session-{session}
//   Oxylabs:      customer-XXXX-sessid-{session}
//   Smartproxy:   user-XXXX-sessionid-{session}
//
// Set PROXY_USERNAME with {session} where the random ID should be inserted.
// Each addToQueue() call gets a unique session → a different residential IP.
function getProxyConfig() {
  const server = process.env.PROXY_SERVER;
  if (!server) return null;
  const sessionId = crypto.randomBytes(8).toString('hex');
  const username  = (process.env.PROXY_USERNAME || '').replace('{session}', sessionId);
  return { server, username, password: process.env.PROXY_PASSWORD || '' };
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

/**
 * Automates the full SAN eDispatch queue process for one driver.
 *
 * Flow:
 *  1. Navigate to eDispatch → OIDC redirects to identity server login page
 *  2. Fill username + password, click Log In
 *  3. OIDC callback redirects back to eDispatch app
 *  4. Fill vehicle NUMBER in search field, click Search
 *  5. Click "Add To Queue" on the vehicle result page
 *  6. Read Position / Location / Time from the WAIT confirmation screen
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

    const proxyConfig = getProxyConfig();
    if (proxyConfig) {
      console.log(`[Bot] ${vehicleNumber} → Using proxy session ${proxyConfig.username.split('-session-')[1] ?? '?'}`);
    }

    const context = await browser.newContext({
      // Mobile UA matches what the site expects (optimised for mobile)
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      viewport:  { width: 390, height: 844 },
      permissions:     [],
      acceptDownloads: false,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });

    page = await context.newPage();

    // ─── STEP 1: Navigate ─────────────────────────────────────────────────────
    // Navigating to the app URL triggers an OIDC redirect to:
    //   https://san.gtcvms.com/GsiIdentityServer/Account/Login?ReturnUrl=...
    // Playwright follows all redirects automatically; we wait for the login
    // form to appear on the identity-server page.
    console.log(`[Bot] ${vehicleNumber} → Navigating to SAN eDispatch (OIDC flow)…`);
    await page.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Confirm we landed on the OIDC login page
    await page.waitForURL(`**/${OIDC_HOST}/**`, { timeout: TIMEOUT });
    console.log(`[Bot] ${vehicleNumber} → Redirected to OIDC login: ${page.url()}`);

    // ─── STEP 2: Fill login form ──────────────────────────────────────────────
    await page.waitForSelector('input[placeholder="Enter Username"]', { timeout: TIMEOUT });
    console.log(`[Bot] ${vehicleNumber} → Filling credentials for ${sanUsername}…`);

    await page.fill('input[placeholder="Enter Username"]', sanUsername);
    await page.fill('input[placeholder="Enter Password"]', sanPassword);

    // Click Log In — wait for the OIDC callback to redirect us back to the app
    await Promise.all([
      page.waitForURL(`**/${APP_HOST}/**`, { timeout: NAV_TIMEOUT }),
      page.click('button:has-text("Log In")')
    ]);

    console.log(`[Bot] ${vehicleNumber} → OIDC callback complete — back on eDispatch.`);

    // Let the SPA fully hydrate before querying the DOM
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});

    // Debug: capture what the page looks like right after login, before any waitForFunction
    await debugCapture(page, vehicleNumber, 'after_login');

    // ─── STEP 3: Check for wrong-credentials error ────────────────────────────
    // If the URL is still on the identity server, login failed
    if (page.url().includes(OIDC_HOST)) {
      const errorText = await page.textContent('body').catch(() => '');
      const hint = errorText.includes('Invalid') || errorText.includes('incorrect')
        ? 'Invalid SAN username or password'
        : 'Login failed — check credentials';
      return { success: false, durationMs: Date.now() - startTime, error: hint, message: hint };
    }

    // ─── STEP 4: Wait for either the search page OR the WAIT screen ─────────────
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

    // ─── STEP 5: Search by vehicle number ────────────────────────────────────
    // The field placeholder says "Vehicle Dispatch Name" but the actual value
    // entered is the numeric vehicle number (e.g. "4000")
    console.log(`[Bot] ${vehicleNumber} → Searching for vehicle ${vehicleNumber}…`);
    await page.fill('input[placeholder="Vehicle Dispatch Name"]', String(vehicleNumber));
    await page.click('button:has-text("Search")');

    // Wait for one of: Add To Queue button, WAIT screen, or not-found message
    await page.waitForFunction(
      () => document.body.innerText.includes('Add To Queue')      ||
            document.body.innerText.includes('Remove From Queue') ||
            document.body.innerText.includes('not found')         ||
            document.body.innerText.includes('No vehicle')        ||
            document.body.innerText.includes('No results'),
      null,
      { timeout: TIMEOUT }
    );

    // ─── STEP 6: Already queued after search? ────────────────────────────────
    if (await isWaitScreen(page)) {
      const info = await extractQueueInfo(page);
      return { success: true, alreadyQueued: true, ...info, durationMs: Date.now() - startTime,
               message: `Vehicle already in queue at position ${info.position}` };
    }

    // ─── STEP 7: Confirm vehicle was found ───────────────────────────────────
    const addToQueueVisible = await page.isVisible('button:has-text("Add To Queue")').catch(() => false);
    if (!addToQueueVisible) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: `Vehicle "${vehicleNumber}" not found — check vehicle number`,
        message: `Vehicle ${vehicleNumber} not found in SAN eDispatch`
      };
    }

    // ─── STEP 8: Click Add To Queue ───────────────────────────────────────────
    console.log(`[Bot] ${vehicleNumber} → Clicking Add To Queue…`);
    await page.click('button:has-text("Add To Queue")');

    // Wait for WAIT confirmation screen — "Remove From Queue" is unique to this screen
    await page.waitForFunction(
      () => document.body.innerText.includes('Remove From Queue'),
      null,
      { timeout: TIMEOUT }
    );
    console.log(`[Bot] ${vehicleNumber} → ✓ Successfully added to queue!`);

    // ─── STEP 9: Extract queue details ───────────────────────────────────────
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
    // Capture page state at the moment of failure so we can see what the bot was looking at
    if (page) await debugCapture(page, vehicleNumber, 'error');
    const friendly = sanitizeError(err.message);
    return {
      success: false,
      durationMs: Date.now() - startTime,
      error: friendly,
      message: friendly,
      rawError: err.message,   // kept for server logs only, never shown to drivers
    };
  } finally {
    if (browser) await browser.close();
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

module.exports = { addToQueue, sanitizeError };
