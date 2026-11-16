# Assisted chart and release capture

Album Relay can save ratings from an already-open RYM, AOTY, or Pitchfork page into its private album library. It supports annual RYM/AOTY chart pages, single RYM/AOTY album pages, Pitchfork album review pages, and name-based browser search. It uses the existing service-owned browser; it does not require Codex, a browser extension, paid scraping APIs or manual score entry.

## Use

1. Run the application locally (`BROWSER_HEADLESS=false npm start`) or run the application and browser sidecar with Docker Compose. Sign into the application's administrator page.
2. Open **Connections and sources**. In the capture panel, either click **Open page** (`打开页面`) on RYM, AOTY or Pitchfork, or enter an artist/album name in the search field and click **Search RYM / Search AOTY / Search Pitchfork**.
3. Follow **Enter private browser** (or switch to the opened local browser window) and wait for the page to load. Complete a human challenge yourself if requested. If you used search, click through to the specific album release or Pitchfork album review page in that same tab.
4. Return to Album Relay and click **Capture current page** (`收录当前页面`) for that source. Chart captures read at most 60 rows from the current chart without crawling links; detail captures read the single open release or review page.
5. Repeat for other sources. If a captured record differs slightly in release date or edition from an existing album, review it under **待确认合并** and click **Confirm merge** (`确认合并`) only after confirming both refer to the same release.
6. Review the album library (filterable by decision, source, and listening status), then click **Library preview (`资料库预览`)** to match qualifying saved albums to NetEase Cloud Music without re-scraping rating sites. Review matched tracks and warnings, then click **Sync playlist (`同步歌单`)** once NetEase is connected.

The initial links open the current annual RYM album chart, AOTY LP user-score chart, and Pitchfork album review index (open an individual review article before capturing Pitchfork). Non-LP-filtered AOTY charts leave format as `Unknown` until a single AOTY album page or corroborating RYM record supplies `LP`. Annual charts are discovery inputs; the configured release-date window still applies.

## Evidence and rules

Each observation retains its canonical album link, chart link, capture time, score scale, displayed vote count and precision flag. Safe AOTY page numbers are preserved; challenge and tracking parameters are discarded. HTML, browser cookies and full reviews are not saved in capture history.

Counts such as `6k` are approximate. **Allow approximate vote counts** defaults to off. With the option off, an approximate count cannot satisfy a nonzero minimum-vote rule. Enable it explicitly if estimates are acceptable; the library continues to mark them as approximate. The minimum number of qualifying sources is configurable from one to three, with two as the default.

Matching requires normalized artist/title and agreeing, nonempty release dates. Known release formats must agree. A different album link on a previously recorded source is held for review. Ambiguous records are retained in capture history without replacing the existing library observation. Exclusions and historical admissions are preserved.

Capture history is stored in SQLite alongside the library. The UI lists the latest 100 receipts; older receipts are not deleted. Only one application instance should use a data directory. A restart recovers interrupted HTTP-operation locks; a completed capture writes its library updates and receipt atomically.

## Current limits

- Capture is user initiated and covers the loaded page, not an exhaustive feed or guaranteed automatic discovery.
- Source availability checks and background refresh are separate. A successful capture does not declare all source pages accessible.
- **Library preview (`资料库预览`)** evaluates saved library evidence (within a 7-day capture freshness window) without background source scraping, whereas **Generate preview (`生成预览`)** and scheduled runs still perform bounded source refreshes while preserving fresh (< 7 days) `browser-capture` observations if a site blocks automated requests.
- Pitchfork index and search pages do not contain review scores; open an individual Pitchfork album review page before capturing.
- Live testing on 2026-11-16 showed that Playwright-managed browser windows (`--enable-automation`, software WebGL, active CDP pipe) can enter an infinite Cloudflare Turnstile verification loop even when clicked by a human, and copying `cf_clearance` cookies into server HTTP requests fails due to TLS fingerprint and IP binding. An everyday-browser HTML import or lightweight extension transport is needed when sites enforce Turnstile attestation.
- RYM/AOTY/Pitchfork access challenges and site permissions still apply. Reading a page successfully does not establish permission to collect or redistribute its data. Keep personal captures private and review upstream terms before use.

The parser is independently implemented against observed page structures. The implementation research compared the MIT-licensed [Comping](https://github.com/dbeley/comping) and [RYM Release Export](https://github.com/sichengchen/rym-release-export) projects; their extension source is not bundled into this application.
