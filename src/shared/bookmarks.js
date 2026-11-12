// Bookmark tree helpers shared by the cleaner page and the popup:
// a flat snapshot of the tree, URL normalisation for duplicates, empty-folder
// detection, and the only code that changes bookmarks (move to the "Removed by
// Prune" folder, update URLs, undo, empty that folder).

export const REMOVED_TITLE = "Removed by Prune";
export const UNFILED = "unfiled_____";
export const ROOT_IDS = new Set([
  "root________", "menu________", "toolbar_____", "unfiled_____", "mobile______", "tags________",
]);
const ROOT_NAMES = {
  menu________: "Bookmarks Menu",
  toolbar_____: "Bookmarks Toolbar",
  unfiled_____: "Other Bookmarks",
  mobile______: "Mobile Bookmarks",
};
const HISTORY_MAX = 40;

function nodeType(n) {
  if (n.type) return n.type;
  if (n.url) return "bookmark";
  return n.children ? "folder" : "separator";
}

/** Id of the "Removed by Prune" folder, creating it in Other Bookmarks if asked. */
export async function getRemovedFolderId(create = false) {
  const { removedFolderId } = await browser.storage.local.get("removedFolderId");
  if (removedFolderId) {
    const [n] = await browser.bookmarks.get(removedFolderId).catch(() => []);
    if (n && nodeType(n) === "folder") return n.id;
  }
  const kids = await browser.bookmarks.getChildren(UNFILED).catch(() => []);
  const found = kids.find((k) => nodeType(k) === "folder" && k.title === REMOVED_TITLE);
  if (found) {
    await browser.storage.local.set({ removedFolderId: found.id });
    return found.id;
  }
  if (!create) return null;
  const made = await browser.bookmarks.create({ parentId: UNFILED, title: REMOVED_TITLE, type: "folder" });
  await browser.storage.local.set({ removedFolderId: made.id });
  return made.id;
}

/**
 * Flat view of the whole tree. Everything inside the Removed folder is kept
 * out of `bookmarks` / `folders` so it is never reported again.
 */
export async function snapshot() {
  const removedId = await getRemovedFolderId(false);
  const [root] = await browser.bookmarks.getTree();
  const nodes = new Map();
  const bookmarks = [];
  const folders = [];
  const removedItems = [];
  let removedCount = 0; // bookmarks anywhere inside the Removed folder

  const walk = (n, parentPath, inRemoved) => {
    const type = nodeType(n);
    const isRoot = ROOT_IDS.has(n.id);
    const title = isRoot ? (n.title || ROOT_NAMES[n.id] || "") : n.title;
    const rec = {
      id: n.id, parentId: n.parentId, index: n.index, title: title || "", url: n.url || "",
      type, dateAdded: n.dateAdded || 0, path: parentPath, inRemoved, children: [],
    };
    nodes.set(n.id, rec);
    if (n.parentId && nodes.has(n.parentId)) nodes.get(n.parentId).children.push(rec);
    if (inRemoved && type === "bookmark") removedCount++;
    if (n.parentId === removedId) removedItems.push(rec);
    if (!inRemoved) {
      if (type === "bookmark") bookmarks.push(rec);
      else if (type === "folder" && !isRoot && n.id !== removedId) folders.push(rec);
    }
    if (n.children) {
      const here = n.id === "root________" ? [] : [...parentPath, title || "(untitled)"];
      for (const c of n.children) walk(c, here, inRemoved || c.id === removedId);
    }
  };
  walk(root, [], false);
  bookmarks.forEach((b, i) => { b.order = i; });
  return { nodes, bookmarks, folders, removedId, removedItems, removedCount };
}

export function formatPath(path) {
  return path.length ? path.join(" › ") : "";
}

// ---------------------------------------------------------------- duplicates

const TRACKING = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "twclid", "ttclid", "li_fat_id",
  "mc_cid", "mc_eid", "igshid", "igsh", "yclid", "ysclid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp",
  "hsctatracking", "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id", "vero_conv", "rb_clickid", "s_cid",
  "_ga", "_gl", "ref_src", "ref_url", "wt.mc_id", "cmpid", "zanpid", "epik", "srsltid",
]);
const SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/;

