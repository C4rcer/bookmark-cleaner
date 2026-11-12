import { wireSupportLinks, maybeShowMilestone } from "../shared/support.js";
import { clampInt, getSettings, parseHosts, saveSettings } from "../shared/settings.js";
import {
  REMOVED_TITLE, emptyRemoved, findDuplicates, findEmptyFolders, formatPath, getHistory, moveToRemoved,
  restoreOne, snapshot, undo, updateUrls,
} from "../shared/bookmarks.js";
import {
  DEAD_CATS, PRESELECT_DEAD, REDIRECT_KINDS, Scanner, isCheckable, isSkipped, parseUrl,
} from "./checker.js";

const $ = (id) => document.getElementById(id);
const TABS = ["dead", "redirects", "dupes", "empty", "removed", "settings"];
const LIST_TABS = ["dead", "redirects", "dupes", "empty"];
const PAGE = 200;
const MILESTONES = [100, 1000, 5000];
const ALL_URLS = { origins: ["<all_urls>"] };
const per = (keys, fn) => Object.fromEntries(keys.map((k) => [k, fn(k)]));

const st = {
  settings: null,
  snap: null,
  results: {}, // url -> check result
  scan: null, // { startedAt, finishedAt, total }
  history: [],
  dupes: [],
  tab: "dead",
  scanner: null,
  progress: null,
  dirty: false,
  busy: false,
  items: per(LIST_TABS, () => []),
  sel: per(LIST_TABS, () => new Set()),
  seen: per(LIST_TABS, () => new Set()),
  filter: per(LIST_TABS, () => "all"),
  query: per(LIST_TABS, () => ""),
  limit: per(LIST_TABS, () => PAGE),
  ui: {}, // toolbar controls, built once
  pui: {}, // progress display while a check runs
};

// ---------------------------------------------------------------- small helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "checked" || k === "value" || k === "indeterminate") el[k] = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** replaceChildren / append that flatten arrays and skip null (the DOM would print "null"). */
const clean = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false);
const put = (el, ...kids) => el.replaceChildren(...clean(kids));
const add = (el, ...kids) => el.append(...clean(kids));

const fmt = (n) => Number(n).toLocaleString();
function plural(n, one, many = one + "s") {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}
function fmtDate(t) {
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function fmtDay(t) {
  return t ? new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDay(t);
}

function urlLink(url, cls = "url") {
  const u = parseUrl(url);
  const web = u && (u.protocol === "http:" || u.protocol === "https:");
  return web
    ? h("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer", title: url }, url)
    : h("span", { class: cls, title: url }, url);
}

function badge(info, extra) {
  return h("span", { class: "badge " + (info.level || "info") }, info.short + (extra ? ` · ${extra}` : ""));
}

// ---------------------------------------------------------------- derived state

function compute() {
  const dead = [];
  const redirects = [];
  for (const b of st.snap.bookmarks) {
    const r = st.results[b.url];
    if (!r) continue;
    if (DEAD_CATS[r.cat]) dead.push({ id: b.id, b, r, cat: r.cat });
    else if (r.cat === "redirect") redirects.push({ id: b.id, b, r, cat: r.kind });
  }
  st.items.dead = dead;
  st.items.redirects = redirects;
  st.dupes = findDuplicates(st.snap.bookmarks, st.settings);
  st.items.dupes = st.dupes.flatMap((g) => g.items.map((b, i) => ({ id: b.id, b, g, i, cat: g.exact ? "exact" : "similar" })));
  st.items.empty = findEmptyFolders(st.snap).map((f) => ({ id: f.id, b: f, cat: "folder" }));

  // New items get their default tick; items that left the list lose theirs.
  for (const t of LIST_TABS) {
    const ids = new Set();
    for (const it of st.items[t]) {
      ids.add(it.id);
      const key = t === "dupes" ? `${it.id}|${it.g.key}|${it.g.items[0].id}` : `${it.id}|${it.cat}`;
      if (st.seen[t].has(key)) continue;
      st.seen[t].add(key);
      if (defaultOn(t, it)) st.sel[t].add(it.id);
      else st.sel[t].delete(it.id);
    }
    for (const id of [...st.sel[t]]) if (!ids.has(id)) st.sel[t].delete(id);
  }
}

function defaultOn(t, it) {
  if (t === "dead") return PRESELECT_DEAD.has(it.cat);
  if (t === "redirects") return it.cat !== "login";
  if (t === "dupes") return it.i > 0;
  return true;
}

function matches(b, q, extra = "") {
  return (b.title || "").toLowerCase().includes(q)
    || (b.url || "").toLowerCase().includes(q)
    || formatPath(b.path).toLowerCase().includes(q)
    || extra.toLowerCase().includes(q);
}

