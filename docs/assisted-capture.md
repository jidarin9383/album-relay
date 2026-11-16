# Assisted chart capture

Album Relay can save ratings from an already-open RYM or AOTY chart into its private album library. It uses the existing service-owned browser; it does not require Codex, a browser extension, paid scraping APIs or manual score entry.

## Use

1. Run the application and browser sidecar with Docker Compose. Sign into the application's administrator page.
2. Open **Connections and sources**. In the chart capture panel, click **Open chart** for RYM or AOTY.
3. Follow **Enter private browser** and wait for the chart to load. Complete a human challenge yourself if the site requests one. Use the same provided browser tab; do not open a separate browser tab for the chart.
4. Return to Album Relay and click **Capture current chart** for that source. This action reads the current document without following its detail links. It captures at most 60 rows per action.
5. Repeat for the other source. Review the album library, decision reasons and capture history. No NetEase operation occurs during capture.

The initial links open the current annual RYM album chart and AOTY LP user-score chart. Other supported user charts can be visited in the same private tab. Non-LP-filtered AOTY charts do not establish LP format; they stay pending until reliable matching evidence supplies it. Annual charts are discovery inputs; the configured release-date window still applies.

## Evidence and rules

Each observation retains its canonical album link, chart link, capture time, score scale, displayed vote count and precision flag. Safe AOTY page numbers are preserved; challenge and tracking parameters are discarded. HTML, browser cookies and full reviews are not saved in capture history.

Counts such as `6k` are approximate. **Allow approximate vote counts** defaults to off. With the option off, an approximate count cannot satisfy a nonzero minimum-vote rule. Enable it explicitly if estimates are acceptable; the library continues to mark them as approximate. The minimum number of qualifying sources is configurable from one to three, with two as the default.

Matching requires normalized artist/title and agreeing, nonempty release dates. Known release formats must agree. A different album link on a previously recorded source is held for review. Ambiguous records are retained in capture history without replacing the existing library observation. Exclusions and historical admissions are preserved.

Capture history is stored in SQLite alongside the library. The UI lists the latest 100 receipts; older receipts are not deleted. Only one application instance should use a data directory. A restart recovers interrupted HTTP-operation locks; a completed capture writes its library updates and receipt atomically.

## Current limits

- Capture is user initiated and covers the loaded page, not an exhaustive feed or guaranteed automatic discovery.
- Source availability checks and background refresh are separate. A successful capture does not declare all source pages accessible.
- Existing **Generate preview** still performs a background source refresh. A preview based only on saved library evidence is a later increment; captures alone do not establish that the complete playlist-delivery workflow succeeds.
- There is no Pitchfork current-chart capture adapter in this increment. The existing background review adapter remains available.
- RYM/AOTY access challenges and site permissions still apply. Reading a page successfully does not establish permission to collect or redistribute its data. Keep personal captures private and review upstream terms before use.

The parser is independently implemented against observed page structures. The implementation research compared the MIT-licensed [Comping](https://github.com/dbeley/comping) and [RYM Release Export](https://github.com/sichengchen/rym-release-export) projects; their extension source is not bundled into this application.