export function isTrackingParam(key, host) {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING.has(k) || (k === "si" && SI_HOSTS.test(host));
}

/** The key two bookmarks must share to count as duplicates. */
export function normalizeUrl(raw, o) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return String(raw).trim();
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return u.href;
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (o.dupWww) host = host.replace(/^www\./, "");
  let path = u.pathname || "/";
  if (o.dupSlash) path = path.replace(/\/+$/, "");
  let params = Array.from(u.searchParams);
  if (o.dupTracking) params = params.filter(([k]) => !isTrackingParam(k, host));
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const q = params.length ? "?" + new URLSearchParams(params).toString() : "";
  const hash = o.dupHash || u.hash.length <= 1 ? "" : u.hash;
  const scheme = o.dupScheme ? "" : u.protocol;
  const port = u.port ? ":" + u.port : "";
  return `${scheme}//${host}${port}${path}${q}${hash}`;
}

/**
 * Groups of bookmarks that point at the same page. Inside a group the oldest
 * bookmark comes first: that is the copy suggested for keeping.
 */
export function findDuplicates(bookmarks, settings) {
  const map = new Map();
  for (const b of bookmarks) {
    if (!b.url) continue;
    const key = normalizeUrl(b.url, settings);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(b);
  }
  const groups = [];
  for (const [key, items] of map) {
    if (items.length < 2) continue;
    items.sort((a, b) => (a.dateAdded - b.dateAdded) || (a.order - b.order));
    const exact = items.every((x) => x.url === items[0].url);
    groups.push({ key, items, exact });
  }
  groups.sort((a, b) => b.items.length - a.items.length || (a.key < b.key ? -1 : 1));
  return groups;
}

// ---------------------------------------------------------------- empty folders

/**
 * Folders that hold no bookmarks at all (only separators or other empty
 * folders count as empty). Only the outermost empty folder of a branch is
 * listed; removing it takes its empty subfolders along.
 */
export function findEmptyFolders(snap) {
  const hasBookmark = new Map();
  const visit = (rec) => {
    let any = false;
    for (const c of rec.children) {
      if (c.type === "bookmark") any = true;
      else if (c.type === "folder" && visit(c)) any = true;
    }
    hasBookmark.set(rec.id, any);
    return any;
  };
  const root = snap.nodes.get("root________") || [...snap.nodes.values()].find((n) => !n.parentId);
  if (root) visit(root);
  const out = [];
  for (const f of snap.folders) {
    if (hasBookmark.get(f.id)) continue;
    const parent = snap.nodes.get(f.parentId);
    if (parent && !ROOT_IDS.has(parent.id) && !hasBookmark.get(parent.id) && parent.id !== snap.removedId) continue;
    let subfolders = 0;
    let separators = 0;
    const count = (r) => {
      for (const c of r.children) {
        if (c.type === "folder") { subfolders++; count(c); } else if (c.type === "separator") separators++;
      }
    };
    count(f);
    out.push({ ...f, subfolders, separators });
  }
  return out;
}

// ---------------------------------------------------------------- history / stats

async function getHistory() {
  const { history } = await browser.storage.local.get("history");
  return Array.isArray(history) ? history : [];
}

async function pushHistory(entry) {
  const h = await getHistory();
  h.unshift(entry);
  await browser.storage.local.set({ history: h.slice(0, HISTORY_MAX) });
}

async function saveHistory(h) {
  await browser.storage.local.set({ history: h });
}

export { getHistory };