function visibleGroups() {
  const f = st.filter.dupes;
  const q = st.query.dupes.trim().toLowerCase();
  return st.dupes.filter((g) => (f === "all" || (f === "exact") === g.exact) && (!q || g.items.some((b) => matches(b, q))));
}

function visible(t) {
  if (t === "dupes") {
    const keys = new Set(visibleGroups().map((g) => g.key));
    return st.items.dupes.filter((it) => keys.has(it.g.key));
  }
  const f = st.filter[t];
  const q = st.query[t].trim().toLowerCase();
  return st.items[t].filter((it) => (f === "all" || it.cat === f) && (!q || matches(it.b, q, it.r?.finalUrl || "")));
}

function selectedVisible(t) {
  return visible(t).filter((it) => st.sel[t].has(it.id));
}

function extraCopies() {
  return st.dupes.reduce((n, g) => n + g.items.length - 1, 0);
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!st.snap) return;
  const nb = st.snap.bookmarks.length;
  $("libStats").textContent = `${plural(nb, "bookmark")} in ${plural(st.snap.folders.length, "folder")}`;
  for (const b of document.querySelectorAll(".tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === st.tab));
  }
  for (const t of TABS) $("panel-" + t).hidden = t !== st.tab;
  const checked = !!st.scan;
  setCount("dead", checked ? st.items.dead.length : "");
  setCount("redirects", checked ? st.items.redirects.length : "");
  setCount("dupes", extraCopies());
  setCount("empty", st.items.empty.length);
  setCount("removed", st.snap.removedItems.length || "");
  renderPanel();
  updateActionBar();
}

function setCount(t, n) {
  const el = $("count-" + t);
  el.textContent = n === "" ? "" : fmt(n);
  el.classList.toggle("hot", n !== "" && n > 0 && t !== "removed");
}

function renderPanel() {
  const t = st.tab;
  if (t === "dead") {
    renderScanBox();
    renderList("dead");
  } else if (t === "redirects") {
    renderIntroRedirects();
    renderList("redirects");
  } else if (t === "dupes") {
    renderIntroDupes();
    renderList("dupes");
  } else if (t === "empty") {
    renderIntroEmpty();
    renderList("empty");
  } else if (t === "removed") {
    renderRemoved();
  } else if (t === "settings") {
    renderSettings();
  }
}

function checkableUrls() {
  const s = st.settings;
  const all = new Set();
  let other = 0;
  let skipped = 0;
  for (const b of st.snap.bookmarks) {
    if (!isCheckable(b.url)) other++;
    else if (isSkipped(b.url, s.skipHosts)) skipped++;
    else all.add(b.url);
  }
  return { urls: [...all], other, skipped };
}

function leftOutNote(other, skipped) {
  const bits = [];
  if (other) bits.push(`${plural(other, "bookmark")} that aren't web links (place:, javascript:, file: and the like)`);
  if (skipped) bits.push(`${plural(skipped, "bookmark")} on sites you asked Prune not to contact`);
  return bits.length ? `Left out: ${bits.join(" and ")}.` : "";
}

function renderScanBox() {
  const box = $("scanBox");
  const { urls, other, skipped } = checkableUrls();
  const note = leftOutNote(other, skipped);
  box.replaceChildren();
  if (st.scanner) {
    const bar = h("div");
    const status = h("span", { class: "scan-status" });
    const title = h("h2");
    const sub = h("p");
    const pause = h("button", { type: "button", class: "btn", id: "btnPause" }, st.scanner.paused ? "Resume" : "Pause");
    pause.addEventListener("click", () => {
      if (!st.scanner) return;
      if (st.scanner.paused) st.scanner.resume();
      else st.scanner.pause();
      pause.textContent = st.scanner.paused ? "Resume" : "Pause";
      updateProgress();
    });
    const stop = h("button", { type: "button", class: "btn", id: "btnStop" }, "Stop");
    stop.addEventListener("click", () => st.scanner && st.scanner.stop());
    add(box, title, h("div", { class: "scan-row" }, h("div", { class: "progress" }, bar), status, pause, stop), sub);
    st.pui = { bar, status, title, sub };
    updateProgress();
    return;
  }
  st.pui = {};
  if (!st.scan) {
    add(box, 
      h("h2", null, "Find bookmarks that no longer work"),
      h("p", null, "Prune visits each bookmarked address once, the way a browser would but without your cookies, so a check can't sign you out or change anything on a site. "
        + "Firefox will ask you to let Prune access websites: it is only used for this check, and you can remove it again in Settings."),
      note ? h("p", null, note) : null,
      h("div", { class: "scan-row" },
        h("button", { type: "button", class: "btn primary", id: "btnScan", onclick: () => onCheckClick("new"), disabled: !urls.length },
          urls.length ? `Check ${plural(urls.length, "link")}` : "No links to check")),
    );
    return;
  }
  const done = Object.keys(st.results).length;
  if (!st.scan.finishedAt) {
    const fresh = urls.filter((u) => st.results[u] && st.results[u].at >= st.scan.startedAt).length;
    add(box, 
      h("h2", null, "The last link check was stopped"),
      h("p", null, `It got through ${fmt(fresh)} of ${fmt(urls.length)} links. Results so far are below.`),
      h("div", { class: "scan-row" },
        h("button", { type: "button", class: "btn primary", id: "btnContinue", onclick: () => onCheckClick("continue") }, `Check the other ${fmt(Math.max(0, urls.length - fresh))}`),
        h("button", { type: "button", class: "btn", id: "btnRestart", onclick: () => onCheckClick("new") }, "Start over")),
    );
    return;
  }
  const problems = st.items.dead.length;
  add(box, 
    h("h2", null, problems ? `${plural(problems, "link")} need a look` : "No dead links found"),
    h("p", null, `Checked ${plural(done, "address", "addresses")} on ${fmtDate(st.scan.finishedAt)}. `
      + (problems ? "The ones that are clearly gone are ticked; the rest are worth a quick look before removing." : "")
      + (note ? " " + note : "")),
    h("div", { class: "scan-row" },
      h("button", { type: "button", class: "btn", id: "btnScan", onclick: () => onCheckClick("new"), disabled: !urls.length }, "Check again")),
  );
}

