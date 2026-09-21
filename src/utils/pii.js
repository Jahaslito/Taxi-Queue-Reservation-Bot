// Shared PII helpers for the insurance module.

/**
 * Mask a driver's-license number for list/display responses: keep the last 3
 * characters, replace the rest with bullets. The full value is only ever served
 * by the audited reveal endpoint. Returns null for empty input, and masks the
 * whole thing (no trailing reveal) for very short values.
 *   "B3057946" → "•••••946"   ""/null → null   "12" → "••"
 */
function maskDl(dl) {
  const s = dl == null ? '' : String(dl).trim();
  if (!s) return null;
  if (s.length <= 3) return '•'.repeat(s.length);
  return '•'.repeat(s.length - 3) + s.slice(-3);
}

module.exports = { maskDl };
