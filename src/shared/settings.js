// Settings shared by the cleaner page and the popup. Everything lives in
// browser.storage.local and never leaves this browser.

export const DEFAULTS = {
  timeout: 15, // seconds to wait for each site
  concurrency: 8, // links checked at the same time
  perHost: 2, // at most this many at once on one site, to be polite
  retry: true, // re-check timeouts / unreachable / 5xx once at the end
  skipHosts: [], // sites never contacted during a link check
  dupScheme: true, // http:// and https:// are the same page
  dupWww: true, // www.example.com and example.com are the same site
  dupSlash: true, // /page and /page/ are the same page
  dupTracking: true, // ignore utm_*, fbclid, gclid and similar tracking parameters
  dupHash: false, // ignore #fragments (off: page#a and page#b stay different)
};

export async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

export function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function parseHosts(text) {
  return Array.from(new Set(
    String(text || "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
      .filter(Boolean),
  ));
}