function updateProgress() {
  const p = st.progress;
  const ui = st.pui;
  if (!p || !ui.bar) return;
  const retry = p.phase === "retry";
  const base = retry ? 0 : p.base || 0;
  const total = retry ? p.total : (p.only ? p.total : p.base + p.total);
  const done = base + p.done;
  ui.bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
  ui.status.textContent = `${fmt(done)} of ${fmt(total)}`;
  const paused = st.scanner && st.scanner.paused;
  ui.title.textContent = paused ? "Paused" : retry ? "Checking slow and failed links once more" : "Checking links";
  const problems = st.items.dead.length;
  ui.sub.textContent = `${plural(problems, "problem")} so far. Keep this tab open while Prune works; you can use other tabs meanwhile.`;
}

function renderChips(t) {
  const box = st.ui["chips-" + t] || $("toolbar-" + t).querySelector(".chips");
  if (!box) return;
  const counts = new Map();
  if (t === "dupes") {
    for (const g of st.dupes) counts.set(g.exact ? "exact" : "similar", (counts.get(g.exact ? "exact" : "similar") || 0) + 1);
  } else {
    for (const it of st.items[t]) counts.set(it.cat, (counts.get(it.cat) || 0) + 1);
  }
  const defs = t === "dead" ? DEAD_CATS
    : t === "redirects" ? REDIRECT_KINDS
      : t === "dupes" ? { exact: { short: "Exact copies" }, similar: { short: "Same page, different address" } }
        : {};
  const total = t === "dupes" ? st.dupes.length : st.items[t].length;
  if (st.filter[t] !== "all" && !counts.get(st.filter[t])) st.filter[t] = "all";
  const chip = (key, label, n, title) => h("button", {
    type: "button", class: "chip" + (st.filter[t] === key ? " on" : ""), dataset: { filter: key }, title,
    onclick: () => { st.filter[t] = key; st.limit[t] = PAGE; renderList(t); updateActionBar(); },
  }, label, h("b", null, fmt(n)));
  put(box,
    Object.keys(defs).length ? chip("all", t === "dupes" ? "All groups" : "All", total) : null,
    Object.entries(defs).filter(([k]) => counts.get(k)).map(([k, d]) => chip(k, d.short, counts.get(k), d.label)),
  );
}

function renderList(t) {
  renderChips(t);
  const list = $("list-" + t);
  list.replaceChildren();
  const toolbar = $("toolbar-" + t);
  toolbar.hidden = st.items[t].length === 0;
  if (!st.items[t].length) {
    const msg = {
      dead: st.scan && st.scan.finishedAt ? "Every link that was checked answered. Nothing to clean here." : null,
      redirects: st.scan ? "No redirects found among the links checked so far." : null,
      dupes: "No duplicate bookmarks. Each page is bookmarked once.",
      empty: "No empty folders.",
    }[t];
    if (msg) add(list, h("div", { class: "empty-note" }, msg));
    return;
  }
  const vis = visible(t);
  const selAll = st.ui["selall-" + t];
  if (selAll) {
    const n = vis.filter((it) => st.sel[t].has(it.id)).length;
    selAll.checked = vis.length > 0 && n === vis.length;
    selAll.indeterminate = n > 0 && n < vis.length;
  }
  if (!vis.length) {
    add(list, h("div", { class: "empty-note" }, "Nothing matches this filter."));
    return;
  }
  if (t === "dupes") {
    let shown = 0;
    for (const g of visibleGroups()) {
      if (shown >= st.limit.dupes) break;
      add(list, groupEl(g));
      shown += g.items.length;
    }
    if (shown < vis.length) add(list, moreBtn(t, vis.length - shown));
    return;
  }
  for (const it of vis.slice(0, st.limit[t])) add(list, rowEl(t, it));
  if (vis.length > st.limit[t]) add(list, moreBtn(t, vis.length - st.limit[t]));
}

