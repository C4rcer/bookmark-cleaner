# Prune: Dead Link & Duplicate Bookmark Cleaner

Firefox add-on (desktop) that finds dead links, duplicate bookmarks and empty
folders, shows them in one review list, and cleans up only what you confirm.
Free, every feature unlocked, no ads, no tracking, optional Ko-fi tip.

Why this one: the bookmark cleaners people actually use on AMO are stale.
FoxyTab (20k daily users) was last updated in 2023, Bookmarks Organizer (14k,
3.7 stars) in 2023, Bookmarks clean up (10k) in 2024. Prune only uses the
bookmarks API and plain `fetch`, so there are no site-specific parts to break.

Desktop only: Firefox for Android has no bookmarks API for add-ons, so the
manifest has no `gecko_android` block.

## Features

- **Dead links**: HEAD first, GET when HEAD fails (many servers reject HEAD), a
  per-site time limit, a few checks at a time (default 8) and never more than 2 on
  one site. Links that timed out, couldn't connect or got a 5xx get one slower retry
  at the end. A check can be paused, stopped and continued later (results are saved).
- **Redirects**: bookmarks whose page moved, with "Update to the new address"
  (title and folder kept, `#anchor` carried over). Redirects to a sign-in page are
  flagged and not ticked; a redirect to a site's home page is treated as a probably
  removed page and listed with the dead links.
- **Duplicates**: addresses compared after normalising http/https, `www.`, a trailing
  slash, tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `si` on
  YouTube/Spotify, ...) and parameter order. Each rule can be turned off; `#anchors`
  are kept by default because single-page apps use them as routes. The oldest copy
  of each page is kept, the rest are ticked.
- **Empty folders**: folders with no bookmarks, including ones holding only
  separators or other empty folders (listed once, at the outermost level).
- Review list per category with checkboxes, filter chips with counts, search and
  "All shown". Actions only touch ticked items that are currently shown.
- **Nothing is deleted**: "Remove" moves items into a "Removed by Prune" folder in
  Other Bookmarks. Every change (moves and URL updates) has Undo, from the toast or
  from Recent changes, and single items can be put back to their old folder and
  position. Emptying that folder is a separate, confirmed action.
- Toolbar popup with counts (dead links, duplicates, empty folders, redirects) that
  opens the cleaner on the right tab.

### How a link is classified

| Result | Shown as | Ticked by default |
| --- | --- | --- |
| 404, 410 | Not found | yes |
| 404 on a site that hides private pages (repository pages on GitHub and Codeberg) | May be private | no |
| DNS failure, connection refused | Site unreachable | yes |
| 2xx after redirecting to a home page | Sends you to a home page | no |
| no answer within the time limit | Timed out | no |
| 5xx | Server error | no |
| 401, 403, 407, 429, 451, 999 | Needs sign-in or blocked the check | no |
| other 4xx | Other error | no |
| localhost, private IPs, `.local`, single-label names | Local network address | no |
| 2xx after a redirect | Redirects tab (moved / https-www-slash / sign-in page) | yes, except sign-in |

## Privacy and safety

- `bookmarks` and `storage` are required; `<all_urls>` is an
  `optional_host_permissions` entry requested only when a link check starts
  (Settings has "Remove access").
- Checks use `credentials: "omit"`, `cache: "no-store"` and `referrerPolicy:
  "no-referrer"`, so a check can't sign you out, act on an account, or tell a site
  where it was bookmarked. GET bodies are cancelled as soon as headers arrive.
- The manifest sets its own `extension_pages` CSP (`script-src 'self'; object-src
  'none'`). Firefox's MV3 default adds `upgrade-insecure-requests`, which silently
  turns every `http://` check into `https://` and would report http-only sites as
  dead.
- No data leaves the browser except the checks themselves, which go straight to
  each bookmarked site. `data_collection_permissions: none`.

## Layout

```
src/                       everything that ships
  manifest.json
  app/app.html|css|js      the cleaner (also the options page, opens in a tab)
  app/checker.js           link checker: HEAD/GET, timeouts, concurrency, classification
  popup/                   toolbar popup (counts + "Open Prune")
  shared/bookmarks.js      tree snapshot, URL normalisation, duplicates, empty folders,
                           move to Removed / update URLs / undo / empty
  shared/settings.js       defaults + storage helpers
  shared/support.*         Ko-fi pill + one-time milestone card: a rating ask first, tips later (from the template)
  shared/more-addons.*     "More free add-ons" card + rate link (same file in every add-on; set `live: true` as listings are approved)
store-assets/listing.json  AMO listing text, category, Ko-fi contributions_url
store-assets/screenshots/  1280x800 listing images (made by tests/screenshots.py)
tests/                     real-Firefox E2E, local test server, screenshot generator
tools/release.py           build / lint / submit / status / contrib / screenshots
```

Storage keys (`browser.storage.local`): `settings`, `linkResults` (url -> result),
`scanState`, `history` (last 40 changes, for undo), `removedFolderId`, `stats`
(`cleaned`, for the milestone card), `supportNudge`, `openTab` (popup -> cleaner).

## Develop and test

```powershell
python tools/release.py lint                 # build + web-ext lint the zip (expect 0/0/0)
python -m pip install selenium pillow        # once, ideally in a venv, for the tests
python tests/e2e_firefox.py                  # 106 checks in headless Firefox, ~1 min
python tests/screenshots.py                  # regenerate store screenshots
```

The E2E test installs the extracted built zip, seeds bookmarks through the
extension API, and serves live / 404 / 410 / 500 / 403 / slow / HEAD-rejecting /
redirecting pages from `tests/server.py` as `site.prune.test` and
`other.prune.test` (via `network.dns.localDomains`). It sets
`extensions.webextOptionalPermissionPrompts=false` so the optional permission is
granted without the doorhanger. It checks classification, HEAD-then-GET, the
retry, the concurrency limits (server-side), that no cookies are sent, filters and
search, cancel / confirm / undo, redirect update + undo, put back, emptying the
Removed folder, the milestone card, the popup and removing website access.

Manual: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `src/manifest.json`.

## Release

```powershell
python tools/release.py submit --notes "First release"
python tools/release.py screenshots          # after the listing exists
python tools/release.py status
```

Bump `version` in `src/manifest.json` for every later submit.
