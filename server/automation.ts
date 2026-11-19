import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { LlmClient } from './ai/client.js';
import { getAiSettings } from './ai/client.js';
import { generateRecommendationsSmart } from './ai/curator.js';
import type { ReviewQueue } from './ai/reviews.js';
import { resolveAlbumListenLinks, readListenLinksCacheMap } from './links.js';
import type { NeteaseClient } from './netease.js';
import { autoCorroborateAlbums } from './personal/corroborate.js';
import { enrichArtistGenres } from './personal/enrichment.js';
import { listRecommendationSets } from './recommendations/ranker.js';
import type { Runner } from './runner.js';

export interface AutomationDeps {
  store: Store;
  aiClient: LlmClient;
  reviewQueue: ReviewQueue;
  runner: Runner;
  netease: NeteaseClient;
}

/**
 * Coordinates debounced, non-overlapping background automation whenever new pages are captured,
 * personal taste data changes, or rules are updated.
 */
export class AutomationCoordinator {
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private tasteTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEnrich = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AutomationDeps) {}

  private async withLock<T>(prefix: string, fn: () => Promise<T> | T): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const owner = `auto:${prefix}:${randomUUID()}`;
    if (!this.deps.store.acquireLock(owner)) return { acquired: false };
    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      this.deps.store.releaseLock(owner);
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.stopped) return this.queue;
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped) await task();
      })
      .catch(() => {
        // Keep the background coordinator resilient; failures never crash the server.
      });
    return this.queue;
  }

  scheduleAfterCapture(delayMs = 8000): void {
    if (this.stopped) return;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      this.enqueue(() => this.runCapturePipeline());
    }, delayMs);
    this.captureTimer.unref?.();
  }

  scheduleAfterTasteChange(enrichArtists: boolean, delayMs = 1500): void {
    if (this.stopped) return;
    if (enrichArtists) this.pendingEnrich = true;
    if (this.tasteTimer) clearTimeout(this.tasteTimer);
    this.tasteTimer = setTimeout(() => {
      this.tasteTimer = null;
      const shouldEnrich = this.pendingEnrich;
      this.pendingEnrich = false;
      this.enqueue(() => this.runTastePipeline(shouldEnrich));
    }, delayMs);
    this.tasteTimer.unref?.();
  }

  bootstrapIfNeeded(): void {
    if (this.stopped || this.bootstrapTimer) return;
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = null;
      this.enqueue(async () => {
        const { store, aiClient } = this.deps;
        const hasSelected = store.albums().some((a) => !a.excluded && a.decision?.status === 'selected');
        if (hasSelected && listRecommendationSets(store, 1).length === 0) {
          await generateRecommendationsSmart(store, {}, aiClient);
        }
      });
    }, 500);
    this.bootstrapTimer.unref?.();
  }

  triggerNow(): Promise<void> {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    return this.enqueue(() => this.runCapturePipeline());
  }

  private async runCapturePipeline(): Promise<void> {
    if (this.stopped) return;
    const { store, aiClient, reviewQueue, runner, netease } = this.deps;

    const corr = await this.withLock('corroborate', () => autoCorroborateAlbums(store));
    if (!corr.acquired) {
      if (!this.stopped) this.scheduleAfterCapture(5000);
      return;
    }

    if (this.stopped) return;
    const cacheMap = readListenLinksCacheMap(store);
    const linkTargets = store
      .albums()
      .filter((a) => !a.excluded && a.decision?.status === 'selected')
      .filter((a) => {
        const c = cacheMap.get(a.id);
        return !(c?.spotify_url || a.capturedLinks?.spotify) || !(c?.youtube_music_url || a.capturedLinks?.youtubeMusic);
      })
      .slice(0, 6);

    for (const album of linkTargets) {
      if (this.stopped) return;
      try {
        await resolveAlbumListenLinks(store, album);
      } catch {
        // Ignore transient third-party lookup failures.
      }
    }

    if (this.stopped) return;
    try {
      await generateRecommendationsSmart(store, {}, aiClient);
    } catch {
      // Fallback already logged/handled inside generateRecommendationsSmart.
    }

    if (this.stopped) return;
    const aiCfg = getAiSettings(store);
    if (aiCfg.enabled && aiCfg.autoReviewSelected) {
      reviewQueue.enqueueSelected(store, aiClient);
    }

    if (this.stopped) return;
    const settings = store.settings();
    if (settings.autoSyncPlaylist !== false && store.getValue('netease-configured') === 'true') {
      try {
        const status = await netease.status();
        if (status.loggedIn && !this.stopped) {
          runner.start('auto_sync');
          await runner.wait();
        }
      } catch {
        // Skip auto sync if NetEase CLI check fails or runner lock is busy.
      }
    }
  }

  private async runTastePipeline(shouldEnrich: boolean): Promise<void> {
    if (this.stopped) return;
    const { store, aiClient } = this.deps;
    if (shouldEnrich) {
      for (let round = 0; round < 2; round++) {
        if (this.stopped) return;
        const step = await this.withLock('enrich', () => enrichArtistGenres(store));
        if (!step.acquired) {
          this.scheduleAfterTasteChange(true, 5000);
          return;
        }
        if (step.value.remainingPendingCount === 0 || step.value.scannedArtists === 0) break;
      }
    }
    if (this.stopped) return;
    try {
      await generateRecommendationsSmart(store, {}, aiClient);
    } catch {
      // Non-fatal
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.tasteTimer) {
      clearTimeout(this.tasteTimer);
      this.tasteTimer = null;
    }
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    await this.queue;
  }
}