function moreBtn(t, left) {
  return h("button", {
    type: "button", class: "more", onclick: () => { st.limit[t] += PAGE; renderList(t); },
  }, `Show more (${fmt(left)} left)`);
}

function checkbox(t, it) {
  const cb = h("input", {
    type: "checkbox", checked: st.sel[t].has(it.id), "aria-label": "Select " + (it.b.title || it.b.url || "item"),
  });
  cb.addEventListener("change", () => {
    if (cb.checked) st.sel[t].add(it.id);
    else st.sel[t].delete(it.id);
    if (t === "dupes") renderList("dupes");
    else {
      const selAll = st.ui["selall-" + t];
      if (selAll) {
        const vis = visible(t);
        const n = vis.filter((x) => st.sel[t].has(x.id)).length;
        selAll.checked = n === vis.length;
        selAll.indeterminate = n > 0 && n < vis.length;
      }
    }
    updateActionBar();
  });
  return cb;
}

function rowEl(t, it) {
  const b = it.b;
  let main;
  let side;
  if (t === "dead") {
    const r = it.r;
    const code = r.code >= 400 ? String(r.code) : "";
    main = [h("div", { class: "title" }, b.title || "(no title)"), urlLink(b.url),
      r.cat === "home" && r.finalUrl ? urlLink(r.finalUrl, "url-new") : null];
    side = badge(DEAD_CATS[r.cat], code);
  } else if (t === "redirects") {
    main = [h("div", { class: "title" }, b.title || "(no title)"), urlLink(b.url), urlLink(it.r.finalUrl, "url-new")];
    side = badge(REDIRECT_KINDS[it.cat] || REDIRECT_KINDS.moved);
  } else if (t === "empty") {
    const bits = [];
    if (b.subfolders) bits.push(`holds ${plural(b.subfolders, "empty subfolder")}`);
    if (b.separators) bits.push(plural(b.separators, "separator"));
    main = [h("div", { class: "title folder" }, b.title || "(untitled folder)"),
      h("div", { class: "meta" }, bits.length ? `Empty: ${bits.join(", ")}` : "Empty")];
    side = h("span", { class: "meta" }, b.dateAdded ? `created ${fmtDay(b.dateAdded)}` : "");
  }
  return h("div", { class: "row-item", dataset: { id: it.id } },
    checkbox(t, it),
    h("div", { class: "main" }, main),
    h("div", { class: "where", title: formatPath(b.path) }, formatPath(b.path)),
    side);
}

