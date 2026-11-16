# Album Relay

Album Relay is a self-hosted album-discovery and playlist tool. It brings together public AOTY, Rate Your Music and Pitchfork evidence, checks agreement between sources, and matches complete albums to NetEase Cloud Music. It runs without Codex or paid conversion services. Spotify and YouTube Music are planned targets, not implemented.

**Status: development preview.** The UI, source adapters, scheduler, playlist planning and official NetEase CLI integration are implemented and covered by automated tests. Site challenges, interactive login, a full live cross-source run and Synology deployment still need end-to-end verification in the target environment. RYM, AOTY and Pitchfork are all captured by a paired Chrome extension in the user's own browser (including review index and chart pages, plus the optional scheduled refresh). Synology deployment remains unverified. Source coverage is bounded and not exhaustive. The software does not bypass CAPTCHAs; unavailable evidence cannot qualify an album.

## Requirements

- Node.js 24+ and npm, or Docker Engine and Compose.
- Internet access to the rating sites and NetEase Music.
- A NetEase Music developer account and the official CLI's required credentials.
- The machine or NAS must stay running for scheduled jobs.

## Local development

```sh
npm ci
npm run build
npm start
```

Open `http://localhost:3210` and create an administrator password. During development, `npm run dev` starts the backend and `npm run dev:web` starts Vite. Default data location is `./data`; set `ALBUM_RELAY_DATA_DIR` to change it. RYM, AOTY and Pitchfork are captured through the Chrome extension in `extension/` (see below); the server does not crawl source sites.

## Docker Compose

```sh
docker compose up --build -d
```

Open `http://<host-address>:3210` from the local network. Set the administrator password immediately; until that is done, anyone with access to the port could claim the installation. The app uses a named persistent volume. Only port 3210 is published. Protect network access and use HTTPS via a trusted reverse proxy if accessing beyond the local machine. For a trusted proxy, explicitly set `TRUST_PROXY=true` on the application and ensure direct access to the backend port is restricted; the proxy must replace forwarded headers. The container flow is not yet verified on Synology; test the build on your target architecture.

In **Connections**, enter your own developer credentials and scan the login QR code. Closing the QR panel does not guarantee the official CLI has stopped its background authorization poll; do not scan a closed or old QR code. Credential state is private; include them only in protected backups. The official CLI currently accepts the private key through a process argument during configuration, which privileged local process observers could briefly see. Do not use a shared untrusted host.

## Capturing RYM, AOTY and Pitchfork

RYM and AOTY are protected by Cloudflare Turnstile, which rejects automated browsers ([details](docs/assisted-capture.md#current-limits)). Album Relay captures them through a small Chrome extension running in your own browser:

- **Passive capture:** open a supported chart, release or review page in Chrome and it is added to the library once loaded. No button press is needed.
- **Scheduled refresh (optional, off by default):** each day after a configured hour, Chrome opens a few configured chart pages in background tabs and captures them. It stops at the first verification challenge and leaves that tab for you. It never solves challenges.

Install it from `extension/` ([instructions](extension/README.md)) and pair it under **Connections → Browser extension**. Scores, source links, capture history, listening statuses and rounded vote counts are retained, and **Generate playlist preview (`生成歌单预览`)** matches saved qualifying albums to NetEase without re-scraping. See [the capture guide](docs/assisted-capture.md) and [the verification ledger](docs/verification.md).

## Selection and sync

Default rules: releases in the last 90 days, at least 7 days old, with at least two qualifying sources. AOTY requires 80/100 and 100 ratings, RYM 3.5/5 and 100 ratings, and Pitchfork 8/10 or Best New Music. Rounded RYM counts (such as `6k`, whose mathematical lower bound is 5,500) satisfy vote minimums automatically when their lower bound meets the rule; **Allow approximate vote counts** only loosens thresholds that fall inside the rounding uncertainty interval. A clearly low third score flags disagreement. Single-source Pitchfork reviews remain `pending` until RYM or AOTY supplies a release date and LP format (or can be confirmed manually in the library). Missing, stale, blocked or unmatched data is not a low score and is never invented.

Follow the workflow in Chrome + the top bar:

1. **Browse or auto-refresh in Chrome**: open RYM / AOTY charts or Pitchfork review pages (`/reviews/albums/`, `/reviews/best/albums/`, or individual reviews) in Chrome (or enable extension daily refresh) so the extension submits them automatically.
2. **Generate playlist preview (`生成歌单预览`)**: evaluate qualifying saved albums and match complete NetEase albums without external source requests.
3. **Sync playlist (`同步歌单`)**: inspect the matched tracks and confirm writing to this month's NetEase playlist.

Automatic sync is off by default; when enabled, the proposed default is Wednesday at 12:00 Asia/Taipei and writes only after a complete successful run. The monthly format is `高分新专辑｜YYYY-MM`. Sync preserves existing user tracks, groups new album tracks, checkpoints the playlist ID and verifies readback. Descriptions use observed evidence, not invented listening impressions, and are capped at 1,000 characters.

Sources limit collection to a small number of chart pages and candidate lookups per run. A successful run does not imply comprehensive coverage. Layout or platform changes can break parsing; consult the run log and source status. External playback rights are not inferred from catalog availability flags.

## Import an existing registry

New installations start empty. Existing personal playlist identifiers and manifests are not product defaults. An explicit import can register a reviewed registry and its admitted albums without contacting or modifying NetEase. Back up its data and inspect the file. The importer acquires the shared job lock and refuses to run while a job is active:

```sh
ALBUM_RELAY_DATA_DIR=./data npm run import -- /absolute/path/playlist-registry.json
ALBUM_RELAY_DATA_DIR=./data npm run import -- /absolute/path/playlist-registry.json --apply
```

The first command is a dry run; the second writes. Existing months or conflicting albums cause an error instead of being overwritten. Imported albums begin with historical admissions only; live observations and track matches still need refreshing. Existing target tracks are preserved on later syncs. For a container, use the same data volume with a one-off container and mount the registry read-only. The shared lock prevents concurrent jobs; retry if an import is refused.

## Verification and contributing

```sh
npm run typecheck
npm test
npm run build
npx tsx scripts/extension-smoke.ts   # extension end-to-end, offline fixtures
```

A source snapshot or fixture is not proof of live access. Do not commit credentials, browser profiles, private account state, or personal playlist evidence. The historical `research/` and `docs/` material in this working copy contains user-specific findings and should be reviewed and removed or sanitized before publishing a repository. The existing Codex automation remains paused; the in-app scheduler replaces it only when enabled and running.

MIT licensed; see [LICENSE](LICENSE).

## Dependency security

The official `@music163/ncm-cli` 0.1.7 includes old transitive dependencies flagged by `npm audit`, including critical advisories. Their exploitability through this application has not been established, and no compatible upstream fix has been verified. Keep the app on a trusted local network; do not expose it to the public internet. Audit and remove or replace these dependencies only after verifying compatibility with the official CLI.
