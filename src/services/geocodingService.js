'use strict';

// ─── Geocoding Service ────────────────────────────────────────────────────────
// Reverse-geocodes lat/lng → human-readable place name using OpenStreetMap
// Nominatim (free, no API key). Server-side only — calling from the browser
// would require relaxing the app's CSP and would leak driver location to a
// third party from the user's device, which we'd rather not do.
//
// Nominatim ToS notes:
//   • Max 1 request/second per source IP. We're well under that — only fires
//     on a new SOS or when a driver's coords cross our cache cell.
//   • Requires a unique User-Agent identifying the app + a contact address.
//   • Heavy users (>tens of thousands of req/day) should self-host. We won't
//     get anywhere near that for an emergency feature.
//
// Cache:
//   • Keyed by `lat.toFixed(4),lng.toFixed(4)` (~11 m precision) — collapses
//     repeated calls when live tracking ticks at the same intersection.
//   • In-memory only. SOS volume is too low to bother persisting.
//   • Capped at MAX_CACHE entries; oldest evicted first.

const { fetch: ufetch } = require('undici');

const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const MAX_CACHE     = 500;
const FETCH_TIMEOUT = 6000;
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse';

// Nominatim asks for a UA that identifies the app + a contact.
const USER_AGENT = `SAN-Queue-SOS/1.0 (${process.env.VAPID_SUBJECT || 'admin@sanqueue.com'})`;

const cache = new Map(); // key → { name, ts }

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.name;
}

function cacheSet(key, name) {
  if (cache.size >= MAX_CACHE) {
    // Drop the oldest entry (Map iteration is insertion-ordered).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { name, ts: Date.now() });
}

/**
 * Build a short, human-readable label from Nominatim's response. We prefer
 * the first 3 comma-separated segments of display_name — that usually yields
 * something like "Tom Mboya St, CBD, Nairobi" rather than a 90-char string.
 */
function shortenDisplayName(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.slice(0, 3).join(', ');
}

/**
 * @returns {Promise<string|null>} human-readable place name, or null on failure.
 */
async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;
  const key = cacheKey(lat, lng);
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=16&addressdetails=0`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  let json;
  try {
    const res = await ufetch(url, {
      headers: {
        'User-Agent':      USER_AGENT,
        'Accept':          'application/json',
        'Accept-Language': 'en',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[Geocode] Nominatim ${res.status} for ${key}`);
      return null;
    }
    json = await res.json();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn(`[Geocode] Lookup failed for ${key}:`, err.message);
    }
    return null;
  } finally {
    clearTimeout(t);
  }

  const name = shortenDisplayName(json?.display_name) || json?.name || null;
  if (name) cacheSet(key, name);
  return name;
}

module.exports = { reverseGeocode };