function groupEl(g) {
  const sel = st.sel.dupes;
  const all = g.items.every((b) => sel.has(b.id));
  const head = h("div", { class: "group-head" },
    h("span", null, `${g.items.length} copies`),
    h("span", { class: "key", title: g.items[0].url }, g.exact ? g.items[0].url : g.key.replace(/^\/\//, "")),
    all ? h("span", { class: "warnText" }, "Every copy is ticked: none would be left") : null);
  const rows = g.items.map((b, i) => {
    const it = { id: b.id, b, g, i };
    const on = sel.has(b.id);
    return h("div", { class: "row-item", dataset: { id: b.id } },
      checkbox("dupes", it),
      h("div", { class: "main" }, h("div", { class: "title" }, b.title || "(no title)"), urlLink(b.url),
        h("div", { class: "meta" }, b.dateAdded ? `added ${fmtDay(b.dateAdded)}` : "")),
      h("div", { class: "where", title: formatPath(b.path) }, formatPath(b.path)),
      on ? h("span", { class: "badge bad" }, "Remove") : h("span", { class: "badge ok" }, "Keep"));
  });
  return h("div", { class: "group", dataset: { key: g.key } }, head, rows);
}

function renderIntroRedirects() {
  const box = $("intro-redirects");
  box.replaceChildren();
  if (!st.scan) {
    add(box, h("h2", null, "Bookmarks that moved"),
      h("p", null, "After a link check, bookmarks whose site now sends you somewhere else show up here, so you can point them straight at the new address."),
      h("button", { type: "button", class: "btn primary", onclick: () => onCheckClick("new") }, "Check links"));
    return;
  }
  if (!st.items.redirects.length) return;
  add(box, h("p", null, "These still work but the site now forwards them to a new address. Updating keeps the title and folder and only changes the address. "
    + "Redirects to a sign-in page are not ticked: those usually mean the page needs you to be signed in, not that it moved."));
}

function renderIntroDupes() {
  const box = $("intro-dupes");
  box.replaceChildren();
  if (!st.dupes.length) return;
  add(box, h("p", null, `${plural(st.dupes.length, "page")} bookmarked more than once (${plural(extraCopies(), "extra copy", "extra copies")}). `
    + "The oldest copy of each is kept and the others are ticked; tick or untick to choose differently. Addresses are compared ignoring http/https, www, a trailing slash and tracking parameters (change this in Settings)."));
}

function renderIntroEmpty() {
  const box = $("intro-empty");
  box.replaceChildren();
  if (!st.items.empty.length) return;
  add(box, h("p", null, "Folders with no bookmarks in them. A folder that only holds other empty folders (or separators) counts as empty too, and is listed once."));
}

function renderRemoved() {
  const snap = st.snap;
  const intro = $("intro-removed");
  const list = $("list-removed");
  intro.replaceChildren();
  list.replaceChildren();
  const items = snap.removedItems;
  if (!items.length) {
    add(intro, h("h2", null, "Nothing in the Removed folder"),
      h("p", null, `When you remove something, Prune moves it into a folder called "${REMOVED_TITLE}" in Other Bookmarks instead of deleting it. `
        + "You can put things back from here, or empty the folder once you're sure."));
  } else {
    add(intro, 
      h("h2", null, `${plural(snap.removedCount, "bookmark")} in "${REMOVED_TITLE}"`),
      h("p", null, "This folder is in Other Bookmarks. Nothing in it is deleted until you empty it, and Prune never empties it on its own."),
      h("div", { class: "scan-row" },
        h("button", { type: "button", class: "btn danger", id: "btnEmptyRemoved", onclick: onEmptyRemoved, disabled: st.busy }, "Empty this folder permanently")),
    );
    const origin = new Map();
    for (const e of [...st.history].reverse()) {
      if (e.kind !== "remove" || e.undone || e.gone) continue;
      for (const it of e.items) origin.set(it.id, it);
    }
    for (const rec of items.slice(0, 500)) {
      const o = origin.get(rec.id);
      const parent = o && snap.nodes.get(o.parentId);
      const from = parent ? formatPath([...parent.path, parent.title]) : "";
      const isFolder = rec.type === "folder";
      add(list, h("div", { class: "row-item no-cb", dataset: { id: rec.id } },
        h("div", { class: "main" },
          h("div", { class: "title" + (isFolder ? " folder" : "") }, rec.title || (isFolder ? "(untitled folder)" : "(no title)")),
          rec.url ? urlLink(rec.url) : null),
        h("div", { class: "where", title: from }, from ? `from ${from}` : ""),
        h("button", { type: "button", class: "btn small", onclick: () => onRestore(rec.id), disabled: st.busy }, "Put back")));
    }
    if (items.length > 500) add(list, h("div", { class: "empty-note" }, `and ${fmt(items.length - 500)} more`));
  }

  const hist = $("list-history");
  hist.replaceChildren();
  if (!st.history.length) {
    add(hist, h("div", { class: "empty-note" }, "Changes you make with Prune are listed here, each with an Undo button."));
    return;
  }
  for (const e of st.history.slice(0, 20)) {
    const can = !e.undone && !e.gone;
    add(hist, h("div", { class: "hist" },
      h("span", { class: "what" }, e.label),
      h("span", { class: "when", title: fmtDate(e.at) }, ago(e.at)),
      can ? h("button", { type: "button", class: "btn small", onclick: () => onUndo(e), disabled: st.busy }, "Undo")
        : h("span", { class: "meta" }, e.undone ? "Undone" : "Deleted for good")));
  }
}

async function renderSettings() {
  const s = st.settings;
  $("timeout").value = s.timeout;
  $("concurrency").value = s.concurrency;
  $("retry").checked = !!s.retry;
  if (document.activeElement !== $("skipHosts")) $("skipHosts").value = s.skipHosts.join("\n");
  for (const k of ["dupScheme", "dupWww", "dupSlash", "dupTracking", "dupHash"]) $(k).checked = !!s[k];
  const granted = await browser.permissions.contains(ALL_URLS).catch(() => false);
  $("accessNote").textContent = granted
    ? "Allowed. Prune uses it only while checking links."
    : "Not allowed right now. Prune asks for it when you start a link check.";
  $("revokeAccess").disabled = !granted;
  const n = Object.keys(st.results).length;
  $("resultsNote").textContent = n
    ? `${plural(n, "address", "addresses")} from the check on ${fmtDate(st.scan?.finishedAt || st.scan?.startedAt || Date.now())}`
    : "None saved.";
  $("forgetResults").disabled = !n || !!st.scanner;
}

function updateActionBar() {
  const t = st.tab;
  const bar = $("actionBar");
  if (!LIST_TABS.includes(t) || !st.items[t].length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const sel = selectedVisible(t);
  const n = sel.length;
  const total = visible(t).length;
  $("selInfo").textContent = `${fmt(n)} of ${fmt(total)} selected`;
  const prim = $("actPrimary");
  const sec = $("actSecondary");
  sec.hidden = true;
  prim.className = "btn primary";
  if (t === "dead") {
    prim.textContent = `Move ${plural(n, "bookmark")} to Removed`;
    sec.hidden = false;
    sec.textContent = `Check ${fmt(n)} again`;
    sec.disabled = !n || !!st.scanner || st.busy;
  } else if (t === "redirects") {
    prim.textContent = `Update ${plural(n, "bookmark")} to the new address`;
    sec.hidden = false;
    sec.textContent = `Move ${fmt(n)} to Removed`;
    sec.disabled = !n || st.busy;
  } else if (t === "dupes") {
    prim.textContent = `Move ${plural(n, "copy", "copies")} to Removed`;
  } else if (t === "empty") {
    prim.textContent = `Move ${plural(n, "empty folder")} to Removed`;
  }
  prim.disabled = !n || st.busy;
}

// ---------------------------------------------------------------- toolbars (built once)

function buildToolbars() {
  for (const t of LIST_TABS) {
    const bar = $("toolbar-" + t);
    const chips = h("div", { class: "chips toolbar" });
    chips.style.margin = "0";
    st.ui["chips-" + t] = chips;
    let selCtl;
    if (t === "dupes") {
      selCtl = [
        h("button", {
          type: "button", class: "link-btn small", id: "dupesSuggest",
          onclick: () => {
            for (const it of visible("dupes")) {
              if (it.i > 0) st.sel.dupes.add(it.id);
              else st.sel.dupes.delete(it.id);
            }
            renderList("dupes");
            updateActionBar();
          },
        }, "Keep oldest, tick the rest"),
        h("button", {
          type: "button", class: "link-btn small", id: "dupesNone",
          onclick: () => {
            for (const it of visible("dupes")) st.sel.dupes.delete(it.id);
            renderList("dupes");
            updateActionBar();
          },
        }, "Untick all"),
      ];
    } else {
      const cb = h("input", { type: "checkbox", id: "selall-" + t });
      cb.addEventListener("change", () => {
        for (const it of visible(t)) {
          if (cb.checked) st.sel[t].add(it.id);
          else st.sel[t].delete(it.id);
        }
        renderList(t);
        updateActionBar();
      });
      st.ui["selall-" + t] = cb;
      selCtl = h("label", { class: "selall" }, cb, "All shown");
    }
    const search = h("input", { type: "search", class: "search", placeholder: "Filter by title, address or folder", "aria-label": "Filter" });
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        st.query[t] = search.value;
        st.limit[t] = PAGE;
        renderList(t);
        updateActionBar();
      }, 150);
    });
    put(bar, selCtl, chips, search);
  }
}

