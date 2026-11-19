# Album Relay

Album Relay is a self-hosted album discovery and playlist tool. It collects public AOTY, Rate Your Music and Pitchfork ratings through a paired Chrome extension, ranks recent releases and syncs full albums to NetEase Cloud Music. Album cards show NetEase, Spotify and YouTube Music listening links in that order. Spotify and YouTube Music are playback destinations.

**Development preview.** Album Relay runs on a Mac or as a Docker Compose service, with optional local AI through Ollama or an OpenAI-compatible endpoint. It works without Codex or paid conversion services. See the [verification ledger](docs/verification.md) for local checks and the remaining live checks.

## Requirements

- Node.js 24+ and npm, or Docker Engine and Compose.
- Internet access to the rating sites and NetEase Music.
- A NetEase Music developer account and the official CLI credentials to sync playlists.
- Chrome and the Album Relay server must be running for scheduled capture.

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

Open `http://<host-address>:3210` from the local network. Set the administrator password immediately; until that is done, anyone with access to the port could claim the installation. The app uses a named persistent volume. Only port 3210 is published. Protect network access and use HTTPS via a trusted reverse proxy if accessing beyond the local machine. For a trusted proxy, set `TRUST_PROXY=true` in the Compose environment before starting the service and restrict direct access to the backend port. Configure the proxy to replace `X-Forwarded-Host` and `X-Forwarded-Proto` with the public host and scheme. The container flow is not yet verified on Synology; test the build on your target architecture.

In **设置 → 连接与同步**, enter your own developer credentials and scan the login QR code. Closing the QR panel does not guarantee the official CLI has stopped its background authorization poll; do not scan a closed or old QR code. Credential state is private; include them only in protected backups. The official CLI currently accepts the private key through a process argument during configuration, which privileged local process observers could briefly see. Do not use a shared untrusted host.

## Capturing RYM, AOTY and Pitchfork

Install the [Chrome extension](extension/README.md) and pair it under **设置 → 连接与同步 → 浏览器扩展**.

- Open a supported chart, album or review page in your usual Chrome for passive capture. The extension skips pages captured in the past 30 minutes.
- Daily patrol defaults to 10:00 in Chrome's local time. It opens up to six configured chart or review pages, plus a batch of pending detail pages, 30–75 seconds apart. It stops at the first verification screen and leaves the tab open for you. You can disable patrol or run it manually in the extension settings.

After capture, Album Relay enriches the catalog data and refreshes recommendations. It uses saved ratings from the extension and public metadata services for fields such as dates, formats and listening links. See the [capture guide](docs/assisted-capture.md).

## Browse, select and sync

- **为你推荐** displays up to seven preference picks and three exploration picks. Optional AI adds a taste profile and audience and critic summaries. Listen, save, like, mark as heard or hide an album from its card.
- **全部新专** lets you search selected releases, saved and liked albums, rating disagreements and hidden entries.
- **月度歌单** shows monthly NetEase playlists and offers **立即同步一次**.
- **设置** manages connections, sync, taste imports, selection thresholds and AI.

The default release window is 90 days with no minimum waiting period. Cross-source selection requires two qualifying sources by default. AOTY requires 80/100 and 100 ratings, RYM 3.5/5 and 100 ratings, and Pitchfork 8/10 or Best New Music. Strong single-source releases can qualify directly. The default strong thresholds are RYM 3.7 with 300 ratings, AOTY 82 with 250 ratings, and Pitchfork Best New Music or 8.3 with a known release date. Low qualifying-volume ratings can flag a disagreement. LPs, EPs and unknown formats are eligible. Reissues are excluded. Approximate vote counts are allowed by default.

Automatic sync is enabled by default and requires a configured and authorized NetEase account. Album Relay matches qualified albums by normalized artist and title. It prefers an exact release date, then accepts a unique match within two days. For undated releases it accepts a unique edition within the configured release window. It skips new admissions for hidden, disliked and skipped albums, preserves existing user tracks and verifies the playlist after each write. The default playlist name is `高分新专辑｜YYYY-MM`. To sync manually, use **月度歌单 → 立即同步一次** or **设置 → 连接与同步 → 立即同步歌单**.

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

A source snapshot or fixture is not proof of live access. Do not commit credentials, browser profiles, private account state, or personal playlist evidence. The historical `research/` and `docs/` material in this working copy contains user-specific findings and should be reviewed and removed or sanitized before publishing a repository. Daily capture and playlist sync are managed in the app and its extension.

MIT licensed; see [LICENSE](LICENSE).

## Dependency security

The official `@music163/ncm-cli` 0.1.7 includes old transitive dependencies flagged by `npm audit`, including critical advisories. Their exploitability through this application has not been established, and no compatible upstream fix has been verified. Keep the app on a trusted local network; do not expose it to the public internet. Audit and remove or replace these dependencies only after verifying compatibility with the official CLI.
