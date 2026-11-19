import { randomUUID } from 'node:crypto';
import type { FeedbackQueueState, FeedbackReaction } from '../../shared/personal.js';
import type { Album, ListeningStatus } from '../../shared/types.js';
import type { Store } from '../store.js';
import { normalizeIdentity } from '../sources/parsers.js';

function mapStatus(
  status: ListeningStatus,
  explicitReaction?: FeedbackReaction
): { queueState: FeedbackQueueState; reaction: FeedbackReaction | null; weight: number } {
  if (explicitReaction === 'disliked') return { queueState: 'skipped', reaction: 'disliked', weight: -2.5 };
  if (explicitReaction === 'liked' || status === 'liked') return { queueState: 'listened', reaction: 'liked', weight: 2.2 };
  switch (status) {
    case 'saved':
      return { queueState: 'saved', reaction: null, weight: 0.3 };
    case 'listened':
      return { queueState: 'listened', reaction: null, weight: 0.35 };
    case 'disliked':
      return { queueState: 'listened', reaction: 'neutral', weight: -0.4 };
    case 'skipped':
      return { queueState: 'skipped', reaction: null, weight: -0.1 };
    default:
      return { queueState: 'unheard', reaction: null, weight: 0 };
  }
}

/** Appends a timestamped user feedback event without overwriting historical actions. */
export function recordAlbumFeedback(
  store: Store,
  album: Album,
  status: ListeningStatus,
  explicitReaction?: FeedbackReaction,
  context = 'library-ui'
): void {
  const now = new Date().toISOString();
  const mapped = mapStatus(status, explicitReaction);
  const artistNorm = normalizeIdentity(album.artist);
  const titleNorm = normalizeIdentity(album.title);
  store.database.prepare(`
    INSERT INTO preference_signals(
      id, batch_id, source, entity_type, artist, artist_norm, title, title_norm,
      album, album_norm, genres_json, candidate_id, queue_state, reaction, rating,
      weight, action_at, observed_at, context, source_signal_key
    ) VALUES (?, NULL, 'in-app', 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)
  `).run(
    randomUUID(),
    album.artist,
    artistNorm,
    album.title,
    titleNorm,
    album.title,
    titleNorm,
    JSON.stringify(album.genres ?? []),
    album.id,
    mapped.queueState,
    mapped.reaction,
    mapped.weight,
    now,
    now,
    context
  );
}

/** Records a cold-start manual favorite artist or album. */
export function addManualFavorite(
  store: Store,
  input: { artist: string; title?: string; genres?: string[] }
): void {
  const artist = input.artist.trim();
  const title = input.title?.trim() || artist;
  const artistNorm = normalizeIdentity(artist);
  const titleNorm = normalizeIdentity(title);
  if (!artistNorm) throw new Error('请填写艺人名称');
  const now = new Date().toISOString();
  store.database.prepare(`
    INSERT INTO preference_signals(
      id, batch_id, source, entity_type, artist, artist_norm, title, title_norm,
      album, album_norm, genres_json, candidate_id, queue_state, reaction, rating,
      weight, action_at, observed_at, context, source_signal_key
    ) VALUES (?, NULL, 'in-app-favorite', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'liked', NULL, 2.0, ?, ?, 'manual-cold-start', NULL)
  `).run(
    randomUUID(),
    input.title?.trim() ? 'album' : 'artist',
    artist,
    artistNorm,
    title,
    titleNorm,
    title,
    titleNorm,
    JSON.stringify([...new Set((input.genres ?? []).map((g) => g.trim()).filter(Boolean))]),
    now,
    now
  );
}