// ---------------------------------------------------------------- dialogs + toast

function confirmDialog({ title, body, ok, danger }) {
  const d = $("confirm");
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  const okBtn = $("confirmOk");
  okBtn.textContent = ok;
  okBtn.className = "btn primary" + (danger ? " danger" : "");
  return new Promise((resolve) => {
    const finish = (v) => {
      okBtn.onclick = null;
      $("confirmCancel").onclick = null;
      d.oncancel = null;
      if (d.open) d.close();
      resolve(v);
    };
    okBtn.onclick = () => finish(true);
    $("confirmCancel").onclick = () => finish(false);
    d.oncancel = () => finish(false);
    d.showModal();
    $("confirmCancel").focus();
  });
}

function hideToast() {
  $("toast").hidden = true;
}

function toast(text, entry) {
  $("toastText").textContent = text;
  const btn = $("toastUndo");
  btn.hidden = !entry;
  btn.onclick = entry ? () => { hideToast(); onUndo(entry); } : null;
  $("toast").hidden = false;
  clearTimeout(st.toastTimer);
  st.toastTimer = setTimeout(hideToast, entry ? 15000 : 5000);
}

async function busy(fn) {
  st.busy = true;
  updateActionBar();
  try {
    return await fn();
  } finally {
    st.busy = false;
    await refresh();
  }
}

async function showMilestone() {
  const { stats } = await browser.storage.local.get("stats");
  const cleaned = (stats && stats.cleaned) || 0;
  await maybeShowMilestone($("supportCard"), cleaned, MILESTONES, (m) =>
    `Prune has tidied up ${fmt(m)} bookmarks for you so far. It's free, with no ads and no tracking. If that was worth a coffee, tips keep it maintained.`);
}

// ---------------------------------------------------------------- actions

const LABELS = {
  dead: (n) => `Moved ${plural(n, "dead link")} to Removed`,
  redirects: (n) => `Moved ${plural(n, "redirected link")} to Removed`,
  dupes: (n) => `Moved ${plural(n, "duplicate copy", "duplicate copies")} to Removed`,
  empty: (n) => `Moved ${plural(n, "empty folder")} to Removed`,
};

