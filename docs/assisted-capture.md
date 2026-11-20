# Assisted chart and release capture

Listen Better saves ratings from an already-open RYM, AOTY, or Pitchfork page into its private album library through the paired Chrome extension (`extension/`). It supports annual RYM/AOTY chart pages, single RYM/AOTY album pages, Pitchfork review list pages (`/reviews/albums/`, `/reviews/best/albums/`), individual Pitchfork album review pages, and name-based browser search links without paid scraping APIs or manual score entry.

## Use

1. Install and pair the Chrome extension (`extension/README.md`), then open **设置 → 连接与同步** in Listen Better.
2. Open a supported page in your everyday Chrome. You can use the **Open this year's chart / Latest reviews / Best New** or **Search RYM / AOTY / Pitchfork** links in the capture panel; they open new tabs. Supported pages are RYM album charts and release pages, AOTY user-score charts and album pages, and Pitchfork album review lists or single reviews. Complete any human check yourself.
3. Once the page has loaded, the extension submits it. The toolbar badge shows `✓` (captured, or already captured within 30 minutes), `!` (verification needed) or `✗` (failed). Chart and Pitchfork review-list captures read at most 60 rows from the open page without following links.
4. If a captured record differs slightly in release date or edition from an existing album, review it under **Capture history** and click **Confirm merge** (`确认合并`) only after confirming both refer to the same release.
5. Daily patrol defaults to 10:00 Chrome local time. The extension opens up to six configured chart or review pages and can backfill pending album details. Pages are opened 30–75 seconds apart. A verification screen stops the run and remains open. The extension options provide **立即巡检一次** for all configured targets and **立即补抓详情页** for details only.
6. Open **为你推荐** to see refreshed recommendations or **全部新专** to browse selected releases. With a connected NetEase account and automatic sync enabled, eligible matches are added to the monthly playlist. **月度歌单 → 立即同步一次** starts a manual sync.

The extension supplies all RYM, AOTY and Pitchfork page evidence. Server-side enrichment uses public catalog metadata and Wikidata to fill dates, formats, covers and source links when available.

## Evidence and rules

Each observation retains its canonical album link, chart link, capture time, score scale, displayed vote count and precision flag. Safe AOTY page numbers are preserved; challenge and tracking parameters are discarded. HTML, browser cookies and full reviews are not saved in capture history.

Approximate vote counts are allowed by default. With that setting enabled, `6k` can satisfy a 5,800-vote threshold. Turn it off to require the rounding lower bound of 5,500 for a displayed count of `6k`.

Pitchfork Best New Music and dated Pitchfork reviews scoring 8.3 or higher can qualify on their own under the default rules. Strong RYM and AOTY ratings can also qualify directly. LPs, EPs and unknown formats are eligible. The policy excludes reissues and dated archival releases outside the release window. You can confirm a release format from its album card.

For albums whose upstream CDN blocks cross-origin hotlinking (or whose capture row lacked an image), `GET /api/albums/:id/cover` lazily resolves and caches a directly loadable cover URL from public catalog metadata (iTunes/Deezer) separately from album decision state so active sync previews are never invalidated.

Capture reconciliation uses artist, title, known release dates and formats to detect possible edition conflicts. NetEase catalog matching separately prefers the exact release date, then a unique match within two days. An undated album requires one artist/title match inside the configured release window. A different album link on a previously recorded source is held for review. Ambiguous records are retained in capture history without replacing the existing library observation. Exclusions and historical admissions are preserved.

Capture history is stored in SQLite alongside the library. The UI lists the latest 100 receipts; older receipts are not deleted. Only one application instance should use a data directory. A restart recovers interrupted HTTP-operation locks; a completed capture writes its library updates and receipt atomically.

## Current limits

- Passive capture covers pages you open. Daily patrol covers up to six configured pages plus the configured detail batch.
- Scheduled refresh needs the Mac and Chrome running. A day missed while Chrome was closed runs once after Chrome reopens past the configured hour.
- Sync uses saved evidence within the seven-day browser capture freshness window.
- Pitchfork search pages do not contain review scores; open `/reviews/albums/`, `/reviews/best/albums/`, or an individual `/reviews/albums/<slug>/` review page.
- RYM/AOTY/Pitchfork access challenges and site permissions still apply. Reading a page successfully does not establish permission to collect or redistribute its data. Keep personal captures private and review upstream terms before use.

The parser is independently implemented against observed page structures. The implementation research compared the MIT-licensed [Comping](https://github.com/dbeley/comping) and [RYM Release Export](https://github.com/sichengchen/rym-release-export) projects; their extension source is not bundled into this application.
