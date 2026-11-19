import type { Album, ListenLinks, SourceName } from '../shared/types.js';
import type { Store } from './store.js';
import { artistMatches, titleMatches } from './covers.js';
import {
  normalizeAppleMusicUrl,
  normalizeSpotifyAlbumUrl,
  normalizeYoutubeMusicUrl,
  origins
} from './sources/parsers.js';

export { normalizeSpotifyAlbumUrl, normalizeYoutubeMusicUrl };

export interface ListenLinksCacheRow {
  album_id: string;
  spotify_url: string | null;
  youtube_music_url: string | null;
  apple_music_url: string | null;
  source: string;
  checked_at: string;
}

const REQUEST_TIMEOUT_MS = 8000;
const ODESLI_MIN_INTERVAL_MS = 6500;

let odesliQueue: Promise<unknown> = Promise.resolve();
let lastOdesliCallMs = 0;

function enqueueOdesli<T>(skipDelay: boolean, fn: () => Promise<T>): Promise<T> {
  const run = odesliQueue.then(async () => {
    if (!skipDelay) {
      const wait = ODESLI_MIN_INTERVAL_MS - (Date.now() - lastOdesliCallMs);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    try {
      return await fn();
    } finally {
      if (!skipDelay) lastOdesliCallMs = Date.now();
    }
  });
  odesliQueue = run.catch(() => {});
  return run;
}

const SOURCE_DETAIL_PATTERNS: Record<SourceName, RegExp> = {
  rym: /^\/release\/(?:album|ep|comp|single|mixtape|unauth|video|djmix|additional)\/[^/]+\/[^/]+\/?$/,
  aoty: /^\/album\/\d+[^/]*\.php$/,
  pitchfork: /^\/reviews\/albums\/[^/]+\/?$/
};

/** Returns true only when the URL points to an actual release/review detail page (not search or chart index). */
export function isCanonicalSourceDetailUrl(source: SourceName, url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.origin !== origins[source]) return false;
    return SOURCE_DETAIL_PATTERNS[source].test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Builds a valid search fallback URL for a rating source using accurate query parameters. */
export function buildSourceSearchUrl(source: SourceName, artist: string, title: string): string {
  const q = encodeURIComponent(`${artist} ${title}`.trim());
  if (source === 'rym') {
    return `https://www.google.com/search?q=${encodeURIComponent(`site:rateyourmusic.com/release/album "${artist}" "${title}"`)}`;
  }
  if (source === 'aoty') return `${origins.aoty}/search/?q=${q}`;
  return `${origins.pitchfork}/search/?q=${q}`;
}

/**
 * Builds the ordered 3-platform listening links for an album (NetEase -> Spotify -> YouTube Music),
 * preferring direct album links and falling back honestly to search URLs.
 */
export function buildListenLinks(
  album: Album,
  cached?: { spotify_url?: string | null; youtube_music_url?: string | null }
): ListenLinks {
  const queryText = `${album.artist} ${album.title}`.trim();
  const encodedQuery = encodeURIComponent(queryText);

  const netease = album.match?.originalId
    ? {
        url: `https://music.163.com/#/album?id=${album.match.originalId}`,
        direct: true,
        source: 'matched' as const
      }
    : {
        url: `https://music.163.com/#/search/m/?s=${encodedQuery}&type=10`,
        direct: false,
        source: 'search' as const
      };

  const capturedSpotify = normalizeSpotifyAlbumUrl(album.capturedLinks?.spotify);
  const cachedSpotify = normalizeSpotifyAlbumUrl(cached?.spotify_url);
  const spotify = capturedSpotify
    ? { url: capturedSpotify, direct: true, source: 'captured' as const }
    : cachedSpotify
      ? { url: cachedSpotify, direct: true, source: 'odesli' as const }
      : {
          url: `https://open.spotify.com/search/${encodedQuery}/albums`,
          direct: false,
          source: 'search' as const
        };

  const capturedYt = normalizeYoutubeMusicUrl(album.capturedLinks?.youtubeMusic);
  const cachedYt = normalizeYoutubeMusicUrl(cached?.youtube_music_url);
  const youtubeMusic = capturedYt
    ? { url: capturedYt, direct: true, source: 'captured' as const }
    : cachedYt
      ? { url: cachedYt, direct: true, source: 'odesli' as const }
      : {
          url: `https://music.youtube.com/search?q=${encodedQuery}`,
          direct: false,
          source: 'search' as const
        };

  return { netease, spotify, youtubeMusic };
}

export function readListenLinksCacheMap(
  store: Store
): Map<string, { spotify_url: string | null; youtube_music_url: string | null; apple_music_url: string | null }> {
  const rows = store.database
    .prepare('SELECT album_id, spotify_url, youtube_music_url, apple_music_url FROM listen_links_cache')
    .all() as { album_id: string; spotify_url: string | null; youtube_music_url: string | null; apple_music_url: string | null }[];
  const map = new Map<string, { spotify_url: string | null; youtube_music_url: string | null; apple_music_url: string | null }>();
  for (const row of rows) map.set(row.album_id, row);
  return map;
}

interface ItunesAlbumResponse {
  results?: { artistName?: string; collectionName?: string; collectionViewUrl?: string }[];
}

interface OdesliResponse {
  linksByPlatform?: {
    spotify?: { url?: string };
    youtubeMusic?: { url?: string };
    youtube?: { url?: string };
    appleMusic?: { url?: string };
  };
}

/**
 * Resolves direct Spotify / YouTube Music / Apple Music links via captured seed URLs or iTunes -> Odesli,
 * caching the result in `listen_links_cache` without mutating `config['albums']`.
 */
export async function resolveAlbumListenLinks(
  store: Store,
  album: Album,
  options?: { fetchImpl?: typeof fetch }
): Promise<ListenLinks> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const skipDelay = Boolean(options?.fetchImpl);

  const existing = store.database
    .prepare('SELECT spotify_url, youtube_music_url, apple_music_url FROM listen_links_cache WHERE album_id = ?')
    .get(album.id) as { spotify_url: string | null; youtube_music_url: string | null; apple_music_url: string | null } | undefined;

  let spotifyUrl = normalizeSpotifyAlbumUrl(album.capturedLinks?.spotify) ?? normalizeSpotifyAlbumUrl(existing?.spotify_url);
  let youtubeMusicUrl =
    normalizeYoutubeMusicUrl(album.capturedLinks?.youtubeMusic) ?? normalizeYoutubeMusicUrl(existing?.youtube_music_url);
  let appleMusicUrl =
    normalizeAppleMusicUrl(album.capturedLinks?.appleMusic) ?? normalizeAppleMusicUrl(existing?.apple_music_url);

  let seedUrl = spotifyUrl || appleMusicUrl;

  if (!seedUrl) {
    try {
      const query = encodeURIComponent(`${album.artist} ${album.title}`.trim());
      const itRes = await fetchFn(`https://itunes.apple.com/search?term=${query}&entity=album&limit=5`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (itRes.ok) {
        const body = (await itRes.json()) as ItunesAlbumResponse;
        const match = (body.results ?? []).find(
          (r) => r.collectionViewUrl && titleMatches(r.collectionName, album.title) && artistMatches(r.artistName, album.artist)
        );
        const foundApple = normalizeAppleMusicUrl(match?.collectionViewUrl);
        if (foundApple) {
          appleMusicUrl = foundApple;
          seedUrl = foundApple;
        }
      }
    } catch {
      // Fall through cleanly; search fallbacks remain available.
    }
  }

  let resolvedViaOdesli = false;
  if (seedUrl && (!spotifyUrl || !youtubeMusicUrl)) {
    try {
      const data = await enqueueOdesli(skipDelay, async () => {
        const res = await fetchFn(
          `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(seedUrl!)}&userCountry=US`,
          { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
        );
        if (!res.ok) return null;
        return (await res.json()) as OdesliResponse;
      });
      if (data?.linksByPlatform) {
        const sp = normalizeSpotifyAlbumUrl(data.linksByPlatform.spotify?.url);
        const yt = normalizeYoutubeMusicUrl(data.linksByPlatform.youtubeMusic?.url ?? data.linksByPlatform.youtube?.url);
        const am = normalizeAppleMusicUrl(data.linksByPlatform.appleMusic?.url);
        if (sp) {
          spotifyUrl ||= sp;
          resolvedViaOdesli = true;
        }
        if (yt) {
          youtubeMusicUrl ||= yt;
          resolvedViaOdesli = true;
        }
        if (am) appleMusicUrl ||= am;
      }
    } catch {
      // Ignore upstream rate-limit or network errors.
    }
  }

  const now = new Date().toISOString();
  const source = resolvedViaOdesli ? 'odesli' : spotifyUrl || youtubeMusicUrl || appleMusicUrl ? 'seed' : 'none';
  store.database
    .prepare(
      `INSERT INTO listen_links_cache(album_id, spotify_url, youtube_music_url, apple_music_url, source, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(album_id) DO UPDATE SET
         spotify_url = COALESCE(excluded.spotify_url, listen_links_cache.spotify_url),
         youtube_music_url = COALESCE(excluded.youtube_music_url, listen_links_cache.youtube_music_url),
         apple_music_url = COALESCE(excluded.apple_music_url, listen_links_cache.apple_music_url),
         source = excluded.source,
         checked_at = excluded.checked_at`
    )
    .run(album.id, spotifyUrl ?? null, youtubeMusicUrl ?? null, appleMusicUrl ?? null, source, now);

  return buildListenLinks(album, {
    spotify_url: spotifyUrl ?? null,
    youtube_music_url: youtubeMusicUrl ?? null
  });
}