async function onRemove(t) {
  const items = selectedVisible(t);
  if (!items.length || st.busy) return;
  const n = items.length;
  const noun = t === "empty" ? plural(n, "empty folder") : t === "dupes" ? plural(n, "duplicate copy", "duplicate copies") : plural(n, "bookmark");
  const ok = await confirmDialog({
    title: `Move ${noun} to "${REMOVED_TITLE}"?`,
    body: `They go into Other Bookmarks › ${REMOVED_TITLE}. Nothing is deleted: you can undo this, or put items back one at a time, until you empty that folder.`,
    ok: `Move ${noun}`,
  });
  if (!ok) return;
  let entry = null;
  await busy(async () => {
    entry = await moveToRemoved(items.map((it) => it.id), LABELS[t](n));
  });
  if (entry) {
    toast(`Moved ${plural(entry.items.length, t === "empty" ? "folder" : "item")} to "${REMOVED_TITLE}".`, entry);
    showMilestone();
  }
}

function finalWithHash(orig, final) {
  const o = parseUrl(orig);
  const f = parseUrl(final);
  if (!o || !f) return final;
  if (!f.hash && o.hash) f.hash = o.hash;
  return f.href;
}

async function onUpdate() {
  const items = selectedVisible("redirects");
  if (!items.length || st.busy) return;
  const n = items.length;
  const ok = await confirmDialog({
    title: `Update ${plural(n, "bookmark")} to the new address?`,
    body: "Titles and folders stay the same; only the address changes. You can undo this.",
    ok: `Update ${plural(n, "bookmark")}`,
  });
  if (!ok) return;
  let entry = null;
  await busy(async () => {
    entry = await updateUrls(items.map((it) => ({ id: it.id, url: finalWithHash(it.b.url, it.r.finalUrl) })),
      `Updated ${plural(n, "address", "addresses")} to where they redirect`);
  });
  if (entry) {
    toast(`Updated ${plural(entry.items.length, "bookmark")} to the new address.`, entry);
    showMilestone();
  }
}

async function onUndo(entry) {
  if (st.busy) return;
  let n = 0;
  await busy(async () => {
    n = await undo(entry.id);
  });
  toast(n ? `Undone: ${plural(n, entry.kind === "update" ? "address" : "item", entry.kind === "update" ? "addresses" : "items")} restored.` : "Nothing left to undo.");
}

async function onRestore(id) {
  if (st.busy) return;
  await busy(() => restoreOne(id));
  toast("Put back where it was.");
}

async function onEmptyRemoved() {
  if (st.busy) return;
  const n = st.snap.removedCount;
  const items = st.snap.removedItems.length;
  const ok = await confirmDialog({
    title: `Delete ${plural(n, "bookmark")} for good?`,
    body: `Everything in "${REMOVED_TITLE}" (${plural(items, "item")}, ${plural(n, "bookmark")} in total) is deleted permanently. Prune can't undo this.`,
    ok: "Delete permanently",
    danger: true,
  });
  if (!ok) return;
  let deleted = 0;
  await busy(async () => {
    deleted = await emptyRemoved();
  });
  toast(`Deleted ${plural(deleted, "bookmark")} for good.`);
}

// ---------------------------------------------------------------- link check

function onCheckClick(mode, only) {
  // permissions.request has to be the first thing a click handler does, or
  // Firefox no longer counts it as coming from the user.
  browser.permissions.request(ALL_URLS).then((granted) => {
    if (!granted) {
      toast("Prune needs access to websites to check links. Nothing was checked.");
      return;
    }
    runScan(mode, only);
  }, (e) => toast(String(e && e.message ? e.message : e)));
}

let saveTimer = null;
async function persist(now) {
  clearTimeout(saveTimer);
  const write = () => browser.storage.local.set({ linkResults: st.results, scanState: st.scan });
  if (now) return write();
  saveTimer = setTimeout(write, 3000);
  return null;
}

