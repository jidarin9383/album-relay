import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS, saveAiSettings } from '../server/ai/client.js';
import { generateRecommendationsSmart } from '../server/ai/curator.js';
import { ReviewQueue } from '../server/ai/reviews.js';
import { AutomationCoordinator } from '../server/automation.js';
import { buildListenLinks, resolveAlbumListenLinks } from '../server/links.js';
import { NeteaseClient, type CommandRunner } from '../server/netease.js';
import { autoCorroborateAlbums, type CorroborationStats } from '../server/personal/corroborate.js';
import { enrichArtistGenres } from '../server/personal/enrichment.js';
import { buildTasteProfile } from '../server/personal/profile.js';
import { generateRecommendations, listRecommendationSets } from '../server/recommendations/ranker.js';
import { Runner } from '../server/runner.js';
import { Store } from '../server/store.js';
import type { Album } from '../shared/types.js';

vi.mock('../server/links.js', async (original) => ({
  ...await original<typeof import('../server/links.js')>(),
  resolveAlbumListenLinks: vi.fn()
}));
vi.mock('../server/ai/curator.js', () => ({ generateRecommendationsSmart: vi.fn() }));
vi.mock('../server/personal/corroborate.js', () => ({ autoCorroborateAlbums: vi.fn() }));
vi.mock('../server/personal/enrichment.js', async (original) => ({
  ...await original<typeof import('../server/personal/enrichment.js')>(),
  enrichArtistGenres: vi.fn()
}));

const unchanged: CorroborationStats = {
  mergedDuplicates: 0,
  datesOrFormatsFilled: 0,
  pitchforkMatched: 0,
  newlySelectedCount: 0,
  archivedOutOfWindowCount: 0,
  directUrlsResolved: 0
};

let dir: string;
let store: Store;
let automation: AutomationCoordinator;
let netease: NeteaseClient;
let command: ReturnType<typeof vi.fn<CommandRunner>>;
let reviewQueue: ReviewQueue;
let runner: Runner;

function selected(id: string): Album {
  return {
    id, artist: 'Artist', title: id, releaseDate: '2026-11-08', format: 'LP',
    genres: [], excluded: false,
    sources: [{
      source: 'rym', status: 'ok', score: 4, scale: 5, votes: 500,
      url: 'https://rateyourmusic.com/release/album/artist/album/',
      observedAt: new Date().toISOString()
    }],
    decision: { status: 'selected', qualifyingSources: ['rym'], reasons: [] }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  vi.resetAllMocks();
  vi.mocked(autoCorroborateAlbums).mockResolvedValue(unchanged);
  dir = mkdtempSync(join(tmpdir(), 'relay-automation-'));
  store = new Store(dir);
  command = vi.fn<CommandRunner>().mockResolvedValue({ success: true });
  netease = new NeteaseClient(dir, { command });
  reviewQueue = new ReviewQueue();
  runner = new Runner(store, { refresh: vi.fn() }, netease);
  automation = new AutomationCoordinator({
    store, aiClient: { checkConnection: vi.fn(), completeJson: vi.fn() },
    reviewQueue, runner, netease
  });
});

