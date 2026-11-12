// Dead-link checker. Each address gets a HEAD request first and a GET when
// HEAD fails (plenty of servers answer HEAD with 404/405/500 while the page is
// fine). Requests carry no cookies, so a check can't log you out of anything or
// act on an account, and the GET body is dropped as soon as headers arrive.
//
// manifest.json sets its own extension_pages CSP on purpose: Firefox's MV3
// default adds `upgrade-insecure-requests`, which silently turns every
// http:// check into https:// and would report http-only sites as dead.

export const DEAD_CATS = {
  notfound: { label: "Not found (404 / 410)", short: "Not found", level: "bad" },
  unreachable: { label: "Site unreachable", short: "Unreachable", level: "bad" },
  home: { label: "Sends you to a home page", short: "Home page", level: "warn" },
  timeout: { label: "Timed out", short: "Timed out", level: "warn" },
  server: { label: "Server error (5xx)", short: "Server error", level: "warn" },
  blocked: { label: "Needs sign-in or blocked the check", short: "Blocked", level: "info" },
  other: { label: "Other error", short: "Error", level: "warn" },
  local: { label: "Local network address", short: "Local", level: "info" },
};
/** Categories ticked for removal by default: the ones that are reliably dead. */
export const PRESELECT_DEAD = new Set(["notfound", "unreachable"]);

export const REDIRECT_KINDS = {
  moved: { label: "Moved to a new address", short: "Moved", level: "info" },
  minor: { label: "Same page, new form (https, www, slash)", short: "https / www / slash", level: "ok" },
  login: { label: "Goes to a sign-in page", short: "Sign-in page", level: "warn" },
};

const RETRY_CATS = new Set(["timeout", "unreachable", "server"]);

