import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { saveCapture } from '../server/capture.js';
import { buildListenLinks, buildSourceSearchUrl, isCanonicalSourceDetailUrl, resolveAlbumListenLinks } from '../server/links.js';
import { albumId } from '../server/policy.js';
import { parseChart } from '../server/sources/charts.js';
import { parseAoty, parsePitchfork, parseRym } from '../server/sources/parsers.js';
import { Store } from '../server/store.js';
import type { Album } from '../shared/types.js';

describe('parsers, link fixes, 003 migration, and 3-platform listen links', () => {
  it('extracts AOTY critic score, critic/user review snippets, vibes, and Spotify link without disturbing user score', () => {
    const html = `
      <div class="artist"><a>PISS</a></div>
      <div class="albumTitle">you made me / skin on linen</div>
      <div class="albumCriticScoreBox">
        <div class="albumCriticScore">88</div>
        <div class="text numReviews">Based on <strong>13</strong> reviews</div>
      </div>
      <div class="albumUserScoreBox">
        <div class="albumUserScore"><a title="84.6">85</a></div>
        <div class="text numReviews">Based on <a><strong>4,935</strong> ratings</a></div>
      </div>
      <div class="detailRow">October 30, 2026 / release date</div>
      <div class="detailRow">LP / format</div>
      <div class="detailRow"><a href="/genre/noise-rock/">Noise Rock</a><a href="/tag/noisy/">noisy</a><a href="/vibe/raw/">raw</a></div>
      <div class="musicLinks"><a href="https://open.spotify.com/album/4L3aQdOW11hKFGRbpkw3wN?si=xyz">Spotify</a></div>
      <div id="critic-reviews">
        <div class="albumReviewRow">
          <div class="albumReviewPublication">musicOMH</div>
          <div class="albumReviewAuthor">John Murphy</div>
          <div class="albumReviewRating">100</div>
          <div class="albumReviewText">Cathartic scream of unflinching feminist rage.</div>
        </div>
      </div>
      <div id="user-reviews">
        <div class="albumReviewRow">
          <div class="albumReviewAuthor">listener_one</div>
          <div class="albumReviewRating">92</div>
          <div class="albumReviewText">Ferocious drumming and uncompromising dynamic tension.</div>
        </div>
      </div>
    `;
    const album = parseAoty(html, 'https://www.albumoftheyear.org/album/2010013-piss-you-made-me-skin-on-linen.php');
    expect(album).not.toBeNull();
    expect(album!.sources[0]).toMatchObject({
      source: 'aoty',
      score: 85,
      votes: 4935,
      criticScore: 88,
      criticVotes: 13,
      detailCaptured: true,
      descriptors: ['noisy', 'raw']
    });
    expect(album!.sources[0]!.reviewSnippets).toEqual([
      {
        kind: 'critic',
        publication: 'musicOMH',
        author: 'John Murphy',
        score: 100,
        text: 'Cathartic scream of unflinching feminist rage.'
      },
      {
        kind: 'user',
        author: 'listener_one',
        score: 92,
        text: 'Ferocious drumming and uncompromising dynamic tension.'
      }
    ]);
    expect(album!.capturedLinks).toEqual({
      spotify: 'https://open.spotify.com/album/4L3aQdOW11hKFGRbpkw3wN'
    });
  });

  it('extracts RYM secondary genres, descriptors, user snippets, and streaming links', () => {
    const html = `
      <h1 class="album_title">Moon</h1>
      <span class="album_artist"><a>Stars</a></span>
      <span itemprop="ratingValue">3.88</span>
      <span itemprop="ratingCount">2.1k</span>
      <table><tr><th>Released</th><td>30 October 2026</td></tr><tr><th>Type</th><td>Album</td></tr></table>
      <div class="release_pri_genres"><a>Dream Pop</a></div>
      <div class="release_sec_genres"><a>Shoegaze</a></div>
      <div class="release_pri_descriptors"><span class="comma_separated">ethereal, lush, melancholic</span></div>
      <div class="ui_media_links_container">
        <a href="https://open.spotify.com/album/0mu3EvWYfNwBfISSg0q03p">Spotify</a>
        <a href="https://www.youtube.com/playlist?list=OLAK5uy_example123">YouTube</a>
      </div>
      <div class="reviews_shell">
        <div class="review">
          <a class="review_user">rym_reviewer</a>
          <span class="review_rating">4.5</span>
          <div class="review_body">Layered guitar washes with luminous vocal melodies throughout.</div>
        </div>
      </div>
    `;
    const album = parseRym(html, 'https://rateyourmusic.com/release/album/stars/moon/');
    expect(album).not.toBeNull();
    expect(album!.genres).toEqual(['Dream Pop', 'Shoegaze']);
    expect(album!.descriptors).toEqual(['ethereal', 'lush', 'melancholic']);
    expect(album!.capturedLinks).toEqual({
      spotify: 'https://open.spotify.com/album/0mu3EvWYfNwBfISSg0q03p',
      youtubeMusic: 'https://music.youtube.com/playlist?list=OLAK5uy_example123'
    });
    expect(album!.sources[0]).toMatchObject({
      detailCaptured: true,
      descriptors: ['ethereal', 'lush', 'melancholic']
    });
    expect(album!.sources[0]!.reviewSnippets?.[0]).toMatchObject({
      kind: 'user',
      author: 'rym_reviewer',
      score: 4.5,
      text: 'Layered guitar washes with luminous vocal melodies throughout.'
    });
  });

  it('extracts Pitchfork dek and critic snippets and fixes search fallback parameter to ?q=', () => {
    const state = {
      transformed: {
        review: {
          headerProps: {
            artists: [{ name: 'Armand Hammer' }],
            title: 'Snakes & Ladders',
            dangerousDek: 'The veteran duo sharpens its sharpest nocturnal beats yet.',
            musicRating: { rating: 8.3, bestNewMusic: true, bestNewReissue: false },
            infoSliceFields: { genre: 'Rap', releaseYear: '2026' }
          }
        }
      }
    };
    const html = `
      <script>window.__PRELOADED_STATE__=${JSON.stringify(state)};</script>
      <article>
        <p>Across eleven tightly sequenced tracks, billy woods and ELUCID trade dense verses over murky jazz loops.</p>
      </article>
    `;
    const album = parsePitchfork(html, 'https://pitchfork.com/reviews/albums/armand-hammer-snakes-and-ladders/');
    expect(album?.sources[0]).toMatchObject({
      criticScore: 8.3,
      criticVotes: 1,
      detailCaptured: true,
      editorialSummary: 'The veteran duo sharpens its sharpest nocturnal beats yet.'
    });
    expect(album?.sources[0]?.reviewSnippets?.[0]).toMatchObject({
      kind: 'critic',
      publication: 'Pitchfork',
      score: 8.3
    });

    expect(buildSourceSearchUrl('pitchfork', 'PISS', 'you made me')).toBe(
      'https://pitchfork.com/search/?q=PISS%20you%20made%20me'
    );
    expect(isCanonicalSourceDetailUrl('pitchfork', 'https://pitchfork.com/search/?q=test')).toBe(false);
    expect(isCanonicalSourceDetailUrl('pitchfork', 'https://pitchfork.com/reviews/albums/stars-moon/')).toBe(true);
    expect(isCanonicalSourceDetailUrl('rym', 'https://rateyourmusic.com/charts/top/album/2026/1/')).toBe(false);
    expect(isCanonicalSourceDetailUrl('rym', 'https://rateyourmusic.com/release/album/stars/moon/')).toBe(true);
  });

  it('preserves detailCaptured review evidence and streaming links when a subsequent chart capture refreshes scores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-preserve-detail-'));
    const store = new Store(dir);
    try {
      const aotyDetail = parseAoty(
        `<div class="artist">Stars</div><div class="albumTitle">Moon</div>
         <div class="albumCriticScoreBox"><div class="albumCriticScore">91</div><div class="text numReviews">Based on <strong>9</strong> reviews</div></div>
         <div class="albumUserScore">84</div><div class="userScoreBox">Based on 1,500 ratings</div>
         <div class="detailRow">October 30, 2026 / release date</div><div class="detailRow">LP / format</div>
         <div class="detailRow"><a href="/tag/lush/">lush</a></div>
         <div class="musicLinks"><a href="https://open.spotify.com/album/1234567890abcd">Spotify</a></div>
         <div id="critic-reviews"><div class="albumReviewRow"><div class="albumReviewPublication">NME</div><div class="albumReviewRating">90</div><div class="albumReviewText">Richly arranged dream pop milestone.</div></div></div>`,
        'https://www.albumoftheyear.org/album/1-stars-moon.php'
      )!;
      saveCapture(store, {
        source: 'aoty',
        pageUrl: 'https://www.albumoftheyear.org/album/1-stars-moon.php',
        observedAt: new Date().toISOString(),
        albums: [aotyDetail],
        warnings: []
      });

      const chartHtml = `<div class="albumListRow"><h2 class="albumListTitle"><a href="/album/1-stars-moon.php">Stars - Moon</a></h2><div class="albumListDate">October 30, 2026</div><div class="albumListScoreContainer"><div class="scoreHeader">USER SCORE</div><div class="scoreValue">86</div><div class="scoreText">2,200 ratings</div></div></div>`;
      const chartCapture = parseChart('aoty', chartHtml, 'https://www.albumoftheyear.org/ratings/user-highest-rated/lp/2026/');
      saveCapture(store, chartCapture);

      const saved = store.albums()[0]!;
      const obs = saved.sources[0]!;
      expect(obs.score).toBe(86);
      expect(obs.votes).toBe(2200);
      expect(obs.detailCaptured).toBe(true);
      expect(obs.criticScore).toBe(91);
      expect(obs.criticVotes).toBe(9);
      expect(obs.reviewSnippets).toHaveLength(1);
      expect(saved.descriptors).toEqual(['lush']);
      expect(saved.capturedLinks?.spotify).toBe('https://open.spotify.com/album/1234567890abcd');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs 004_ai_curation_and_links migration with backup, cleans legacy ?query= Pitchfork URLs, and preserves latest-preview on Odesli resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migrate-004-'));
    const legacyDb = new DatabaseSync(join(dir, 'album-relay.sqlite'));
    legacyDb.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE job_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE import_batches (id TEXT PRIMARY KEY, source TEXT NOT NULL, account_alias TEXT NOT NULL, file_name TEXT NOT NULL, file_sha256 TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL, total_rows INTEGER NOT NULL, accepted_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL, unsupported_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL, listens_added INTEGER NOT NULL, signals_added INTEGER NOT NULL, notes_json TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE raw_records (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, row_index INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT, fingerprint TEXT, raw_json TEXT NOT NULL);
      CREATE TABLE listening_events (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, source TEXT NOT NULL, account_alias TEXT NOT NULL, artist TEXT NOT NULL, artist_norm TEXT NOT NULL, track TEXT NOT NULL, track_norm TEXT NOT NULL, album TEXT NOT NULL, album_norm TEXT NOT NULL, played_at TEXT NOT NULL, ms_played INTEGER, timestamp_precision TEXT NOT NULL, source_event_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE preference_signals (id TEXT PRIMARY KEY, batch_id TEXT, source TEXT NOT NULL, entity_type TEXT NOT NULL, artist TEXT NOT NULL, artist_norm TEXT NOT NULL, title TEXT NOT NULL, title_norm TEXT NOT NULL, album TEXT NOT NULL, album_norm TEXT NOT NULL, genres_json TEXT NOT NULL DEFAULT '[]', candidate_id TEXT, queue_state TEXT, reaction TEXT, rating REAL, weight REAL NOT NULL, action_at TEXT, observed_at TEXT NOT NULL, context TEXT, source_signal_key TEXT UNIQUE);
      CREATE TABLE recommendation_sets (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, profile_revision TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE artist_metadata (artist_norm TEXT PRIMARY KEY, artist_name TEXT NOT NULL, spotify_id TEXT, mbid TEXT, wikidata_id TEXT, genres_json TEXT NOT NULL DEFAULT '[]', manual_genres_json TEXT, source TEXT NOT NULL DEFAULT 'pending', status TEXT NOT NULL DEFAULT 'pending', confidence TEXT NOT NULL DEFAULT 'low', candidates_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL);
      CREATE TABLE catalog_cache (cache_key TEXT PRIMARY KEY, status TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const sampleAlbum: Album = {
      id: albumId('PISS', 'you made me / skin on linen'),
      artist: 'PISS',
      title: 'you made me / skin on linen',
      releaseDate: '2026-10-30',
      format: 'LP',
      genres: ['Noise Rock'],
      excluded: false,
      capturedLinks: { spotify: 'https://open.spotify.com/album/4L3aQdOW11hKFGRbpkw3wN' },
      sources: [
        {
          source: 'pitchfork',
          score: null,
          scale: 10,
          votes: null,
          url: 'https://pitchfork.com/search/?query=PISS%20you%20made%20me',
          observedAt: new Date().toISOString(),
          status: 'missing'
        }
      ]
    };
    legacyDb.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('albums', JSON.stringify([sampleAlbum]));
    legacyDb.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('latest-preview', 'keep-me-intact');
    legacyDb.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('001_personal_taste', '2026-11-16T00:00:00Z');
    legacyDb.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('002_artist_metadata', '2026-11-18T00:00:00Z');
    legacyDb.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('003_catalog_cache', '2026-11-18T12:00:00Z');
    legacyDb.close();

    const store = new Store(dir);
    try {
      expect(existsSync(join(dir, 'backups', 'pre-004_ai_curation_and_links.sqlite'))).toBe(true);
      expect(store.albums()[0]?.sources[0]?.url).toBe('https://pitchfork.com/search/?q=PISS%20you%20made%20me');

      // Priority ordering: NetEase -> Spotify -> YouTube Music
      const initialLinks = buildListenLinks(sampleAlbum);
      expect(Object.keys(initialLinks)).toEqual(['netease', 'spotify', 'youtubeMusic']);
      expect(initialLinks.netease).toMatchObject({
        direct: false,
        source: 'search',
        url: expect.stringContaining('music.163.com/#/search/m/')
      });
      expect(initialLinks.spotify).toMatchObject({
        direct: true,
        source: 'captured',
        url: 'https://open.spotify.com/album/4L3aQdOW11hKFGRbpkw3wN'
      });
      expect(initialLinks.youtubeMusic).toMatchObject({ direct: false, source: 'search' });

      // Resolve via Odesli without touching config['albums'] or latest-preview
      const resolved = await resolveAlbumListenLinks(store, sampleAlbum, {
        fetchImpl: async (url) => {
          expect(String(url)).toContain('api.song.link/v1-alpha.1/links');
          return new Response(
            JSON.stringify({
              linksByPlatform: {
                spotify: { url: 'https://open.spotify.com/album/4L3aQdOW11hKFGRbpkw3wN' },
                youtubeMusic: { url: 'https://music.youtube.com/playlist?list=OLAK5uy_piss123' }
              }
            }),
            { status: 200 }
          );
        }
      });
      expect(resolved.youtubeMusic).toEqual({
        url: 'https://music.youtube.com/playlist?list=OLAK5uy_piss123',
        direct: true,
        source: 'odesli'
      });
      expect(store.getValue('latest-preview')).toBe('keep-me-intact');
    } finally {
      store.close();
    }

    // Verify /api/albums returns cached listenLinks and /api/albums/:id/resolve-links works via HTTP
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ linksByPlatform: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const app = await createApp({ dataDir: dir, scheduler: false });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'links-test-password' } });
      const cookie = setup.headers['set-cookie'] as string;
      const listRes = await app.inject({ url: '/api/albums', headers: { cookie } });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()[0].listenLinks.youtubeMusic).toEqual({
        url: 'https://music.youtube.com/playlist?list=OLAK5uy_piss123',
        direct: true,
        source: 'odesli'
      });
      const resolveRes = await app.inject({
        method: 'POST',
        url: `/api/albums/${sampleAlbum.id}/resolve-links`,
        headers: { cookie }
      });
      expect(resolveRes.statusCode).toBe(200);
      expect(resolveRes.json().listenLinks.spotify.direct).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