async function runScan(mode, only) {
  if (st.scanner) return;
  const s = st.settings;
  const { urls: all } = checkableUrls();
  let urls;
  let base = 0;
  if (only) {
    urls = only;
  } else if (mode === "continue" && st.scan) {
    urls = all.filter((u) => !(st.results[u] && st.results[u].at >= st.scan.startedAt));
    base = all.length - urls.length;
    st.scan.finishedAt = null;
    st.scan.total = all.length;
  } else {
    st.results = {};
    st.scan = { startedAt: Date.now(), finishedAt: null, total: all.length };
    urls = all;
    for (const t of ["dead", "redirects"]) st.seen[t].clear();
  }
  await persist(true);
  st.progress = { phase: "check", done: 0, total: urls.length, base, only: !!only };
  const scanner = new Scanner({
    urls,
    timeoutMs: s.timeout * 1000,
    concurrency: s.concurrency,
    perHost: s.perHost,
    retry: s.retry,
    onResult: (url, res) => {
      st.results[url] = res;
      st.dirty = true;
      persist(false);
    },
    onProgress: (p) => {
      Object.assign(st.progress, p);
      updateProgress();
    },
  });
  st.scanner = scanner;
  if (st.tab !== "dead" && st.tab !== "redirects") location.hash = "dead";
  render();
  const tick = setInterval(() => {
    if (!st.dirty) return;
    st.dirty = false;
    compute();
    if (st.tab === "dead" || st.tab === "redirects") {
      renderList(st.tab);
      if (st.tab === "redirects") renderIntroRedirects();
    }
    setCount("dead", st.items.dead.length);
    setCount("redirects", st.items.redirects.length);
    updateProgress();
    updateActionBar();
  }, 1000);
  let stopped = false;
  try {
    ({ stopped } = await scanner.run());
  } finally {
    clearInterval(tick);
    st.scanner = null;
    st.progress = null;
    if (!stopped && !only && st.scan) st.scan.finishedAt = Date.now();
    await persist(true);
    compute();
    render();
  }
  if (stopped) toast("Link check stopped. Results so far are kept.");
  else toast(`Link check finished: ${plural(st.items.dead.length, "link")} need a look, ${plural(st.items.redirects.length, "redirect")}.`);
}

// ---------------------------------------------------------------- settings

function bindSettings() {
  const save = async (patch) => {
    st.settings = await saveSettings(patch);
    compute();
    render();
    toast("Saved");
  };
  $("timeout").addEventListener("change", (e) => save({ timeout: clampInt(e.target.value, 3, 60, 15) }));
  $("concurrency").addEventListener("change", (e) => save({ concurrency: clampInt(e.target.value, 1, 32, 8) }));
  $("retry").addEventListener("change", (e) => save({ retry: e.target.checked }));
  $("skipHosts").addEventListener("change", (e) => save({ skipHosts: parseHosts(e.target.value) }));
  for (const k of ["dupScheme", "dupWww", "dupSlash", "dupTracking", "dupHash"]) {
    $(k).addEventListener("change", (e) => {
      st.seen.dupes.clear();
      save({ [k]: e.target.checked });
    });
  }
  $("revokeAccess").addEventListener("click", async () => {
    await browser.permissions.remove(ALL_URLS).catch(() => false);
    renderSettings();
    toast("Website access removed.");
  });
  $("forgetResults").addEventListener("click", async () => {
    if (st.scanner) return;
    st.results = {};
    st.scan = null;
    await browser.storage.local.remove(["linkResults", "scanState"]);
    compute();
    render();
    toast("Link check results forgotten.");
  });
}

// ---------------------------------------------------------------- startup

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (!st.busy) refresh(); }, 350);
}

async function refresh() {
  st.snap = await snapshot();
  st.history = await getHistory();
  compute();
  render();
}

function setTabFromHash() {
  const t = location.hash.replace(/^#/, "");
  st.tab = TABS.includes(t) ? t : st.tab;
  render();
}

async function init() {
  wireSupportLinks();
  buildToolbars();
  bindSettings();
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => { location.hash = b.dataset.tab; });
  }
  window.addEventListener("hashchange", setTabFromHash);
  $("actPrimary").addEventListener("click", () => {
    if (st.tab === "redirects") onUpdate();
    else onRemove(st.tab);
  });
  $("actSecondary").addEventListener("click", () => {
    if (st.tab === "redirects") onRemove("redirects");
    else if (st.tab === "dead") {
      const urls = [...new Set(selectedVisible("dead").map((it) => it.b.url))];
      if (urls.length) onCheckClick("only", urls);
    }
  });

  const got = await browser.storage.local.get(["linkResults", "scanState", "openTab"]);
  st.results = got.linkResults || {};
  st.scan = got.scanState || null;
  st.settings = await getSettings();
  const hashTab = location.hash.replace(/^#/, "");
  if (got.openTab && TABS.includes(got.openTab)) {
    st.tab = got.openTab;
    await browser.storage.local.remove("openTab");
    history.replaceState(null, "", "#" + st.tab);
  } else if (TABS.includes(hashTab)) {
    st.tab = hashTab;
  }
  await refresh();
  document.body.dataset.ready = "1";

  for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved"]) {
    if (browser.bookmarks[ev]) browser.bookmarks[ev].addListener(scheduleRefresh);
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.openTab || !changes.openTab.newValue) return;
    const t = changes.openTab.newValue;
    browser.storage.local.remove("openTab");
    if (TABS.includes(t)) location.hash = t;
  });
  showMilestone();
}

init();