export function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Only http(s) addresses without user:password@ can be checked with fetch. */
export function isCheckable(raw) {
  const u = parseUrl(raw);
  return !!u && (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
}

export function hostOf(raw) {
  const u = parseUrl(raw);
  return u ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
}

export function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") && !h.includes(":")) return true; // localhost, intranet names
  if (/\.(local|lan|internal|intranet|home|corp|localhost|home\.arpa)$/.test(h)) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

export function isSkipped(raw, skipHosts) {
  if (!skipHosts || !skipHosts.length) return false;
  const host = hostOf(raw);
  return skipHosts.some((s) => host === s || host.endsWith("." + s));
}

function withoutHash(raw) {
  const u = parseUrl(raw);
  if (!u) return raw;
  u.hash = "";
  return u.href;
}

const LOCALE_ROOT = /^\/(?:[a-z]{2}(?:[-_][a-z]{2,4})?\/?)?$/i;
const LOGIN = /(^|[./_-])(login|log-in|logon|signin|sign-in|sign_in|signon|auth|authorize|authenticate|oauth2?|sso|saml|accounts)([./_?-]|$)/i;

function loose(u) {
  return u.hostname.toLowerCase().replace(/^www\./, "") + (u.port ? ":" + u.port : "")
    + u.pathname.replace(/\/+$/, "") + u.search;
}

export function redirectKind(origRaw, finalRaw) {
  const o = parseUrl(origRaw);
  const f = parseUrl(finalRaw);
  if (!o || !f) return "moved";
  if (loose(o) === loose(f)) return "minor";
  if (LOGIN.test(f.hostname + f.pathname) && !LOGIN.test(o.hostname + o.pathname)) return "login";
  if (LOCALE_ROOT.test(f.pathname) && !f.search && !LOCALE_ROOT.test(o.pathname)) return "home";
  return "moved";
}

export function classify(orig, r) {
  const local = isLocalHost(parseUrl(orig)?.hostname || "");
  if (r.error === "timeout") return { cat: local ? "local" : "timeout" };
  if (r.error) return { cat: local ? "local" : "unreachable", error: r.message || "" };
  const code = r.status;
  if (code === 404 || code === 410) return { cat: "notfound", code };
  if (code === 401 || code === 403 || code === 407 || code === 429 || code === 451 || code === 999) {
    return { cat: "blocked", code };
  }
  if (code >= 500) return { cat: "server", code };
  if (code >= 400 || code === 0) return { cat: "other", code };
  if (r.redirected && r.url && withoutHash(r.url) !== withoutHash(orig)) {
    const kind = redirectKind(orig, r.url);
    if (kind === "home") return { cat: "home", code, finalUrl: r.url };
    return { cat: "redirect", kind, code, finalUrl: r.url };
  }
  return { cat: "ok", code };
}

async function request(url, method, timeoutMs, stopSignal) {
  const t = new AbortController();
  const timer = setTimeout(() => t.abort(), timeoutMs);
  const signal = stopSignal ? AbortSignal.any([t.signal, stopSignal]) : t.signal;
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (res.body) res.body.cancel().catch(() => {});
    return { status: res.status, url: res.url, redirected: res.redirected };
  } catch (e) {
    if (stopSignal && stopSignal.aborted) return { stopped: true };
    if (t.signal.aborted) return { error: "timeout" };
    return { error: "network", message: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Check one address. Resolves to null if the scan was stopped meanwhile. */
export async function checkUrl(url, timeoutMs, stopSignal) {
  let r = await request(url, "HEAD", timeoutMs, stopSignal);
  if (r.stopped) return null;
  let method = "HEAD";
  if (r.error || r.status >= 400 || r.status === 0) {
    const g = await request(url, "GET", timeoutMs, stopSignal);
    if (g.stopped) return null;
    // A GET that couldn't connect says less than a HEAD that got an answer.
    if (!(g.error && !r.error)) {
      r = g;
      method = "GET";
    }
  }
  return { ...classify(url, r), method, at: Date.now() };
}

/** Round-robin by site so one big site doesn't hog every slot. */
function interleave(urls) {
  const byHost = new Map();
  for (const url of urls) {
    const host = hostOf(url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push({ url, host });
  }
  const lanes = [...byHost.values()];
  const out = [];
  for (let i = 0; out.length < urls.length; i++) {
    for (const lane of lanes) if (i < lane.length) out.push(lane[i]);
  }
  return out;
}

/**
 * Runs a whole check: `concurrency` requests at once, at most `perHost` on any
 * one site, then (optionally) one slower retry of links that timed out,
 * couldn't connect or got a 5xx.
 */
export class Scanner {
  constructor({ urls, timeoutMs, concurrency, perHost, retry, onResult, onProgress }) {
    this.urls = urls;
    this.timeoutMs = timeoutMs;
    this.concurrency = Math.max(1, concurrency);
    this.perHost = Math.max(1, perHost);
    this.retry = retry;
    this.onResult = onResult || (() => {});
    this.onProgress = onProgress || (() => {});
    this.ctrl = new AbortController();
    this.paused = false;
    this.stopped = false;
    this.results = new Map();
    this.pump = null;
  }

  async run() {
    await this.pass(this.urls, this.timeoutMs, this.concurrency, "check");
    if (this.retry && !this.stopped) {
      const again = this.urls.filter((u) => RETRY_CATS.has(this.results.get(u)?.cat));
      if (again.length) {
        await this.pass(again, Math.round(this.timeoutMs * 1.5), Math.max(1, Math.ceil(this.concurrency / 2)), "retry");
      }
    }
    return { stopped: this.stopped };
  }

  pass(list, timeoutMs, concurrency, phase) {
    const queue = interleave(list);
    const busy = new Map();
    let active = 0;
    let done = 0;
    this.onProgress({ phase, done, total: list.length });
    return new Promise((resolve) => {
      const pump = () => {
        if (this.stopped) {
          if (!active) resolve();
          return;
        }
        while (!this.paused && active < concurrency && queue.length) {
          const i = queue.findIndex((x) => (busy.get(x.host) || 0) < this.perHost);
          if (i < 0) break;
          const [item] = queue.splice(i, 1);
          active++;
          busy.set(item.host, (busy.get(item.host) || 0) + 1);
          checkUrl(item.url, timeoutMs, this.ctrl.signal)
            .then((res) => {
              if (res && !this.stopped) {
                this.results.set(item.url, res);
                this.onResult(item.url, res, phase);
              }
            }, () => {})
            .finally(() => {
              active--;
              busy.set(item.host, busy.get(item.host) - 1);
              done++;
              if (!this.stopped) this.onProgress({ phase, done, total: list.length });
              pump();
            });
        }
        if (!active && !queue.length) resolve();
      };
      this.pump = pump;
      pump();
    });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    if (this.pump) this.pump();
  }

  stop() {
    this.stopped = true;
    this.ctrl.abort();
    if (this.pump) this.pump();
  }
}
