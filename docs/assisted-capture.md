# Assisted chart and release capture

Album Relay saves ratings from an already-open RYM, AOTY, or Pitchfork page into its private album library through the paired Chrome extension (`extension/`). It supports annual RYM/AOTY chart pages, single RYM/AOTY album pages, Pitchfork review list pages (`/reviews/albums/`, `/reviews/best/albums/`), individual Pitchfork album review pages, and name-based browser search links without paid scraping APIs or manual score entry.

## Use

1. Install and pair the Chrome extension (`extension/README.md`), then open **Connections and sources** in Album Relay.
2. Open a supported page in your everyday Chrome. You can use the **Open this year's chart / Latest reviews / Best New** or **Search RYM / AOTY / Pitchfork** links in the capture panel; they open new tabs. Supported pages are RYM album charts and release pages, AOTY user-score charts and album pages, and Pitchfork album review lists or single reviews. Complete any human check yourself.
3. Once the page has loaded, the extension submits it. The toolbar badge shows `✓` (captured, or already captured within 30 minutes), `!` (verification needed) or `✗` (failed). Chart and Pitchfork review-list captures read at most 60 rows from the open page without following links.
4. If a captured record differs slightly in release date or edition from an existing album, review it under **Capture history** and click **Confirm merge** (`确认合并`) only after confirming both refer to the same release.
5. Optionally enable **daily refresh** in the Browser extension card. Chrome then opens the configured pages (at most 6, defaulting to this year's RYM/AOTY charts and Pitchfork `/reviews/albums/`) once per day after the chosen hour, in background tabs 30–75 s apart, and stops at the first challenge.
6. Review the library (or manually confirm unknown release formats when needed), click **Generate playlist preview (`生成歌单预览`)** in the top bar to match qualifying saved albums to NetEase without external source scraping, and then click **Sync playlist (`同步歌单`)**.

The server never requests RYM, AOTY, or Pitchfork. The earlier Playwright service browser and Docker browser sidecar were removed because Cloudflare Turnstile rejects automation-controlled browsers.

## Evidence and rules

Each observation retains its canonical album link, chart link, capture time, score scale, displayed vote count and precision flag. Safe AOTY page numbers are preserved; challenge and tracking parameters are discarded. HTML, browser cookies and full reviews are not saved in capture history.

Abbreviated counts such as `6k` are evaluated using their mathematical rounding lower bound (for example, `6k` guarantees at least 5,500 ratings, so it automatically satisfies a 100-rating minimum). **Allow approximate vote counts** defaults to off and is only needed when a configured minimum-vote threshold falls inside the rounding uncertainty interval (such as requiring 5,800 votes when only `6k` is shown).

Pitchfork editorial reviews do not carry a full studio release date or `LP` label on recent releases; single-source Pitchfork reviews remain in **pending** (`待观察`, awaiting RYM/AOTY corroboration) rather than triggering a format error, while explicit `EP` / `Reissue` releases are excluded as non-LP and archival `releaseYear` metadata outside the lookback window is marked `out_of_window`. You can also manually confirm a record's format in the library.

For albums whose upstream CDN blocks cross-origin hotlinking (or whose capture row lacked an image), `GET /api/albums/:id/cover` lazily resolves and caches a directly loadable cover URL from public catalog metadata (iTunes/Deezer) separately from album decision state so active sync previews are never invalidated.

Matching requires normalized artist/title and agreeing, nonempty release dates. Known release formats must agree. A different album link on a previously recorded source is held for review. Ambiguous records are retained in capture history without replacing the existing library observation. Exclusions and historical admissions are preserved.

Capture history is stored in SQLite alongside the library. The UI lists the latest 100 receipts; older receipts are not deleted. Only one application instance should use a data directory. A restart recovers interrupted HTTP-operation locks; a completed capture writes its library updates and receipt atomically.

## Current limits

- Passive capture covers pages you open; scheduled refresh covers at most 6 configured pages per day. Neither is an exhaustive feed.
- Scheduled refresh needs the Mac and Chrome running. A day missed while Chrome was closed runs once after Chrome reopens past the configured hour.
- **Generate playlist preview (`生成歌单预览`)** (`library_preview`) evaluates saved library evidence (within the 7-day capture freshness window) and matches qualifying albums to NetEase without any server source requests. All three sources come from extension captures.
- Pitchfork search pages do not contain review scores; open `/reviews/albums/`, `/reviews/best/albums/`, or an individual `/reviews/albums/<slug>/` review page.
- Playwright-managed browsers loop on Cloudflare Turnstile, and replaying `cf_clearance` cookies from the server fails TLS/IP binding; RYM/AOTY collection therefore requires the paired Chrome extension in your everyday browser.
- RYM/AOTY/Pitchfork access challenges and site permissions still apply. Reading a page successfully does not establish permission to collect or redistribute its data. Keep personal captures private and review upstream terms before use.

The parser is independently implemented against observed page structures. The implementation research compared the MIT-licensed [Comping](https://github.com/dbeley/comping) and [RYM Release Export](https://github.com/sichengchen/rym-release-export) projects; their extension source is not bundled into this application.
