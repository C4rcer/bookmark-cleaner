"""End-to-end test of Prune in a real Firefox (Selenium + geckodriver).

  python -m pip install selenium        (once, ideally in a venv)
  python tools/release.py build
  python tests/e2e_firefox.py [--headed]

Installs the built zip (extracted, by path) as a temporary add-on in a
throwaway profile, seeds bookmarks through the extension API, and serves live,
404, 410, 500, 403, slow, HEAD-rejecting and redirecting pages from
tests/server.py under fake host names (network.dns.localDomains). Then drives
the cleaner page: empty folders, duplicates, a stopped-and-continued link
check, filters, remove with cancel / confirm / undo, redirect update + undo,
put back, empty the Removed folder, the popup and the permission flow.
"""
import json
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "prune-bookmark-cleaner@c4rcer"
UUID = "5e1c3b7a-0d2f-4c4e-9b8a-11f0a7c1ea4e"
PORT = 8941
CLOSED_PORT = 8949  # nothing listens here (the "Router" bookmark)
HOSTS = ["site.prune.test", "www.site.prune.test", "other.prune.test"]
S = f"http://site.prune.test:{PORT}"
O = f"http://other.prune.test:{PORT}"
EXT = f"moz-extension://{UUID}"
APP = f"{EXT}/app/app.html"
HEADED = "--headed" in sys.argv

LINKS = [
    ("OK page", f"{S}/ok"),
    ("Missing", f"{S}/missing"),
    ("Gone", f"{O}/gone"),
    ("Server error", f"{S}/error"),
    ("Forbidden", f"{O}/forbidden"),
    ("Slow", f"{S}/slow"),
    ("No HEAD", f"{S}/nohead"),
    ("HEAD fails", f"{O}/headfail"),
    ("Old", f"{S}/old"),
    ("Old article", f"{O}/old-article"),
    ("Private", f"{S}/private"),
    ("Docs", f"{O}/docs"),
    ("Closed", "http://vanished-site.invalid/"),  # .invalid never resolves
    ("Router", f"http://127.0.0.1:{CLOSED_PORT}/admin"),
    ("Bookmarklet", "javascript:void(0)"),
] + [(f"Load {i}", f"{S if i % 2 else O}/ok?d=600&n={i}") for i in range(12)]

DUPES = [
    ("Article", f"{S}/article?id=7"),
    ("Article (newsletter)", f"http://www.site.prune.test:{PORT}/article/?utm_source=newsletter&id=7&fbclid=abc"),
    ("Article again", f"{S}/article?id=7"),
    ("Other article", f"{S}/article?id=8"),
    ("Page", f"{O}/page"),
]

SEED = """
for (const r of ["menu________", "toolbar_____", "unfiled_____", "mobile______"]) {
  for (const k of await browser.bookmarks.getChildren(r).catch(() => [])) {
    if (k.type === "folder") await browser.bookmarks.removeTree(k.id); else await browser.bookmarks.remove(k.id);
  }
}
const mk = (parentId, title, url) => browser.bookmarks.create(url ? {parentId, title, url} : {parentId, title, type: "folder"});
const ids = {};
const T = "toolbar_____";
const links = await mk(T, "Links"); ids.Links = links.id;
for (const [t, u] of LINKS) ids[t] = (await mk(links.id, t, u)).id;
const dup = await mk(T, "Dupes"); ids.Dupes = dup.id;
for (const [t, u] of DUPES) ids[t] = (await mk(dup.id, t, u)).id;
ids["Empty A"] = (await mk(T, "Empty A")).id;
ids["Empty B"] = (await mk(T, "Empty B")).id;
ids["Empty C"] = (await mk(ids["Empty B"], "Empty C")).id;
ids["Only separator"] = (await mk(T, "Only separator")).id;
await browser.bookmarks.create({parentId: ids["Only separator"], type: "separator"});
const keep = await mk(T, "Keep me"); ids["Keep me"] = keep.id;
ids.Keeper = (await mk(keep.id, "Keeper", "OKEEP")).id;
ids["Page copy"] = (await mk(keep.id, "Page copy", "OPAGE")).id;
return ids;
""".replace("LINKS", json.dumps(LINKS)).replace("DUPES", json.dumps(DUPES)) \
   .replace('"OKEEP"', json.dumps(f"{O}/ok?keep")).replace('"OPAGE"', json.dumps(f"{O}/page"))

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail != "" else ""), flush=True)


