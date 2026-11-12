"""Capture AMO listing screenshots (1280x800) of Prune in a real Firefox.

  python tools/release.py build
  python tests/screenshots.py          (needs selenium + pillow)

Writes store-assets/screenshots/{1-dead-links,2-duplicates,3-removed-undo}.png.
The throwaway profile gets a made-up bookmark library on example.* domains and
pre-made link-check results, so nothing is fetched from the network; nothing
here ships in the add-on.
"""
import json
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "prune-bookmark-cleaner@c4rcer"
UUID = "5e1c3b7a-0d2f-4c4e-9b8a-11f0a7c1ea4e"
EXT = f"moz-extension://{UUID}"
APP = f"{EXT}/app/app.html"
OUT = ROOT / "store-assets" / "screenshots"
W, H = 1280, 800
DPR = 1.25  # a 1024x640 CSS viewport fills 1280x800

# (folder, title, url, result) ; result: None = fine, or a link-check result dict
NF = lambda c=404: {"cat": "notfound", "code": c}  # noqa: E731
LIB = [
    ("Recipes", "Sourdough starter, day by day", "https://blog.example.com/2014/06/sourdough-starter", NF()),
    ("Recipes", "Pasta e fagioli", "https://food.example.org/recipes/pasta-e-fagioli", None),
    ("Recipes", "Pasta e fagioli", "https://www.food.example.org/recipes/pasta-e-fagioli/?utm_source=newsletter&utm_medium=email", None),
    ("Recipes", "Weeknight curry", "https://food.example.org/recipes/weeknight-curry", None),
    ("Recipes", "Weekly meal plan", "https://plan.example.net/my/week", None),
    ("Recipes", "Knife skills video", "https://video.example.com/watch/knife-skills", None),
    ("Travel", "Cheap flights to Lisbon", "http://deals.example.net/lisbon-2019", {"cat": "unreachable"}),
    ("Travel", "Train times Berlin to Prague", "https://rail.example.com/timetable?from=berlin&to=prague", None),
    ("Travel", "Train times Berlin to Prague", "http://rail.example.com/timetable?to=prague&from=berlin&fbclid=IwAR0x", None),
    ("Travel", "Hostel near the old town", "https://stay.example.org/prague/hostel-12", {"cat": "home", "code": 200, "finalUrl": "https://stay.example.org/"}),
    ("Travel", "Lisbon tram map", "https://maps.example.com/lisbon/trams", None),
    ("Dev", "jQuery plugin tutorial", "http://www.example.org/tutorials/jquery-plugins.html", NF()),
    ("Dev", "Array.map() reference", "https://docs.example.org/js/array/map", None),
    ("Dev", "Array.map() reference", "http://docs.example.org/js/array/map/", None),
    ("Dev", "Python packaging guide", "https://guide.example.com/packaging", {"cat": "redirect", "kind": "moved", "code": 200, "finalUrl": "https://packaging.example.com/guide/"}),
    ("Dev", "CSS grid cheatsheet", "https://css.example.net/grid", None),
    ("Dev", "Old team wiki", "http://wiki.example.com/display/TEAM", {"cat": "timeout"}),
    ("Dev", "Regex tester", "https://regex.example.com/", None),
    ("Reading list", "Conference 2018 schedule", "https://conf.example.org/2018/schedule", NF(410)),
    ("Reading list", "Long read: the history of maps", "https://mag.example.com/longreads/history-of-maps", None),
    ("Reading list", "Long read: the history of maps", "https://mag.example.com/longreads/history-of-maps", None),
    ("Reading list", "Forum: fixing rear derailleur", "http://forum.example.net/t/rear-derailleur/1132", {"cat": "server", "code": 503}),
    ("Reading list", "Free icon pack", "http://icons.example.com/free-pack", {"cat": "unreachable"}),
    ("Reading list", "Camera review: compact X100", "https://reviews.example.com/cameras/x100", NF()),
    ("Reading list", "Newsletter archive", "http://news.example.org/archive", {"cat": "redirect", "kind": "minor", "code": 200, "finalUrl": "https://news.example.org/archive"}),
    ("Home", "Online banking", "https://bank.example.com/login", {"cat": "blocked", "code": 403}),
    ("Home", "Home NAS", "http://192.168.1.20:5000/", {"cat": "local"}),
    ("Home", "Electricity account", "https://energy.example.net/account", {"cat": "redirect", "kind": "login", "code": 200, "finalUrl": "https://login.example.net/?next=/account"}),
    ("Home", "Bin collection days", "https://council.example.org/bins", None),
    ("Photography", "Film scanning tips", "https://photo.example.com/film-scanning", NF()),
    ("Photography", "Lightroom presets (2016)", "http://presets.example.net/2016/free", {"cat": "unreachable"}),
    ("Photography", "Night sky settings", "https://photo.example.com/night-sky", None),
]
EMPTY = ["Old projects", "Christmas 2017", "Wedding ideas"]

