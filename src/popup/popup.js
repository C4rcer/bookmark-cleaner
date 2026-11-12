import { wireSupportLinks, maybeShowMilestone } from "../shared/support.js";
import { getSettings } from "../shared/settings.js";
import { findDuplicates, findEmptyFolders, snapshot } from "../shared/bookmarks.js";
import { DEAD_CATS } from "../app/checker.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString();

async function openApp(tab) {
  // The cleaner page is the options page, so Firefox reuses an open one.
  if (tab) await browser.storage.local.set({ openTab: tab });
  await browser.runtime.openOptionsPage();
  window.close();
}

function setNum(id, n, bad) {
  const el = $(id);
  el.textContent = fmt(n);
  el.classList.toggle("bad", !!bad && n > 0);
}

async function init() {
  wireSupportLinks();
  $("btnOpen").addEventListener("click", () => openApp(""));
  for (const t of document.querySelectorAll(".tile")) t.addEventListener("click", () => openApp(t.dataset.tab));

  const [settings, snap, got] = await Promise.all([
    getSettings(),
    snapshot(),
    browser.storage.local.get(["linkResults", "scanState", "stats"]),
  ]);
  $("lib").textContent = `${fmt(snap.bookmarks.length)} bookmarks in ${fmt(snap.folders.length)} folders`;

  const dupes = findDuplicates(snap.bookmarks, settings);
  setNum("nDupes", dupes.reduce((n, g) => n + g.items.length - 1, 0), true);
  setNum("nEmpty", findEmptyFolders(snap).length, true);

  const results = got.linkResults || {};
  const scan = got.scanState;
  if (scan) {
    let dead = 0;
    let moved = 0;
    for (const b of snap.bookmarks) {
      const r = results[b.url];
      if (!r) continue;
      if (DEAD_CATS[r.cat]) dead++;
      else if (r.cat === "redirect") moved++;
    }
    setNum("nDead", dead, true);
    setNum("nRedirects", moved, false);
  } else {
    for (const id of ["nDead", "nRedirects"]) {
      $(id).textContent = "Not checked";
      $(id).classList.add("dim");
    }
  }

  const bits = [];
  if (scan && scan.finishedAt) bits.push(`Links checked ${new Date(scan.finishedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`);
  else if (scan) bits.push("Last link check didn't finish");
  else bits.push("Open Prune to check for dead links");
  if (snap.removedCount) bits.push(`${fmt(snap.removedCount)} in the Removed folder`);
  $("foot").textContent = bits.join(" · ");

  const cleaned = (got.stats && got.stats.cleaned) || 0;
  await maybeShowMilestone($("supportCard"), cleaned, [100, 1000, 5000], (m) =>
    `Prune has tidied up ${fmt(m)} bookmarks for you so far. It's free, with no ads and no tracking. If that was worth a coffee, tips keep it maintained.`);
}

init();