def wait(fn, timeout=10.0, step=0.1):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001
            last = None
        time.sleep(step)
    return last


def main():
    zips = sorted((ROOT / "dist").glob("*.zip"), key=lambda p: p.stat().st_mtime)
    if not zips:
        sys.exit("build first: python tools/release.py build")
    httpd = server.start(PORT)
    st = server.STATE

    opts = Options()
    opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
    if not HEADED:
        opts.add_argument("-headless")
    opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: UUID}))
    # Grant optional permissions without the doorhanger (headless can't click it).
    opts.set_preference("extensions.webextOptionalPermissionPrompts", False)
    opts.set_preference("network.dns.localDomains", ",".join(HOSTS))
    opts.set_preference("media.volume_scale", "0.0")
    driver = webdriver.Firefox(options=opts)
    driver.set_window_size(1280, 1000)
    js = driver.execute_script

    def ext_call(code):
        return driver.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            f"(async () => {{ {code} }})().then(done, (e) => done('ERR ' + e));"
        )

    def load(hash_=""):
        driver.get(APP + ("#" + hash_ if hash_ else ""))
        wait(lambda: js("return document.body.dataset.ready === '1'"))
        time.sleep(0.2)

    def tab(name):
        driver.find_element(By.CSS_SELECTOR, f'.tabs button[data-tab="{name}"]').click()
        wait(lambda: js(f"return !document.getElementById('panel-{name}').hidden"))
        time.sleep(0.2)

    def click(sel):
        driver.find_element(By.CSS_SELECTOR, sel).click()

    def text(sel):
        return js(f"const e = document.querySelector({json.dumps(sel)}); return e ? e.textContent.trim() : null")

    def checked_ids(list_id):
        return set(js(f"return [...document.querySelectorAll('#{list_id} .row-item')]"
                      ".filter(r => r.querySelector('input[type=checkbox]')?.checked).map(r => r.dataset.id)"))

    def row_ids(list_id):
        return js(f"return [...document.querySelectorAll('#{list_id} .row-item')].map(r => r.dataset.id)")

    def children(fid):
        return ext_call(f"return (await browser.bookmarks.getChildren({json.dumps(fid)})).map(c => c.id);")

    def bm(bid):
        return ext_call(f"const [n] = await browser.bookmarks.get({json.dumps(bid)}).catch(() => [null]); return n;")

    def confirm(ok=True):
        wait(lambda: js("return document.getElementById('confirm').open"))
        click("#confirmOk" if ok else "#confirmCancel")
        wait(lambda: not js("return document.getElementById('confirm').open"))

    unpacked = None
    try:
        unpacked = Path(tempfile.mkdtemp(prefix="prune-e2e-"))
        with zipfile.ZipFile(zips[-1]) as z:
            z.extractall(unpacked)
        driver.execute("INSTALL_ADDON", {"path": str(unpacked), "temporary": True})
        time.sleep(1.0)

        # A cookie for site.prune.test, sent on a normal visit: link checks must not send it.
        driver.get(f"{S}/setcookie")
        driver.get(f"{S}/ok?visit=1")
        visit_cookie = [c for (m, h, p, q, c) in st.log if q == "visit=1"]
        check("cookie is sent on a normal page visit", visit_cookie and "sid=secret" in (visit_cookie[0] or ""), visit_cookie)

        load()
        perms0 = ext_call("return await browser.permissions.contains({origins: ['<all_urls>']});")
        check("<all_urls> not granted at install", perms0 is False, perms0)
        man = ext_call("return browser.runtime.getManifest();")
        check("bookmarks + storage required, <all_urls> optional",
              sorted(man.get("permissions", [])) == ["bookmarks", "storage"]
              and man.get("optional_host_permissions") == ["<all_urls>"] and not man.get("host_permissions"),
              (man.get("permissions"), man.get("optional_host_permissions"), man.get("host_permissions")))

        ids = ext_call(SEED)
        check("bookmarks seeded through the extension API", isinstance(ids, dict) and "Missing" in ids, str(ids)[:120])
        ext_call("await browser.storage.local.set({settings: {timeout: 2, concurrency: 3}}); return true;")
        load()
        check("library stats shown", "bookmarks in" in (text("#libStats") or ""), text("#libStats"))

        # ---- empty folders
        tab("empty")
        titles = js("return [...document.querySelectorAll('#list-empty .row-item .title')].map(e => e.textContent)")
        check("empty folders: outermost only, separators count as empty",
              sorted(titles) == ["Empty A", "Empty B", "Only separator"], titles)
        check("nested empty subfolder noted", "1 empty subfolder" in (js(
            f"return document.querySelector('#list-empty .row-item[data-id=\"{ids['Empty B']}\"] .meta').textContent") or ""))
        check("empty-folder count badge", text("#count-empty") == "3", text("#count-empty"))
        check("empty folders pre-ticked", checked_ids("list-empty") == {ids["Empty A"], ids["Empty B"], ids["Only separator"]})

        # ---- duplicates
        tab("dupes")
        groups = js("""return [...document.querySelectorAll('#list-dupes .group')].map(g =>
            [...g.querySelectorAll('.row-item')].map(r => [r.dataset.id, r.querySelector('input').checked]))""")
        big = next((g for g in groups if len(g) == 3), None)
        check("two duplicate groups", len(groups) == 2, groups)
        check("http/www/slash/tracking variants grouped with exact copies",
              big is not None and {i for i, _ in big} == {ids["Article"], ids["Article (newsletter)"], ids["Article again"]}, big)
        check("oldest copy kept, the others ticked",
              big is not None and big[0] == [ids["Article"], False] and all(c for _, c in big[1:]), big)
        check("different query value is not a duplicate",
              ids["Other article"] not in {i for g in groups for i, _ in g})
        check("exact copies across folders grouped",
              any({i for i, _ in g} == {ids["Page"], ids["Page copy"]} for g in groups))
        check("duplicate count badge = extra copies", text("#count-dupes") == "3", text("#count-dupes"))
        click(f'#list-dupes .row-item[data-id="{ids["Article"]}"] input')
        check("ticking every copy warns", wait(lambda: "none would be left" in (text("#list-dupes .group .warnText") or "")))
        click(f'#list-dupes .row-item[data-id="{ids["Article"]}"] input')

        # ---- dead links: start, stop, continue
        tab("dead")
        n_links = len({u for _, u in LINKS + DUPES if u.startswith("http")} | {f"{O}/ok?keep"})
        check("check button offers the link count", text("#btnScan") == f"Check {n_links} links", (text("#btnScan"), n_links))
        click("#btnScan")
        wait(lambda: js("return !!document.getElementById('btnStop')"), 5)
        perms1 = ext_call("return await browser.permissions.contains({origins: ['<all_urls>']});")
        check("<all_urls> granted when the check starts", perms1 is True, perms1)
        time.sleep(0.8)
        click("#btnStop")
        check("stop leaves a resumable check", wait(lambda: js("return !!document.getElementById('btnContinue')"), 8),
              text("#scanBox h2"))
        wait(lambda: st.inflight == 0, 10)
        st.reset_max()
        t0 = time.time()
        click("#btnContinue")
        done = wait(lambda: text("#btnScan") == "Check again", 90, 0.25)
        check("continued check finishes", done, f"{time.time() - t0:.1f}s")
        time.sleep(0.5)

        res = ext_call("return (await browser.storage.local.get('linkResults')).linkResults;")
        cat = lambda title: (res.get(dict(LINKS)[title]) or {}).get("cat")  # noqa: E731
        expect = {
            "OK page": "ok", "Missing": "notfound", "Gone": "notfound", "Server error": "server",
            "Forbidden": "blocked", "Slow": "timeout", "No HEAD": "ok", "HEAD fails": "ok", "Old": "redirect",
            "Old article": "home", "Private": "redirect", "Docs": "redirect", "Closed": "unreachable", "Router": "local",
        }
        for title, want in expect.items():
            check(f"classified {title} as {want}", cat(title) == want, res.get(dict(LINKS)[title]))
        check("bookmarklet not checked", "javascript:void(0)" not in res)
        r_old = res.get(f"{S}/old") or {}
        check("redirect records the new address", r_old.get("finalUrl") == f"{S}/new" and r_old.get("kind") == "moved", r_old)
        check("sign-in redirect recognised", (res.get(f"{S}/private") or {}).get("kind") == "login")
        check("trailing-slash redirect is minor", (res.get(f"{O}/docs") or {}).get("kind") == "minor")

        log = st.log
        nohead = [m for (m, h, p, q, c) in log if p == "/nohead"]
        check("HEAD first, GET fallback on 405", nohead[:2] == ["HEAD", "GET"], nohead)
        headfail = [m for (m, h, p, q, c) in log if p == "/headfail"]
        check("GET fallback when HEAD says 404", headfail[:2] == ["HEAD", "GET"], headfail)
        okm = [m for (m, h, p, q, c) in log if p == "/ok" and q.startswith("d=600")]
        check("working links need only HEAD", okm and set(okm) == {"HEAD"}, set(okm))
        slow = [m for (m, h, p, q, c) in log if p == "/slow"]
        check("timed-out link retried once at the end", len(slow) >= 4, slow)
        check("concurrency limit respected (3)", 2 <= st.max_inflight <= 3, st.max_inflight)
        check("at most 2 at once per site", max(st.max_host.values()) <= 2, st.max_host)
        scan_reqs = [c for (m, h, p, q, c) in log if q != "visit=1" and p != "/setcookie"]
        check("link checks send no cookies", all(not c for c in scan_reqs), [c for c in scan_reqs if c][:3])

        # ---- review list: counts, filters, search
        check("dead-link count badge", text("#count-dead") == "8", text("#count-dead"))
        pre = checked_ids("list-dead")
        check("only clear-cut dead links pre-ticked", pre == {ids["Missing"], ids["Gone"], ids["Closed"]},
              sorted(pre))
        chips = js("return Object.fromEntries([...document.querySelectorAll('#toolbar-dead .chip')].map(c => [c.dataset.filter, c.querySelector('b').textContent]))")
        check("filter chips with counts", chips.get("all") == "8" and chips.get("notfound") == "2" and chips.get("timeout") == "1", chips)
        click('#toolbar-dead .chip[data-filter="timeout"]')
        check("filter shows one category", row_ids("list-dead") == [ids["Slow"]], row_ids("list-dead"))
        check("action counts only what's shown", "0 of 1 selected" in (text("#selInfo") or ""), text("#selInfo"))
        click('#toolbar-dead .chip[data-filter="server"]')
        at0 = (res.get(f"{S}/error") or {}).get("at", 0)
        click("#selall-dead")
        n_err = len([1 for (m, h, p, q, c) in st.log if p == "/error"])
        click("#actSecondary")
        wait(lambda: text("#btnScan") == "Check again" and len([1 for (m, h, p, q, c) in st.log if p == "/error"]) > n_err, 30, 0.25)
        time.sleep(0.5)
        res2 = ext_call("return (await browser.storage.local.get('linkResults')).linkResults;")
        check("'Check again' re-checks only the ticked rows",
              (res2.get(f"{S}/error") or {}).get("at", 0) > at0
              and (res2.get(f"{S}/missing") or {}).get("at") == (res.get(f"{S}/missing") or {}).get("at"),
              (res2.get(f"{S}/error"), at0))
        check("re-check keeps the finished check's state", text("#count-dead") == "8", text("#count-dead"))
        click("#selall-dead")  # untick it again
        click('#toolbar-dead .chip[data-filter="all"]')
        search = driver.find_element(By.CSS_SELECTOR, "#toolbar-dead .search")
        search.send_keys("gone")
        check("search filters rows", wait(lambda: row_ids("list-dead") == [ids["Gone"]]), row_ids("list-dead"))
        search.clear()
        search.send_keys(" ")
        search.clear()
        js("const s = document.querySelector('#toolbar-dead .search'); s.value=''; s.dispatchEvent(new Event('input'));")
        wait(lambda: len(row_ids("list-dead")) == 8)

        # ---- remove: cancel changes nothing, confirm moves, undo restores
        before = children(ids["Links"])
        click("#actPrimary")
        confirm(ok=False)
        time.sleep(0.5)
        check("cancel changes nothing", children(ids["Links"]) == before)
        click("#actPrimary")
        confirm(ok=True)
        check("toast offers undo", wait(lambda: js("return !document.getElementById('toast').hidden && !document.getElementById('toastUndo').hidden")))
        removed_id = ext_call("return (await browser.storage.local.get('removedFolderId')).removedFolderId;")
        rf = bm(removed_id) or {}
        check("'Removed by Prune' folder created in Other Bookmarks",
              rf.get("title") == "Removed by Prune" and rf.get("parentId") == "unfiled_____", rf)
        moved = set(children(removed_id))
        check("dead links moved into the Removed folder", moved == {ids["Missing"], ids["Gone"], ids["Closed"]}, moved)
        check("and out of their folder", not ({ids["Missing"], ids["Gone"], ids["Closed"]} & set(children(ids["Links"]))))
        check("not deleted", all(bm(ids[t]) for t in ("Missing", "Gone", "Closed")))
        wait(lambda: text("#count-dead") == "5")
        check("removed items leave the list", text("#count-dead") == "5", text("#count-dead"))
        click("#toastUndo")
        check("undo puts them back in order", wait(lambda: children(ids["Links"]) == before, 5), children(ids["Links"]))
        check("Removed folder empty after undo", children(removed_id) == [])
        wait(lambda: text("#count-dead") == "8")
        check("undone items back in the list", text("#count-dead") == "8", text("#count-dead"))

        # ---- redirects: update to new address, undo from Recent changes
        tab("redirects")
        check("redirect count badge", text("#count-redirects") == "3", text("#count-redirects"))
        rpre = checked_ids("list-redirects")
        check("moved + minor redirects ticked, sign-in not", rpre == {ids["Old"], ids["Docs"]}, sorted(rpre))
        check("new address shown", f"{S}/new" in (js(
            f"return document.querySelector('#list-redirects .row-item[data-id=\"{ids['Old']}\"] .url-new').textContent") or ""))
        click("#actPrimary")
        confirm(ok=True)
        wait(lambda: (bm(ids["Old"]) or {}).get("url") == f"{S}/new")
        check("bookmark updated to the new address", (bm(ids["Old"]) or {}).get("url") == f"{S}/new", bm(ids["Old"]))
        check("minor redirect updated too", (bm(ids["Docs"]) or {}).get("url") == f"{O}/docs/")
        check("title and folder unchanged", (bm(ids["Old"]) or {}).get("title") == "Old" and (bm(ids["Old"]) or {}).get("parentId") == ids["Links"])
        wait(lambda: text("#count-redirects") == "1")
        tab("removed")
        hist = js("return [...document.querySelectorAll('#list-history .hist')].map(h => h.querySelector('.what').textContent)")
        check("history lists both changes", len(hist) >= 2 and hist[0].startswith("Updated 2"), hist)
        click("#list-history .hist button")
        wait(lambda: (bm(ids["Old"]) or {}).get("url") == f"{S}/old")
        check("undo restores the old addresses", (bm(ids["Old"]) or {}).get("url") == f"{S}/old"
              and (bm(ids["Docs"]) or {}).get("url") == f"{O}/docs")

        # ---- duplicates: remove extra copies, milestone card
        ext_call("await browser.storage.local.set({stats: {cleaned: 98}}); return true;")
        tab("dupes")
        click("#actPrimary")
        confirm(ok=True)
        wait(lambda: len(children(removed_id)) == 3)
        check("extra copies moved", set(children(removed_id)) == {ids["Article (newsletter)"], ids["Article again"], ids["Page copy"]},
              children(removed_id))
        check("oldest copy kept in place", (bm(ids["Article"]) or {}).get("parentId") == ids["Dupes"])
        wait(lambda: text("#count-dupes") in ("", "0"))
        check("no duplicates left", text("#count-dupes") in ("", "0"), text("#count-dupes"))
        check("one-time thank-you card after 100 cleaned",
              wait(lambda: js("return !document.getElementById('supportCard').hidden")) and "100" in (text("#supportCard p") or ""),
              text("#supportCard p"))
        click("#supportCard .link-btn")  # "Not now"
        nudge = ext_call("return (await browser.storage.local.get('supportNudge')).supportNudge;")
        check("milestone remembered so it never repeats", nudge and 100 in nudge.get("seen", []), nudge)

        # ---- empty folders -> Removed, subtree kept
        tab("empty")
        click("#actPrimary")
        confirm(ok=True)
        wait(lambda: len(children(removed_id)) == 6)
        check("empty folders moved", {ids["Empty A"], ids["Empty B"], ids["Only separator"]} <= set(children(removed_id)))
        check("nested folder moved along", (bm(ids["Empty C"]) or {}).get("parentId") == ids["Empty B"])
        check("non-empty folder untouched", (bm(ids["Keep me"]) or {}).get("parentId") == "toolbar_____")

        # ---- Removed tab: put back, then empty for good
        tab("removed")
        check("Removed tab lists its items", len(row_ids("list-removed")) == 6, row_ids("list-removed"))
        check("shows where items came from", "Bookmarks Toolbar" in (js(
            f"return document.querySelector('#list-removed .row-item[data-id=\"{ids['Empty A']}\"] .where').textContent") or ""))
        click(f'#list-removed .row-item[data-id="{ids["Empty A"]}"] button')
        wait(lambda: (bm(ids["Empty A"]) or {}).get("parentId") == "toolbar_____")
        tb = children("toolbar_____")
        check("put back at its old position", tb.index(ids["Empty A"]) == 2 if ids["Empty A"] in tb else False, tb)
        wait(lambda: len(row_ids("list-removed")) == 5)
        click("#btnEmptyRemoved")
        confirm(ok=False)
        check("cancel keeps the Removed folder", len(children(removed_id)) == 5)
        click("#btnEmptyRemoved")
        confirm(ok=True)
        wait(lambda: children(removed_id) == [])
        check("Removed folder emptied", children(removed_id) == [])
        check("its bookmarks are gone for good", bm(ids["Article again"]) is None and bm(ids["Empty C"]) is None)
        check("history marks deleted changes", wait(lambda: "Deleted for good" in (text("#list-history") or "")))

        # ---- popup
        driver.get(f"{EXT}/popup/popup.html")
        wait(lambda: text("#nDupes") not in (None, ""))
        time.sleep(0.3)
        pop = {k: text("#" + k) for k in ("nDead", "nDupes", "nEmpty", "nRedirects")}
        check("popup counts", pop == {"nDead": "8", "nDupes": "0", "nEmpty": "1", "nRedirects": "3"}, pop)
        check("popup has the Ko-fi pill", js("return document.querySelector('[data-support]').href") == "https://ko-fi.com/carcer7378")
        handles = set(driver.window_handles)
        click('.tile[data-tab="empty"]')
        new = wait(lambda: set(driver.window_handles) - handles, 5)
        if new:
            driver.switch_to.window(new.pop())
        check("popup tile opens the cleaner on that tab",
              wait(lambda: driver.current_url.startswith(APP) and js("return !document.getElementById('panel-empty').hidden"), 5),
              driver.current_url)

        # ---- settings: remove website access again
        load("settings")
        click("#revokeAccess")
        time.sleep(0.5)
        perms2 = ext_call("return await browser.permissions.contains({origins: ['<all_urls>']});")
        check("website access can be removed", perms2 is False, perms2)
        check("settings kept the test values", driver.find_element(By.ID, "timeout").get_attribute("value") == "2")
    finally:
        driver.quit()
        httpd.shutdown()
        if unpacked:
            shutil.rmtree(unpacked, ignore_errors=True)

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
