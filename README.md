# Album Relay

Album Relay is a self-hosted album-discovery and playlist tool. It brings together public AOTY, Rate Your Music and Pitchfork evidence, checks agreement between sources, and matches complete albums to NetEase Cloud Music. It runs without Codex or paid conversion services. Spotify and YouTube Music are planned targets, not implemented.

**Status: development preview.** The UI, source adapters, scheduler, playlist planning and official NetEase CLI integration are implemented and covered by automated tests. Site challenges, interactive login, a full live cross-source run and Synology deployment still need end-to-end verification in the target environment. Linux containers have been built and started; the authenticated verification proxy and browser connection have been checked. Synology deployment remains unverified. Source coverage is bounded and not exhaustive. The software does not bypass CAPTCHAs; unavailable evidence cannot qualify an album.

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

Open `http://localhost:3210` and create an administrator password. During development, `npm run dev` starts the backend and `npm run dev:web` starts Vite. Default data location is `./data`; set `ALBUM_RELAY_DATA_DIR` to change it. Local source verification requires an installed Playwright Chromium and an interactive browser configuration; the Compose browser sidecar is intended for this workflow.

## Docker Compose

```sh
docker compose up --build -d
```

Open `http://<host-address>:3210` from the local network. Set the administrator password immediately; until that is done, anyone with access to the port could claim the installation. The app and browser profile use named persistent volumes. Only port 3210 is published; the browser's debugging and remote desktop ports remain inside the Compose network. Protect network access and use HTTPS via a trusted reverse proxy if accessing beyond the local machine. For a trusted proxy, explicitly set `TRUST_PROXY=true` on the application and ensure direct access to the backend port is restricted; the proxy must replace forwarded headers. Do not expose the browser service directly. The browser image and container flow are not yet verified on a running Linux container or Synology; test the build on your target architecture.

In **Connections**, enter your own developer credentials and scan the login QR code. Closing the QR panel does not guarantee the official CLI has stopped its background authorization poll; do not scan a closed or old QR code. Complete any source verification in the authenticated verification window, then retry the source check or preview. Credential state and browser profiles are private; include them only in protected backups. The official CLI currently accepts the private key through a process argument during configuration, which privileged local process observers could briefly see. Do not use a shared untrusted host.

## Assisted chart capture

The Connections page can capture the current RYM/AOTY chart from the private browser into the persistent album library. Scores, source links, capture history and approximate vote counts are retained. This is user-initiated collection; it does not require paid services or manual score entry. See [the capture guide](docs/assisted-capture.md) for setup and current limits.

## Selection and sync

Default rules: releases in the last 90 days, at least 7 days old, with at least two qualifying sources. AOTY requires 80/100 and 100 ratings, RYM 3.5/5 and 100 ratings, and Pitchfork 8/10 or Best New Music. A clearly low third score flags disagreement. Missing, stale, blocked or unmatched data is not a low score and is never invented. Scores, minimum votes, time window and weekly schedule can be configured; the minimum source count defaults to two and can be set from one to three.

Start with **Generate preview**. A preview samples source pages, cross-checks identities, and matches complete NetEase albums. It may take a while due to conservative request spacing. Inspect its run and then choose **Sync playlist**. Automatic sync is off by default; when enabled, the proposed default is Wednesday at 12:00 Asia/Taipei. It writes only after a complete successful preview. Partial or blocked source runs cannot write; they require inspection and a retry. The monthly format is `高分新专辑｜YYYY-MM`. Sync preserves existing user tracks, groups new album tracks, checkpoints the playlist ID and verifies readback. Descriptions use observed evidence, not invented listening impressions, and are capped at 1,000 characters.

Sources limit collection to a small number of chart pages and candidate lookups per run. A successful run does not imply comprehensive coverage. Layout or platform changes can break parsing; consult the run log and source status. External playback rights are not inferred from catalog availability flags.

## Verification and contributing

```sh
npm run typecheck
npm test
npm run build
```

A source snapshot or fixture is not proof of live access. Do not commit credentials, browser profiles, private account state, or personal playlist evidence. Personal research records and browser profiles are excluded from this public repository.

MIT licensed; see [LICENSE](LICENSE).

## Dependency security

The official `@music163/ncm-cli` 0.1.7 includes old transitive dependencies flagged by `npm audit`, including critical advisories. Their exploitability through this application has not been established, and no compatible upstream fix has been verified. Keep the app on a trusted local network; do not expose it to the public internet. Audit and remove or replace these dependencies only after verifying compatibility with the official CLI.