export async function addCleaned(n) {
  const { stats = {} } = await browser.storage.local.get("stats");
  const cleaned = Math.max(0, (stats.cleaned || 0) + n);
  await browser.storage.local.set({ stats: { ...stats, cleaned } });
  return cleaned;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------- changes

/** Move bookmarks / folders into the Removed folder. Returns the history entry. */
export async function moveToRemoved(ids, label) {
  const removedId = await getRemovedFolderId(true);
  const items = [];
  for (const id of new Set(ids)) {
    const [n] = await browser.bookmarks.get(id).catch(() => []);
    if (!n || n.parentId === removedId || n.id === removedId || ROOT_IDS.has(n.id)) continue;
    items.push({ id: n.id, parentId: n.parentId, index: n.index, title: n.title || "", url: n.url || "", type: nodeType(n) });
  }
  // Original positions were all recorded above, before anything moved.
  for (const it of items) await browser.bookmarks.move(it.id, { parentId: removedId });
  if (!items.length) return null;
  const entry = { id: newId(), at: Date.now(), kind: "remove", label, items };
  await pushHistory(entry);
  await addCleaned(items.length);
  return entry;
}

/** Point bookmarks at new URLs. `changes` = [{id, url}] */
export async function updateUrls(changes, label) {
  const items = [];
  for (const c of changes) {
    const [n] = await browser.bookmarks.get(c.id).catch(() => []);
    if (!n || !n.url || n.url === c.url) continue;
    await browser.bookmarks.update(n.id, { url: c.url });
    items.push({ id: n.id, title: n.title || "", oldUrl: n.url, newUrl: c.url });
  }
  if (!items.length) return null;
  const entry = { id: newId(), at: Date.now(), kind: "update", label, items };
  await pushHistory(entry);
  await addCleaned(items.length);
  return entry;
}

async function putBack(it) {
  const [cur] = await browser.bookmarks.get(it.id).catch(() => []);
  if (!cur) return false;
  let parentId = it.parentId;
  const [parent] = await browser.bookmarks.get(parentId).catch(() => []);
  if (!parent) parentId = UNFILED;
  const kids = await browser.bookmarks.getChildren(parentId);
  const index = Math.min(it.index, kids.filter((k) => k.id !== it.id).length);
  await browser.bookmarks.move(it.id, { parentId, index });
  return true;
}

/** Undo one history entry. Returns how many items were restored. */
export async function undo(entryId) {
  const h = await getHistory();
  const entry = h.find((e) => e.id === entryId);
  if (!entry || entry.undone || entry.gone) return 0;
  let done = 0;
  if (entry.kind === "remove") {
    // Ascending original index puts every item back exactly where it was.
    for (const it of [...entry.items].sort((a, b) => a.index - b.index)) {
      if (await putBack(it)) done++;
    }
  } else if (entry.kind === "update") {
    for (const it of entry.items) {
      const [cur] = await browser.bookmarks.get(it.id).catch(() => []);
      if (!cur || cur.url !== it.newUrl) continue;
      await browser.bookmarks.update(it.id, { url: it.oldUrl });
      done++;
    }
  }
  entry.undone = true;
  await saveHistory(h);
  await addCleaned(-done);
  return done;
}

/** Put one item from the Removed folder back where it came from. */
export async function restoreOne(id) {
  const h = await getHistory();
  for (const entry of h) {
    if (entry.kind !== "remove" || entry.undone || entry.gone) continue;
    const it = entry.items.find((x) => x.id === id);
    if (!it) continue;
    const ok = await putBack(it);
    entry.items = entry.items.filter((x) => x.id !== id);
    if (!entry.items.length) entry.undone = true;
    await saveHistory(h);
    if (ok) await addCleaned(-1);
    return ok;
  }
  // Not moved by Prune (dragged in by hand): put it in Other Bookmarks.
  await browser.bookmarks.move(id, { parentId: UNFILED });
  return true;
}

/** Permanently delete everything inside the Removed folder. Returns bookmarks deleted. */
export async function emptyRemoved() {
  const removedId = await getRemovedFolderId(false);
  if (!removedId) return 0;
  const [tree] = await browser.bookmarks.getSubTree(removedId);
  let count = 0;
  const countIn = (n) => { for (const c of n.children || []) { if (nodeType(c) === "bookmark") count++; countIn(c); } };
  countIn(tree);
  for (const c of tree.children || []) {
    if (nodeType(c) === "folder") await browser.bookmarks.removeTree(c.id);
    else await browser.bookmarks.remove(c.id);
  }
  const h = await getHistory();
  for (const e of h) if (e.kind === "remove" && !e.undone) e.gone = true;
  await saveHistory(h);
  return count;
}