SEED = """
for (const r of ["menu________", "toolbar_____", "unfiled_____", "mobile______"]) {
  for (const k of await browser.bookmarks.getChildren(r).catch(() => [])) {
    if (k.type === "folder") await browser.bookmarks.removeTree(k.id); else await browser.bookmarks.remove(k.id);
  }
}
const folders = {};
for (const [folder, title, url] of LIB) {
  if (!folders[folder]) folders[folder] = (await browser.bookmarks.create({parentId: "toolbar_____", title: folder, type: "folder"})).id;
  await browser.bookmarks.create({parentId: folders[folder], title, url});
}
const misc = await browser.bookmarks.create({parentId: "unfiled_____", title: "Misc", type: "folder"});
for (const name of EMPTY) await browser.bookmarks.create({parentId: misc.id, title: name, type: "folder"});
await browser.bookmarks.create({parentId: misc.id, title: "Unit converter", url: "https://convert.example.com/"});
const results = {};
const now = Date.now();
for (const [, , url, r] of LIB) results[url] = Object.assign({method: "HEAD", at: now}, r || {cat: "ok", code: 200});
await browser.storage.local.set({
  linkResults: results,
  scanState: {startedAt: now - 95000, finishedAt: now - 3000, total: Object.keys(results).length},
  stats: {cleaned: 41},
  supportNudge: {seen: [], optOut: true},
});
return true;
""".replace("LIB", json.dumps(LIB)).replace("EMPTY", json.dumps(EMPTY))


def drop_shadow(card, radius=12):
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width - 1, card.height - 1), radius, fill=255)
    pad = 30
    shadow = Image.new("RGBA", (card.width + pad * 2, card.height + pad * 2), (0, 0, 0, 0))
    sm = Image.new("L", shadow.size, 0)
    ImageDraw.Draw(sm).rounded_rectangle((pad, pad + 6, pad + card.width, pad + card.height + 6), radius, fill=150)
    shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(14)))
    shadow.paste(card, (pad, pad), mask)
    return shadow


def fit(path):
    img = Image.open(path).convert("RGB")
    if img.size != (W, H):
        canvas = Image.new("RGB", (W, H), img.getpixel((2, 2)))
        canvas.paste(img.crop((0, 0, min(W, img.width), min(H, img.height))), (0, 0))
        img = canvas
    img.save(path)
    return img


def main():
    zips = sorted((ROOT / "dist").glob("*.zip"), key=lambda p: p.stat().st_mtime)
    opts = Options()
    opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
    opts.add_argument("-headless")
    opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: UUID}))
    opts.set_preference("layout.css.devPixelsPerPx", str(DPR))
    opts.set_preference("ui.systemUsesDarkTheme", 0)
    opts.set_preference("layout.css.prefers-color-scheme.content-override", 1)
    driver = webdriver.Firefox(options=opts)
    unpacked = Path(tempfile.mkdtemp(prefix="prune-shots-"))
    OUT.mkdir(parents=True, exist_ok=True)
    js = driver.execute_script
    try:
        with zipfile.ZipFile(zips[-1]) as z:
            z.extractall(unpacked)
        driver.execute("INSTALL_ADDON", {"path": str(unpacked), "temporary": True})
        time.sleep(1)
        cw, ch = int(W / DPR), int(H / DPR)
        driver.set_window_size(cw, ch)
        inner = js("return [innerWidth, innerHeight]")
        driver.set_window_size(cw + (cw - inner[0]), ch + (ch - inner[1]))

        driver.get(APP)
        time.sleep(1)
        driver.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            f"(async () => {{ {SEED} }})().then(done, (e) => done(String(e)));")

        def load(tab):
            driver.get("about:blank")  # a hash-only change would not reload the page
            driver.get(APP + "#" + tab)
            for _ in range(50):
                if js("return document.body.dataset.ready === '1'"):
                    break
                time.sleep(0.1)
            time.sleep(0.8)

        # 1: dead links review list
        load("dead")
        driver.save_screenshot(str(OUT / "1-dead-links.png"))
        fit(OUT / "1-dead-links.png")

        # 2: duplicates
        load("dupes")
        driver.save_screenshot(str(OUT / "2-duplicates.png"))
        fit(OUT / "2-duplicates.png")

        # 3: remove the ticked dead links, show the Removed tab with the undo toast, popup on top
        load("dead")
        driver.find_element(By.ID, "actPrimary").click()
        time.sleep(0.4)
        driver.find_element(By.ID, "confirmOk").click()
        time.sleep(1.2)
        js("location.hash = 'removed'")
        time.sleep(0.8)
        js("document.getElementById('toast').hidden = false")
        base_path = OUT / "_base.png"
        driver.save_screenshot(str(base_path))

        driver.switch_to.new_window("tab")
        driver.get(f"{EXT}/popup/popup.html")
        time.sleep(1.2)
        pop_path = OUT / "_popup.png"
        driver.find_element(By.TAG_NAME, "body").screenshot(str(pop_path))
        base = fit(base_path).convert("RGBA")
        base = Image.alpha_composite(base, Image.new("RGBA", base.size, (0, 0, 0, 60)))
        card = drop_shadow(Image.open(pop_path).convert("RGBA"))
        base.alpha_composite(card, (W - card.width - 4, -6))
        base.convert("RGB").save(OUT / "3-removed-undo.png")
    finally:
        driver.quit()
        shutil.rmtree(unpacked, ignore_errors=True)
        for tmp in OUT.glob("_*.png"):
            tmp.unlink()
    for p in sorted(OUT.glob("*.png")):
        print(p.relative_to(ROOT), Image.open(p).size)


if __name__ == "__main__":
    main()