afterEach(async () => {
  await automation.stop();
  await netease.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('debounces captures and runs corroboration, up to six missing links, recommendations, reviews and sync in order', async () => {
  const steps: string[] = [];
  store.saveAlbums([
    selected('cached'),
    { ...selected('captured'), capturedLinks: { spotify: 'https://open.spotify.com/album/1', youtubeMusic: 'https://music.youtube.com/playlist?list=1' } },
    { ...selected('excluded'), excluded: true },
    ...Array.from({ length: 7 }, (_, i) => selected(String(i)))
  ]);
  store.database.prepare(`INSERT INTO listen_links_cache
    (album_id, spotify_url, youtube_music_url, source, checked_at) VALUES (?, ?, ?, ?, ?)`)
    .run('cached', 'https://open.spotify.com/album/2', 'https://music.youtube.com/playlist?list=2', 'fixture', new Date().toISOString());
  saveAiSettings(store, { ...DEFAULT_AI_SETTINGS, enabled: true });
  store.setValue('netease-configured', 'true');
  vi.mocked(autoCorroborateAlbums).mockImplementationOnce(async () => {
    steps.push('corroborate');
    return unchanged;
  });
  vi.mocked(resolveAlbumListenLinks).mockImplementation(async (_db, album) => {
    steps.push(album.id);
    return buildListenLinks(album);
  });
  vi.mocked(generateRecommendationsSmart).mockImplementationOnce(async (db) => {
    steps.push('recommend');
    return generateRecommendations(db);
  });
  const enqueue = vi.spyOn(reviewQueue, 'enqueueSelected').mockImplementation(() => {
    steps.push('review');
    return { queuedCount: 0, totalSelected: 0 };
  });
  vi.spyOn(runner, 'start').mockImplementation((mode) => {
    steps.push(mode);
    return { mode, id: 'fixture', stage: 'queued', status: 'queued', startedAt: new Date().toISOString(), message: '', logs: [] };
  });
  vi.spyOn(runner, 'wait').mockImplementation(async () => { steps.push('wait'); });
  command.mockImplementation(async () => { steps.push('login-check'); return { success: true }; });

  automation.scheduleAfterCapture(40);
  await vi.advanceTimersByTimeAsync(30);
  automation.scheduleAfterCapture(40);
  await vi.advanceTimersByTimeAsync(39);
  expect(steps).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(steps).toEqual(['corroborate', '0', '1', '2', '3', '4', '5', 'recommend', 'review', 'login-check', 'auto_sync', 'wait']);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it.each([
  { autoSync: false, configured: true, loggedIn: true, ai: false, autoReview: true, checks: 0 },
  { autoSync: true, configured: false, loggedIn: true, ai: true, autoReview: false, checks: 0 },
  { autoSync: true, configured: true, loggedIn: false, ai: false, autoReview: true, checks: 1 }
])('gates reviews and automatic sync with configuration and login', async ({ autoSync, configured, loggedIn, ai, autoReview, checks }) => {
  store.saveSettings({ ...store.settings(), autoSyncPlaylist: autoSync });
  store.setValue('netease-configured', String(configured));
  command.mockResolvedValue({ success: loggedIn });
  saveAiSettings(store, { ...DEFAULT_AI_SETTINGS, enabled: ai, autoReviewSelected: autoReview });
  const enqueue = vi.spyOn(reviewQueue, 'enqueueSelected');
  const start = vi.spyOn(runner, 'start');
  automation.triggerNow();
  await vi.advanceTimersByTimeAsync(0);
  expect(generateRecommendationsSmart).toHaveBeenCalledTimes(1);
  expect(enqueue).not.toHaveBeenCalled();
  expect(command).toHaveBeenCalledTimes(checks);
  expect(start).not.toHaveBeenCalled();
});

it('retries a capture after contention without taking over the external lock', async () => {
  expect(store.acquireLock('external')).toBe(true);
  automation.scheduleAfterCapture(40);
  await vi.advanceTimersByTimeAsync(40);
  expect(autoCorroborateAlbums).not.toHaveBeenCalled();
  expect(store.acquireLock('other')).toBe(false);
  store.releaseLock('external');
  await vi.advanceTimersByTimeAsync(4999);
  expect(autoCorroborateAlbums).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(autoCorroborateAlbums).toHaveBeenCalledTimes(1);
  expect(generateRecommendationsSmart).toHaveBeenCalledTimes(1);
  expect(store.acquireLock('other')).toBe(true);
});

it('preserves an enrichment request through taste debouncing and lock contention', async () => {
  vi.mocked(enrichArtistGenres).mockResolvedValue({
    remainingPendingCount: 0, scannedArtists: 1, resolvedCount: 1, ambiguousCount: 0, notFoundCount: 0,
    profile: buildTasteProfile(store)
  });
  expect(store.acquireLock('external')).toBe(true);
  automation.scheduleAfterTasteChange(true, 40);
  await vi.advanceTimersByTimeAsync(30);
  automation.scheduleAfterTasteChange(false, 40);
  await vi.advanceTimersByTimeAsync(40);
  expect(enrichArtistGenres).not.toHaveBeenCalled();
  expect(generateRecommendationsSmart).not.toHaveBeenCalled();
  store.releaseLock('external');
  await vi.advanceTimersByTimeAsync(5000);
  expect(enrichArtistGenres).toHaveBeenCalledTimes(1);
  expect(generateRecommendationsSmart).toHaveBeenCalledTimes(1);
  expect(vi.mocked(enrichArtistGenres).mock.invocationCallOrder[0]!)
    .toBeLessThan(vi.mocked(generateRecommendationsSmart).mock.invocationCallOrder[0]!);
});

it('bootstraps once when a selected album exists and no recommendation set exists', async () => {
  vi.mocked(generateRecommendationsSmart).mockImplementation(async (db) => generateRecommendations(db));
  automation.bootstrapIfNeeded();
  await vi.advanceTimersByTimeAsync(500);
  expect(listRecommendationSets(store)).toHaveLength(0);

  store.saveAlbums([selected('seed')]);
  automation.bootstrapIfNeeded();
  await vi.advanceTimersByTimeAsync(500);
  expect(listRecommendationSets(store)).toHaveLength(1);
  automation.bootstrapIfNeeded();
  await vi.advanceTimersByTimeAsync(500);
  expect(generateRecommendationsSmart).toHaveBeenCalledTimes(1);
});

it('clears all pending timers and waits for in-flight work before shutdown', async () => {
  let finish!: () => void;
  const active = new Promise<CorroborationStats>((resolve) => { finish = () => resolve(unchanged); });
  vi.mocked(autoCorroborateAlbums).mockReturnValueOnce(active);
  automation.triggerNow();
  await vi.advanceTimersByTimeAsync(0);
  expect(autoCorroborateAlbums).toHaveBeenCalledTimes(1);
  automation.scheduleAfterCapture();
  automation.scheduleAfterTasteChange(true);
  automation.bootstrapIfNeeded();
  let stopped = false;
  const shutdown = automation.stop().then(() => { stopped = true; });
  await Promise.resolve();
  const stoppedBeforeRelease = stopped;
  const pendingTimers = vi.getTimerCount();
  finish();
  await shutdown;
  expect(stoppedBeforeRelease).toBe(false);
  expect(pendingTimers).toBe(0);
  expect(generateRecommendationsSmart).not.toHaveBeenCalled();
  expect(store.acquireLock('after-stop')).toBe(true);
});
