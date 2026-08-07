// SAN session-vs-IP test. Run from the repo root (proxy creds come from ./.env):
//   export SAN_TEST_USER='Nur4007'
//   export SAN_TEST_PASS='<the password>'
//   node san-ip-test.js
//
// Logs the driver into SAN through proxy IP-A, then reuses that session through a
// DIFFERENT proxy IP-B, and reports whether SAN keeps the session valid. READ-ONLY
// (no queue add/remove). Uses the rotating gateway :7000 directly, so a wrong
// PROXY_SERVER port in .env doesn't matter here.
require('dotenv').config();
const { chromium } = require('playwright');
const crypto = require('crypto');

const SAN_URL = 'https://san.gtcvms.com/gsidispatch.edispatch';
const OIDC    = 'san.gtcvms.com/GsiIdentityServer';
const APP     = 'gsidispatch.edispatch';
const PROXY   = 'http://gate.decodo.com:7000';

const puser = () => (process.env.PROXY_USERNAME || '').replace('{session}', crypto.randomBytes(8).toString('hex'));
const ppass = process.env.PROXY_PASSWORD || '';
const U = process.env.SAN_TEST_USER, P = process.env.SAN_TEST_PASS;

if (!process.env.PROXY_USERNAME) { console.error('PROXY_USERNAME not in .env'); process.exit(1); }
if (!U || !P) { console.error('Set SAN_TEST_USER and SAN_TEST_PASS env vars first.'); process.exit(1); }

const readIp = async (page) => {
  await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 20000 });
  return JSON.parse(await page.evaluate(() => document.body.innerText)).ip;
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  // ── Context A: log in through proxy IP-A ──
  const ctxA = await browser.newContext({ proxy: { server: PROXY, username: puser(), password: ppass } });
  const pA = await ctxA.newPage();
  const ipA = await readIp(pA);
  await pA.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pA.waitForURL(u => u.href.includes(APP) || u.href.includes(OIDC), { timeout: 60000 });
  if (pA.url().includes(OIDC)) {
    await pA.waitForSelector('input[placeholder="Enter Username"]', { timeout: 60000 });
    await pA.fill('input[placeholder="Enter Username"]', U);
    await pA.fill('input[placeholder="Enter Password"]', P);
    await pA.click('button:has-text("Log In")');
    const w = await Promise.race([
      pA.waitForURL(`**/${APP}/**`, { timeout: 60000 }).then(() => 'ok'),
      pA.locator('text=/Invalid username or password/i').first().waitFor({ state: 'visible', timeout: 60000 }).then(() => 'bad'),
    ]).catch(() => 'err');
    if (w !== 'ok') { console.log(`LOGIN did not succeed (${w}) — check creds/proxy.`); await browser.close(); process.exit(1); }
  }
  const state = await ctxA.storageState();
  await ctxA.close();

  // ── Context B: reuse the SAME session through a DIFFERENT proxy IP ──
  const ctxB = await browser.newContext({ proxy: { server: PROXY, username: puser(), password: ppass }, storageState: state });
  const pB = await ctxB.newPage();
  const ipB = await readIp(pB);
  await pB.goto(SAN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pB.waitForTimeout(3000); // let any re-auth redirect happen
  const onLogin = await pB.locator('input[placeholder="Enter Username"]').isVisible().catch(() => false);
  await browser.close();

  console.log('\n=== RESULT ===');
  console.log(`IP-A (login): ${ipA}   IP-B (reuse): ${ipB}   different IPs: ${ipA !== ipB}`);
  if (ipA === ipB) { console.log('~ both IPs were the same — inconclusive, run again.'); }
  else console.log(onLogin
    ? '✗ session REJECTED on the new IP → SAN binds sessions to IP → we NEED sticky sessions.'
    : '✓ session SURVIVED the IP change → SAN does NOT bind sessions to IP → per-driver stickiness does NOT matter.');
  process.exit(0);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
