import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { dedupeCollaborativeAlbums, isCollaborativeSameRelease, saveCapture } from '../server/capture.js';
import { NeteaseClient } from '../server/netease.js';
import { autoCorroborateAlbums } from '../server/personal/corroborate.js';
import { canonicalizeGenre, enrichArtistGenres, saveManualArtistGenres } from '../server/personal/enrichment.js';
import { importPersonalData } from '../server/personal/imports.js';
import { buildCorroborationQueue, buildTasteProfile } from '../server/personal/profile.js';
import { generateRecommendations } from '../server/recommendations/ranker.js';
import { planSync } from '../server/planner.js';
import { albumId, decide, defaultSettings } from '../server/policy.js';
import { parseCapturedPage } from '../server/sources/charts.js';
import { SourceService } from '../server/sources/index.js';
import { Store } from '../server/store.js';
import type { Album, ListeningStatus } from '../shared/types.js';

function makeCandidate(
  artist: string,
  title: string,
  genres: string[],
  opts: { rym?: number; aoty?: number; p4k?: number; bnm?: boolean; status?: ListeningStatus; excluded?: boolean; daysOld?: number } = {}
): Album {
  const daysOld = opts.daysOld ?? 20;
  const releaseDate = new Date(Date.now() - daysOld * 86400000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const sources: Album['sources'] = [
    { source: 'rym', score: opts.rym ?? 3.85, scale: 5, votes: 2400, url: `https://rateyourmusic.com/release/album/x/${albumId(artist, title)}/`, observedAt: now, status: 'ok', collectionMethod: 'browser-capture' },
    { source: 'aoty', score: opts.aoty ?? 84, scale: 100, votes: 1800, url: `https://www.albumoftheyear.org/album/1-${albumId(artist, title)}.php`, observedAt: now, status: 'ok', collectionMethod: 'browser-capture' }
  ];
  if (opts.p4k !== undefined) {
    sources.push({ source: 'pitchfork', score: opts.p4k, scale: 10, votes: null, bestNewMusic: Boolean(opts.bnm), url: `https://pitchfork.com/reviews/albums/${albumId(artist, title)}/`, observedAt: now, status: 'ok', collectionMethod: 'browser-capture' });
  }
  const album: Album = {
    id: albumId(artist, title),
    artist,
    title,
    releaseDate,
    format: 'LP',
    genres,
    sources,
    excluded: Boolean(opts.excluded),
    ...(opts.status ? { listeningStatus: opts.status } : {})
  };
  album.decision = decide(album, defaultSettings, new Date().toISOString().slice(0, 10));
  return album;
}

describe('personal taste database, imports, feedback and 7+3 discovery', () => {
  it('creates a consistent VACUUM INTO backup before migration and maps legacy statuses conservatively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migrate-'));
    try {
      const legacy = [
        makeCandidate('Artist A', 'Saved LP', ['Ambient'], { status: 'saved' }),
        makeCandidate('Artist B', 'Liked LP', ['Jazz'], { status: 'liked' }),
        makeCandidate('Artist C', 'Meh LP', ['Rock'], { status: 'disliked' }),
        makeCandidate('Artist D', 'Skipped LP', ['Pop'], { status: 'skipped' })
      ];
      // Simulate a pre-001 database with only config and job_lock
      const rawDb = new DatabaseSync(join(dir, 'album-relay.sqlite'));
      rawDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE job_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);');
      rawDb.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('albums', JSON.stringify(legacy));
      rawDb.close();

      const store = new Store(dir);
      try {
        const backupPath = join(dir, 'backups', 'pre-001_personal_taste.sqlite');
        expect(existsSync(backupPath)).toBe(true);

        const backupDb = new DatabaseSync(backupPath, { readOnly: true });
        const backedUpAlbums = JSON.parse((backupDb.prepare("SELECT value FROM config WHERE key = 'albums'").get() as { value: string }).value) as Album[];
        expect(backedUpAlbums).toHaveLength(4);
        backupDb.close();

        // Legacy album IDs preserved intact
        expect(store.albums().map((a) => a.id)).toEqual(legacy.map((a) => a.id));

        const rows = store.database.prepare('SELECT candidate_id, queue_state, reaction, action_at FROM preference_signals').all() as {
          candidate_id: string;
          queue_state: string;
          reaction: string | null;
          action_at: string | null;
        }[];
        expect(rows).toHaveLength(4);
        // Never fabricates historical action timestamps
        expect(rows.every((r) => r.action_at === null)).toBe(true);
        expect(rows.find((r) => r.candidate_id === legacy[0]!.id)).toMatchObject({ queue_state: 'saved', reaction: null });
        expect(rows.find((r) => r.candidate_id === legacy[1]!.id)).toMatchObject({ queue_state: 'listened', reaction: 'liked' });
        // "无感" stays neutral, not upgraded to strong disliked veto
        expect(rows.find((r) => r.candidate_id === legacy[2]!.id)).toMatchObject({ queue_state: 'listened', reaction: 'neutral' });
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports Spotify history with podcast/<15s filtering, exact repeat preservation, overlap dedup and file idempotency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-spotify-import-'));
    const store = new Store(dir);
    try {
      const file1 = JSON.stringify([
        { ts: '2026-11-01T10:00:00Z', ms_played: 210000, master_metadata_track_name: 'Weird Fishes', master_metadata_album_artist_name: 'Radiohead', master_metadata_album_album_name: 'In Rainbows' },
        // Legitimate repeated row with identical values within the same export
        { ts: '2026-11-01T10:00:00Z', ms_played: 210000, master_metadata_track_name: 'Weird Fishes', master_metadata_album_artist_name: 'Radiohead', master_metadata_album_album_name: 'In Rainbows' },
        // Non-music podcast episode -> unsupported
        { ts: '2026-11-01T11:00:00Z', ms_played: 600000, episode_name: 'Episode 1', episode_show_name: 'Podcast' },
        // Short skip (<15s) -> unsupported
        { ts: '2026-11-01T12:00:00Z', ms_played: 8000, master_metadata_track_name: 'Skipped', master_metadata_album_artist_name: 'Someone', master_metadata_album_album_name: 'LP' },
        // Missing timestamp -> rejected
        { ms_played: 180000, master_metadata_track_name: 'NoTime', master_metadata_album_artist_name: 'Someone' }
      ]);

      const first = importPersonalData(store, { source: 'spotify', accountAlias: 'main', fileName: 'Streaming_History_Audio_0.json', content: file1 });
      expect(first.totalRows).toBe(5);
      expect(first.acceptedCount).toBe(2);
      expect(first.duplicateCount).toBe(0);
      expect(first.unsupportedCount).toBe(2);
      expect(first.rejectedCount).toBe(1);
      expect(first.listensAdded).toBe(2);

      // Exact file re-import -> idempotent replay, zero extra rows
      const second = importPersonalData(store, { source: 'spotify', accountAlias: 'main', fileName: 'Streaming_History_Audio_0.json', content: file1 });
      expect(second.idempotentReplay).toBe(true);

      // Overlapping file sharing 1 existing play + 1 new play
      const file2 = JSON.stringify([
        { ts: '2026-11-01T10:00:00Z', ms_played: 210000, master_metadata_track_name: 'Weird Fishes', master_metadata_album_artist_name: 'Radiohead', master_metadata_album_album_name: 'In Rainbows' },
        { ts: '2026-11-02T14:00:00Z', ms_played: 195000, master_metadata_track_name: 'Nude', master_metadata_album_artist_name: 'Radiohead', master_metadata_album_album_name: 'In Rainbows' }
      ]);
      const third = importPersonalData(store, { source: 'spotify', accountAlias: 'main', fileName: 'Streaming_History_Audio_1.json', content: file2 });
      expect(third.totalRows).toBe(2);
      expect(third.duplicateCount).toBe(1);
      expect(third.acceptedCount).toBe(1);
      expect(third.acceptedCount + third.duplicateCount + third.unsupportedCount + third.rejectedCount).toBe(third.totalRows);
      expect(buildTasteProfile(store).coverage.listeningEventsCount).toBe(3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports NetEase JSON/text, YouTube Music Takeout JSON and RYM rating CSV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-multi-import-'));
    const store = new Store(dir);
    try {
      const ncm = importPersonalData(store, {
        source: 'netease',
        fileName: 'liked.json',
        content: JSON.stringify({ playlist: { tracks: [{ name: 'Rainbow', ar: [{ name: 'Chat Pile' }], al: { name: 'Gods Country' }, genres: ['Sludge Metal'] }] } })
      });
      expect(ncm).toMatchObject({ acceptedCount: 1, signalsAdded: 1 });

      const ncmText = importPersonalData(store, {
        source: 'netease',
        fileName: 'paste.txt',
        content: 'Boards of Canada - Roygbiv\ninvalid line'
      });
      expect(ncmText).toMatchObject({ totalRows: 2, acceptedCount: 1, rejectedCount: 1 });

      const ytm = importPersonalData(store, {
        source: 'youtube_music',
        fileName: 'watch-history.json',
        content: JSON.stringify([
          { header: 'YouTube Music', title: 'Watched Harvest Moon', subtitles: [{ name: 'Neil Young - Topic' }], time: '2026-11-10T08:00:00Z' },
          { header: 'YouTube', title: 'Watched Tech Review', subtitles: [{ name: 'Channel' }], time: '2026-11-10T09:00:00Z' }
        ])
      });
      expect(ytm).toMatchObject({ totalRows: 2, acceptedCount: 1, unsupportedCount: 1, listensAdded: 1 });

      const rym = importPersonalData(store, {
        source: 'rym_export',
        fileName: 'ratings.csv',
        content: 'Artist,Title,Rating,Genres\nThe Olivia Tremor Control,Black Foliage,4.5,"Psychedelic Pop, Indie Rock"\nSome Band,Bad Album,1.5,Pop'
      });
      expect(rym).toMatchObject({ totalRows: 2, acceptedCount: 2, signalsAdded: 2 });

      const profile = buildTasteProfile(store);
      expect(profile.coldStart).toBe(false);
      expect(profile.topArtistsLongTerm.map((a) => a.name)).toContain('Chat Pile');
      expect(profile.topGenres.map((g) => g.name)).toContain('Psychedelic Pop');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports multi-section TuneMyMusic/Exportify Spotify CSVs, handles bilingual/punctuation artist matching, and refuses to commit 0-accepted batches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-tmm-csv-'));
    const store = new Store(dir);
    try {
      const csv = [
        '\uFEFFTrack name,Artist name,Album,Playlist name,Type,ISRC,Spotify - id',
        '"K.","Cigarettes After Sex","Cigarettes After Sex","Favorite Songs","Favorite","USBQU1600214","0mTHy19ihR54DdAxc9mU1C"',
        '"K.","Cigarettes After Sex","Cigarettes After Sex","Favorite Songs","Favorite","USBQU1600214","7LX4aXtvImhdgUHQBlo8Kp"',
        '"","","","Favorite Songs","Favorite","","15ZnW0rCGJvb0fV2N3nN1r"',
        '"Carrie & Lowell","Sufjan Stevens","Carrie & Lowell","Favorite Albums","Album","656605609966","64xtjfsPHNHch0CZ7fPTjS"',
        '"Oklou","","","Favorite Artists","Artist","","6fFcUOFcbjeIuEomuUthkw"',
        '"Slowdive","","","Favorite Artists","Artist","","72X6FHxaShda0XeQw3vbeF"',
        '"落日飛車 Sunset Rollercoaster","","","Favorite Artists","Artist","","7BqRcZsHYYQeqMAOp7e532"',
        '"Dream, Ivory","","","Favorite Artists","Artist","","0qZyvjwZauLmrobrpJmvib"',
        '"Tyler, The Creator","","","Favorite Artists","Artist","","4V8LLVI7PbaPR0K2TGSxFF"'
      ].join('\n');

      const batch = importPersonalData(store, { source: 'spotify', fileName: 'My_Spotify_Library.csv', content: csv });
      expect(batch.totalRows).toBe(9);
      expect(batch.acceptedCount).toBe(7);
      expect(batch.duplicateCount).toBe(1);
      expect(batch.unsupportedCount).toBe(1);
      expect(batch.rejectedCount).toBe(0);
      expect(batch.acceptedCount + batch.duplicateCount + batch.unsupportedCount + batch.rejectedCount).toBe(batch.totalRows);

      const exportify = importPersonalData(store, {
        source: 'netease',
        fileName: 'exportify.csv',
        content: 'Track Name,Artist Name(s),Album Name\nTrack One,Slowdive; Mojave 3,Souvlaki'
      });
      expect(exportify).toMatchObject({ totalRows: 1, acceptedCount: 1, rejectedCount: 0 });

      const profile = buildTasteProfile(store);
      expect(profile.coldStart).toBe(false);
      const artistNames = profile.topArtistsLongTerm.map((a) => a.name);
      expect(artistNames).toEqual(expect.arrayContaining(['Oklou', 'Sufjan Stevens', 'Slowdive', 'Tyler, The Creator']));

      // Bilingual CJK+Latin match ("Sunset Rollercoaster") succeeds; punctuation-comma artist ("Dream, Ivory") does not false-match "Dream"
      const candidates = [
        makeCandidate('Sunset Rollercoaster', 'Soft Storm', ['City Pop']),
        makeCandidate('Dream', 'Not Dream Ivory', ['Pop'])
      ];
      store.saveAlbums(candidates);
      const recs = generateRecommendations(store, { preferenceSlots: 2, explorationSlots: 0 });
      const sunsetRec = recs.items.find((i) => i.album.artist === 'Sunset Rollercoaster');
      const dreamRec = recs.items.find((i) => i.album.artist === 'Dream');
      expect(sunsetRec?.breakdown.artistAffinity).toBeGreaterThan(0);
      expect(sunsetRec?.breakdown.matchedArtists).toContain('落日飛車 Sunset Rollercoaster');
      expect(dreamRec?.breakdown.artistAffinity).toBe(0);

      // 0-accepted CSV must throw and must NOT leave a committed batch locking out future retries
      expect(() =>
        importPersonalData(store, {
          source: 'spotify',
          fileName: 'empty-metadata.csv',
          content: 'Track name,Artist name,Album,Playlist name,Type,Spotify - id\n"","","","Favorite Songs","Favorite","id1"\n"","","","Favorite Songs","Favorite","id2"'
        })
      ).toThrow(/未识别到有效音乐记录/);
      const batchesAfter = store.database.prepare('SELECT COUNT(*) AS count FROM import_batches').get() as { count: number };
      expect(batchesAfter.count).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates deterministic 7+3 recommendations without NetEase login, respects append-only feedback & only syncs reviewed selection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-recs-api-'));
    const candidates: Album[] = [
      makeCandidate('Chat Pile', 'Who Loves the Sun', ['Sludge Metal', 'Noise Rock'], { rym: 3.9, aoty: 85, bnm: true, p4k: 8.4 }),
      makeCandidate('Pref Artist 2', 'Post Punk One', ['Post-Punk', 'Noise Rock']),
      makeCandidate('Pref Artist 3', 'Art Rock LP', ['Art Rock']),
      makeCandidate('Pref Artist 4', 'Shoegaze LP', ['Shoegaze']),
      makeCandidate('Pref Artist 5', 'Ambient LP', ['Ambient']),
      makeCandidate('Pref Artist 6', 'Jazz LP', ['Spiritual Jazz']),
      makeCandidate('Pref Artist 7', 'Folk LP', ['Contemporary Folk']),
      makeCandidate('Explore Act 1', 'Experimental Techno LP', ['IDM', 'Techno']),
      makeCandidate('Explore Act 2', 'Chamber Classical LP', ['Chamber Music']),
      makeCandidate('Explore Act 3', 'No Genres Here', []),
      makeCandidate('Already Heard', 'Done Album', ['Post-Punk'], { status: 'listened' }),
      makeCandidate('Manually Excluded', 'Skip Me', ['Post-Punk'], { excluded: true })
    ];
    const seedStore = new Store(dir);
    seedStore.saveAlbums(candidates);
    seedStore.close();

    let syncedNames: string[] = [];
    let tracks: { id: string; originalId: number; name: string }[] = [];
    let playlistDesc = '';
    const netease = new NeteaseClient(dir, {
      command: async (args) => {
        const cmd = `${args[0]} ${args[1]}`;
        if (cmd === 'search album') {
          const kw = args[args.indexOf('--keyword') + 1]!;
          syncedNames.push(kw);
          const match = candidates.find((c) => kw.includes(c.title))!;
          return { code: 200, data: { records: [{ id: `ncm-${match.id}`, originalId: 100, name: match.title, artists: [{ name: match.artist }], publishTime: Date.parse(`${match.releaseDate}T00:00:00Z`) }] } };
        }
        if (cmd === 'album tracks') {
          const id = args[args.indexOf('--albumId') + 1]!;
          return { code: 200, data: [{ id: `tr-${id}`, originalId: 10, name: 'Track 1' }] };
        }
        if (cmd === 'playlist create') return { code: 200, data: { id: 'pl-1', originalId: 900 } };
        if (cmd === 'playlist tracks') return { code: 200, data: tracks };
        if (cmd === 'playlist add') {
          const ids = JSON.parse(args[args.indexOf('--songIdList') + 1]!) as string[];
          tracks = tracks.concat(ids.map((id, i) => ({ id, originalId: 10 + i, name: 'Track 1' })));
          return { code: 200, data: {} };
        }
        if (cmd === 'playlist reorder') {
          const ids = JSON.parse(args[args.indexOf('--trackIds') + 1]!) as string[];
          tracks = ids.map((id) => tracks.find((t) => t.id === id)!);
          return { code: 200, data: {} };
        }
        if (cmd === 'playlist updateDesc') {
          playlistDesc = args[args.indexOf('--desc') + 1] ?? '';
          return { code: 200, data: {} };
        }
        if (cmd === 'playlist get') {
          return { code: 200, data: { name: 'P', describe: playlistDesc, trackCount: tracks.length } };
        }
        throw new Error(`Unexpected ${cmd}`);
      }
    });

    const app = await createApp({ dataDir: dir, scheduler: false, sources: new SourceService(dir), netease });
    const waitRun = async (id: string, cookie: string) => {
      for (let i = 0; i < 60; i++) {
        const run = (await app.inject({ url: `/api/runs/${id}`, headers: { cookie } })).json();
        if (!['queued', 'running'].includes(run.status)) return run;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('Run timed out');
    };

    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'personal-discovery-pass' } });
      const cookie = setup.headers['set-cookie'] as string;

      // Cold start recommendation works cleanly without NetEase login
      const coldSet = (await app.inject({ method: 'POST', url: '/api/recommendations/generate', headers: { cookie }, payload: {} })).json();
      expect(coldSet.coldStart).toBe(true);
      expect(coldSet.items).toHaveLength(10);
      expect(coldSet.items.every((i: { confidence: string }) => i.confidence === 'low')).toBe(true);

      // Import personal favorite & NetEase history (without calling NetEase API)
      await app.inject({ method: 'POST', url: '/api/personal/favorites', headers: { cookie }, payload: { artist: 'Chat Pile', genres: ['Post-Punk', 'Noise Rock'] } });
      await app.inject({
        method: 'POST',
        url: '/api/personal/imports',
        headers: { cookie },
        payload: { source: 'netease', fileName: 'favorites.txt', content: 'Chat Pile - Why\nPref Artist 2 - Track' }
      });

      const warmSet = (await app.inject({ method: 'POST', url: '/api/recommendations/generate', headers: { cookie }, payload: {} })).json();
      expect(warmSet.coldStart).toBe(false);
      expect(warmSet.items).toHaveLength(10);
      expect(warmSet.items.filter((i: { slotType: string }) => i.slotType === 'preference')).toHaveLength(7);
      expect(warmSet.items.filter((i: { slotType: string }) => i.slotType === 'exploration')).toHaveLength(3);
      expect(warmSet.items[0].album.artist).toBe('Chat Pile');
      expect(warmSet.items[0].reasons.some((r: string) => r.includes('Chat Pile'))).toBe(true);
      const ids = warmSet.items.map((i: { album: { id: string } }) => i.album.id);
      expect(ids).not.toContain(candidates[10]!.id);
      expect(ids).not.toContain(candidates[11]!.id);
      const noGenreRec = warmSet.items.find((i: { album: { id: string } }) => i.album.id === candidates[9]!.id);
      expect(noGenreRec.confidence).toBe('low');

      // Append-only feedback supersession: like -> dislike preserves both rows and updates profile
      const targetId = candidates[1]!.id;
      await app.inject({ method: 'POST', url: `/api/albums/${targetId}/status`, headers: { cookie }, payload: { listeningStatus: 'liked' } });
      await app.inject({ method: 'POST', url: `/api/albums/${targetId}/status`, headers: { cookie }, payload: { listeningStatus: 'skipped', reaction: 'disliked' } });
      const checkDb = new DatabaseSync(join(dir, 'listen-better.sqlite'), { readOnly: true });
      const feedbackRows = checkDb.prepare('SELECT reaction FROM preference_signals WHERE candidate_id = ? ORDER BY rowid ASC').all(targetId) as { reaction: string }[];
      expect(feedbackRows.map((r) => r.reaction)).toEqual(['liked', 'disliked']);
      checkDb.close();
      const overview = (await app.inject({ url: '/api/personal/overview', headers: { cookie } })).json();
      expect(overview.profile.dislikedCount).toBe(1);
      expect(overview.profile.likedCount).toBe(0);

      // Selected 2-album preview matches ONLY those 2 albums (not all 10+!)
      const pickTwo = [warmSet.items[0].album.id, warmSet.items[7].album.id];
      const previewStart = await app.inject({
        method: 'POST',
        url: '/api/runs',
        headers: { cookie },
        payload: { mode: 'library_preview', selection: { recommendationSetId: warmSet.id, albumIds: pickTwo } }
      });
      expect(previewStart.statusCode).toBe(200);
      const previewRun = await waitRun(previewStart.json().id, cookie);
      expect(previewRun.status).toBe('succeeded');
      expect(previewRun.preview.albums.map((a: Album) => a.id)).toEqual(pickTwo);
      expect(syncedNames).toHaveLength(2);

      // Feedback change on a previewed album invalidates latest-preview before sync
      await app.inject({ method: 'POST', url: `/api/albums/${pickTwo[0]}/status`, headers: { cookie }, payload: { listeningStatus: 'disliked' } });
      const blockedSync = await waitRun((await app.inject({ method: 'POST', url: '/api/runs', headers: { cookie }, payload: { mode: 'sync' } })).json().id, cookie);
      expect(blockedSync.status).toBe('failed');

      // Re-preview remaining 1 album and sync cleanly
      await app.inject({ method: 'POST', url: `/api/albums/${pickTwo[0]}/status`, headers: { cookie }, payload: { listeningStatus: 'unheard' } });
      const p2 = await waitRun(
        (await app.inject({ method: 'POST', url: '/api/runs', headers: { cookie }, payload: { mode: 'library_preview', selection: { recommendationSetId: warmSet.id, albumIds: [pickTwo[1]!] } } })).json().id,
        cookie
      );
      expect(p2.status).toBe('succeeded');
      const syncRun = await waitRun((await app.inject({ method: 'POST', url: '/api/runs', headers: { cookie }, payload: { mode: 'sync' } })).json().id, cookie);
      expect(syncRun.status).toBe('succeeded');
      const playlists = (await app.inject({ url: '/api/playlists', headers: { cookie } })).json();
      expect(playlists[0].albumIds).toEqual([pickTwo[1]]);

      // Overview overlays live admittedMonth onto historical recommendation items & surfaces manual artist genre endpoint
      const afterSyncOverview = (await app.inject({ url: '/api/personal/overview', headers: { cookie } })).json();
      const syncedRecItem = afterSyncOverview.recommendations[0].items.find((i: { album: { id: string } }) => i.album.id === pickTwo[1]);
      expect(syncedRecItem.album.admittedMonth).toMatch(/^\d{4}-\d{2}$/);

      const manualRes = await app.inject({
        method: 'POST',
        url: '/api/personal/artists/slowdive/genres',
        headers: { cookie },
        payload: { artistName: 'Slowdive', genres: ['Shoegaze', 'ambient music', 'chinese'] }
      });
      expect(manualRes.statusCode).toBe(200);
      expect(manualRes.json().artistMetadata[0]).toMatchObject({
        artistNorm: 'slowdive',
        status: 'manual',
        genres: ['Shoegaze', 'Ambient']
      });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('canonicalizes genres, backs up before 002 migration, enriches artists via Wikidata+MB without collapsing homonyms, and ranks corroboration queue', () => {
    expect(canonicalizeGenre('ambient music')).toBe('Ambient');
    expect(canonicalizeGenre('chamber music')).toBe('Chamber Music');
    expect(canonicalizeGenre('chinese')).toBeNull();
    expect(canonicalizeGenre('idm')).toBe('IDM');
    expect(canonicalizeGenre('r&b')).toBe('R&B');
  });

  it('runs Wikidata P1902, Wikidata name ambiguity guard, MusicBrainz MBID fallback, and corroboration queue ranking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-enrich-'));
    // Simulate a 001 database before 002_artist_metadata existed
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
    `);
    legacyDb.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('albums', '[]');
    legacyDb.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('001_personal_taste', new Date().toISOString());
    legacyDb.close();

    const store = new Store(dir);
    try {
      expect(existsSync(join(dir, 'backups', 'pre-002_artist_metadata.sqlite'))).toBe(true);

      const csv = [
        'Track name,Artist name,Album,Playlist name,Type,ISRC,Spotify - id',
        '"Slowdive","","","Favorite Artists","Artist","","72X6FHxaShda0XeQw3vbeF"',
        '"新裤子乐队","","","Favorite Artists","Artist","","3asy14alGCZBDd3Y6pbBbp"',
        '"Low","","","Favorite Artists","Artist","",""',
        '"Manual Band","Manual Band","Manual LP","Favorite Albums","Album","",""'
      ].join('\n');
      importPersonalData(store, { source: 'spotify', fileName: 'artists.csv', content: csv });
      saveManualArtistGenres(store, { artistName: 'Manual Band', genres: ['Post-Rock'] });

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes('query.wikidata.org/sparql')) {
          const body = decodeURIComponent(String(init?.body ?? ''));
          if (body.includes('wdt:P1902')) {
            return new Response(
              JSON.stringify({
                results: {
                  bindings: [
                    {
                      spotifyId: { value: '72X6FHxaShda0XeQw3vbeF' },
                      item: { value: 'http://www.wikidata.org/entity/Q1502037' },
                      mbid: { value: '53b0f6eb-b882-4888-ac3d-8f52d0d4e552' },
                      genres: { value: 'shoegaze|dream pop|ambient music' }
                    },
                    {
                      spotifyId: { value: '3asy14alGCZBDd3Y6pbBbp' },
                      item: { value: 'http://www.wikidata.org/entity/Q11082803' },
                      mbid: { value: 'a3d42269-98d7-4b1d-b004-f739cf805cc9' },
                      genres: { value: '' }
                    }
                  ]
                }
              }),
              { status: 200 }
            );
          }
          // Name query: "Low" hits two homonyms
          return new Response(
            JSON.stringify({
              results: {
                bindings: [
                  {
                    queryName: { value: 'Low', 'xml:lang': 'en' },
                    item: { value: 'http://www.wikidata.org/entity/Q1754524' },
                    itemLabel: { value: 'Low (American band)' },
                    mbid: { value: 'mbid-low-band' },
                    genres: { value: 'slowcore|indie rock' }
                  },
                  {
                    queryName: { value: 'Low', 'xml:lang': 'en' },
                    item: { value: 'http://www.wikidata.org/entity/Q9999999' },
                    itemLabel: { value: 'Low (Belgian artist)' },
                    mbid: { value: 'mbid-low-be' },
                    genres: { value: 'hip hop' }
                  }
                ]
              }
            }),
            { status: 200 }
          );
        }
        if (url.includes('musicbrainz.org/ws/2/artist/a3d42269-98d7-4b1d-b004-f739cf805cc9')) {
          return new Response(
            JSON.stringify({
              genres: [
                { name: 'pop punk', count: 2 },
                { name: 'new wave', count: 1 },
                { name: 'synth-pop', count: 1 }
              ]
            }),
            { status: 200 }
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      };

      const res = await enrichArtistGenres(store, { fetchImpl: mockFetch, mbDelayMs: 0 });
      expect(res.resolvedCount).toBe(2); // Slowdive via Wikidata + 新裤子乐队 via MBID fallback
      expect(res.ambiguousCount).toBe(1); // Low held back as ambiguous
      expect(res.profile.topGenres.map((g) => g.name)).toEqual(
        expect.arrayContaining(['Shoegaze', 'Dream Pop', 'Ambient', 'Pop Punk', 'Synth-Pop'])
      );
      expect(res.profile.coverage.ambiguousArtistsCount).toBe(1);
      expect(res.profile.coverage.personalArtistsWithGenres).toBeGreaterThanOrEqual(3);

      // Re-running enrichment must NOT overwrite manual genres or re-query settled items
      const rerun = await enrichArtistGenres(store, { fetchImpl: async () => new Response('', { status: 500 }), mbDelayMs: 0 });
      expect(rerun.scannedArtists).toBe(0);
      const manualRow = store.database.prepare("SELECT status, manual_genres_json FROM artist_metadata WHERE artist_norm = 'manualband'").get() as {
        status: string;
        manual_genres_json: string;
      };
      expect(manualRow.status).toBe('manual');
      expect(JSON.parse(manualRow.manual_genres_json)).toEqual(['Post-Rock']);

      // Candidates matching enriched genres score higher than neutral ones & corroboration queue prioritizes taste match
      const nowIso = new Date().toISOString();
      const recentDate = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
      const shoegazeSelected = makeCandidate('New Gaze Act', 'Haze LP', ['Shoegaze', 'Dream Pop']);
      const neutralSelected = makeCandidate('Plain Act', 'Country LP', ['Bluegrass']);
      const shoegazePending: Album = {
        id: albumId('Pending Gaze', 'Needs RYM'),
        artist: 'Pending Gaze',
        title: 'Needs RYM',
        releaseDate: recentDate,
        format: 'Unknown',
        genres: ['Shoegaze'],
        excluded: false,
        sources: [{ source: 'pitchfork', score: 8.1, scale: 10, votes: null, bestNewMusic: false, url: 'https://pitchfork.com/reviews/albums/x/', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };
      const strongSingleDirect: Album = {
        id: albumId('Strong BNM', 'Instant Pick'),
        artist: 'Strong BNM',
        title: 'Instant Pick',
        releaseDate: recentDate,
        format: 'Unknown',
        genres: ['Shoegaze'],
        excluded: false,
        sources: [{ source: 'pitchfork', score: 8.5, scale: 10, votes: null, bestNewMusic: true, url: 'https://pitchfork.com/reviews/albums/strong/', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };
      const nonQualifyingPending: Album = {
        id: albumId('Low P4k', 'Below 8'),
        artist: 'Low P4k',
        title: 'Below 8',
        releaseDate: '',
        format: 'Unknown',
        genres: ['Rock'],
        excluded: false,
        sources: [{ source: 'pitchfork', score: 7.2, scale: 10, votes: null, url: 'https://pitchfork.com/reviews/albums/y/', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };
      const aotyOnlyPending: Album = {
        id: albumId('Other Pending', 'Needs RYM Too'),
        artist: 'Other Pending',
        title: 'Needs RYM Too',
        releaseDate: recentDate,
        format: 'LP',
        genres: ['Jazz'],
        excluded: false,
        sources: [{ source: 'aoty', score: 81, scale: 100, votes: 1200, url: 'https://www.albumoftheyear.org/album/2.php', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };
      store.saveAlbums([shoegazeSelected, neutralSelected, shoegazePending, strongSingleDirect, nonQualifyingPending, aotyOnlyPending]);

      expect(decide(strongSingleDirect, defaultSettings, new Date().toISOString().slice(0, 10)).status).toBe('selected');

      const recs = generateRecommendations(store);
      const shoegazeRec = recs.items.find((i) => i.album.id === shoegazeSelected.id)!;
      const neutralRec = recs.items.find((i) => i.album.id === neutralSelected.id)!;
      expect(shoegazeRec.matchIndex).toBeGreaterThan(neutralRec.matchIndex);
      expect(shoegazeRec.breakdown.genreOverlap).toBeGreaterThan(0);
      expect(shoegazeRec.breakdown.matchedGenres).toEqual(expect.arrayContaining(['Shoegaze', 'Dream Pop']));

      const queue = buildCorroborationQueue(store);
      expect(queue.map((q) => q.album.id)).toEqual([shoegazePending.id, aotyOnlyPending.id]);
      expect(queue[0]!.missingSources[0]).toBe('rym');
      expect(queue[0]!.searchLinks[0]!.url).toContain('google.com/search');
      expect(queue[0]!.searchLinks[0]!.url).not.toContain('rateyourmusic.com/search');

      // Retained monthly admission warning clarifies existing playlist membership
      const nowMonth = new Intl.DateTimeFormat('en-CA', { timeZone: defaultSettings.schedule.timezone, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
      const retainedAlbum: Album = { ...shoegazeSelected, match: null, admittedMonth: nowMonth, decision: decide(shoegazeSelected, defaultSettings, new Date().toISOString().slice(0, 10)) };
      const preview = planSync([retainedAlbum], defaultSettings, [{ month: nowMonth, id: 'pl', originalId: 1, name: `高分新专辑｜${nowMonth}`, url: '', albumIds: [retainedAlbum.id], trackCount: 5, updatedAt: nowIso }], new Date());
      expect(preview.warnings[0]).toContain(`已在本月歌单（${nowMonth}）中`);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges collaborative release splits and enriches catalog metadata without fetching ratings sites, and accepts Pitchfork evidence through capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-corroborate-'));
    // Simulate a 002 database before 003_catalog_cache migration
    const pre003 = new DatabaseSync(join(dir, 'album-relay.sqlite'));
    pre003.exec(`
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
    `);
    pre003.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('albums', '[]');
    const migTime = new Date().toISOString();
    pre003.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('001_personal_taste', migTime);
    pre003.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('002_artist_metadata', migTime);
    pre003.close();

    const store = new Store(dir);
    try {
      expect(existsSync(join(dir, 'backups', 'pre-003_catalog_cache.sqlite'))).toBe(true);

      const nowIso = new Date().toISOString();
      const recentDate = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);

      // Collaborative identity checks
      expect(
        isCollaborativeSameRelease(
          { artist: 'Denzel Curry & Kenneth Blume', title: 'ii', releaseDate: recentDate, format: 'LP' },
          { artist: 'Denzel Curry / Kenny Beats', title: 'II', releaseDate: recentDate, format: 'LP' }
        )
      ).toBe(true);
      expect(
        isCollaborativeSameRelease(
          { artist: 'Denzel Curry', title: 'ii', releaseDate: recentDate, format: 'LP' },
          { artist: 'Denzel Curry Band', title: 'ii', releaseDate: recentDate, format: 'LP' }
        )
      ).toBe(false);

      const splitA: Album = {
        id: albumId('Denzel Curry & Kenneth Blume', 'ii'),
        artist: 'Denzel Curry & Kenneth Blume',
        title: 'ii',
        releaseDate: recentDate,
        format: 'LP',
        genres: ['Southern Hip Hop'],
        excluded: false,
        sources: [{ source: 'aoty', score: 84, scale: 100, votes: 9000, url: 'https://www.albumoftheyear.org/album/1943093-ii.php', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };
      const splitB: Album = {
        id: albumId('Denzel Curry / Kenny Beats', 'II'),
        artist: 'Denzel Curry / Kenny Beats',
        title: 'II',
        releaseDate: recentDate,
        format: 'LP',
        genres: ['Boom Bap'],
        excluded: false,
        sources: [{ source: 'rym', score: 3.7, scale: 5, votes: 4000, url: 'https://rateyourmusic.com/release/album/denzel-curry-and-kenneth-blume/ii/', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };
      const kaliPending: Album = {
        id: albumId('Kali Malone', 'Burning Song'),
        artist: 'Kali Malone',
        title: 'Burning Song',
        releaseDate: '',
        format: 'Unknown',
        genres: ['Drone'],
        excluded: false,
        sources: [{ source: 'pitchfork', score: 8.1, scale: 10, votes: null, url: 'https://pitchfork.com/reviews/albums/kali-malone-burning-song/', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture', notes: 'Editorial review list capture' }]
      };
      const sundayArchival: Album = {
        id: albumId('Donald Fagen', 'The Nightfly'),
        artist: 'Donald Fagen',
        title: 'The Nightfly',
        releaseDate: '',
        format: 'Unknown',
        genres: ['Rock'],
        excluded: false,
        sources: [{ source: 'pitchfork', score: 9.3, scale: 10, votes: null, url: 'https://pitchfork.com/reviews/albums/donald-fagen-the-nightfly/', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture', notes: 'Editorial review list capture' }]
      };
      const aotyPromoting: Album = {
        id: albumId('2hollis', 'Pirouette'),
        artist: '2hollis',
        title: 'Pirouette',
        releaseDate: recentDate,
        format: 'LP',
        genres: ['Electropop'],
        excluded: false,
        sources: [{ source: 'aoty', score: 81, scale: 100, votes: 1800, url: 'https://www.albumoftheyear.org/album/100-2hollis-pirouette.php', observedAt: nowIso, status: 'ok', collectionMethod: 'browser-capture' }]
      };

      const dedupTest = dedupeCollaborativeAlbums([splitA, splitB]);
      expect(dedupTest.mergedCount).toBe(1);
      expect(dedupTest.albums[0]!.sources).toHaveLength(2);

      store.saveAlbums([splitA, splitB, kaliPending, sundayArchival, aotyPromoting]);

      // Verify saveCapture merges future collaborative updates directly
      const receipt = saveCapture(store, {
        source: 'rym',
        pageUrl: 'https://rateyourmusic.com/charts/top/album/2026/1/',
        observedAt: nowIso,
        albums: [{
          id: albumId('2hollis feat. Friend', 'Pirouette'),
          artist: '2hollis feat. Friend',
          title: 'Pirouette',
          releaseDate: recentDate,
          format: 'LP',
          genres: ['Hyperpop'],
          excluded: false,
          sources: [] // will merge cleanly when non-conflicting URL
        }],
        warnings: []
      });
      expect(receipt.updated).toBe(1);
      expect(store.albums()).toHaveLength(5);

      const pfArticle = (artist: string, title: string, score: number, extra: Record<string, unknown> = {}) =>
        `<script>window.__PRELOADED_STATE__=${JSON.stringify({
          transformed: { review: { headerProps: { artists: [{ name: artist }], title, musicRating: { rating: score, bestNewMusic: false, bestNewReissue: false }, ...extra } } }
        })};</script>`;

      const requests: string[] = [];
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith('https://itunes.apple.com/search?term=')) {
          if (url.includes('Kali')) {
            return new Response(JSON.stringify({
              results: [{ artistName: 'Kali Malone', collectionName: 'Burning Song', collectionType: 'Album', trackCount: 7, releaseDate: `${recentDate}T08:00:00Z`, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg' }]
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (url.startsWith('https://api.deezer.com/')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (url.includes('query.wikidata.org/sparql')) {
          return new Response(JSON.stringify({
            results: {
              bindings: [{
                title: { value: 'Burning Song' },
                artistLabel: { value: 'Kali Malone' },
                rymRel: { value: 'album/kali-malone/burning-song' }
              }]
            }
          }), { status: 200 });
        }
        return new Response('', { status: 404 });
      };

      const res = await autoCorroborateAlbums(store, {
        fetchImpl: mockFetch,
        catalogDelayMs: 0
      });

      expect(res.mergedDuplicates).toBe(1);
      expect([...new Set(requests.map((url) => new URL(url).hostname))].sort())
        .toEqual(['api.deezer.com', 'itunes.apple.com', 'query.wikidata.org']);
      expect(res.datesOrFormatsFilled).toBe(1);
      expect(res.pitchforkMatched).toBe(0);
      expect(res.directUrlsResolved).toBe(1); // Kali Malone direct RYM URL cached

      const archiveUrl = sundayArchival.sources[0]!.url;
      saveCapture(store, parseCapturedPage('pitchfork', pfArticle('Donald Fagen', 'The Nightfly', 9.3, {
        infoSliceFields: { releaseYear: 1982, reviewDate: '2026-11-15' }
      }), archiveUrl));
      const agreedUrl = 'https://pitchfork.com/reviews/albums/2hollis-pirouette/';
      saveCapture(store, parseCapturedPage('pitchfork', pfArticle('2hollis', 'Pirouette', 8.2), agreedUrl));
      const finalAlbums = store.albums();
      expect(finalAlbums.find((a) => a.id === sundayArchival.id)?.decision?.status).toBe('out_of_window');
      expect(finalAlbums.find((a) => a.id === aotyPromoting.id)?.decision?.status).toBe('selected');
      const updatedKali = finalAlbums.find((a) => a.id === kaliPending.id)!;
      expect(updatedKali.releaseDate).toBe(recentDate);
      expect(updatedKali.format).toBe('LP');

      // Direct Wikidata RYM release URL surfaces cleanly in corroboration queue instead of rateyourmusic.com/search
      const queue = buildCorroborationQueue(store);
      const kaliQueueItem = queue.find((q) => q.album.id === kaliPending.id)!;
      expect(kaliQueueItem.searchLinks.find((l) => l.source === 'rym')?.url).toBe('https://rateyourmusic.com/release/album/kali-malone/burning-song/');
      expect(queue.every((q) => q.searchLinks.every((l) => !l.url.includes('rateyourmusic.com/search')))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
