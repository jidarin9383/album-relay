import { normalizeIdentity } from './sources/parsers.js';

/** CDN hosts that reject cross-origin hotlinking or send Cross-Origin-Resource-Policy: same-origin. */
const BLOCKED_COVER_HOSTS = new Set([
  'cdn.albumoftheyear.org',
  'cdn2.albumoftheyear.org',
  'e.snmc.io'
]);

const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_LOOKUPS = 2;

let activeCount = 0;
const waitQueue: (() => void)[] = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeCount >= MAX_CONCURRENT_LOOKUPS) {
    await new Promise<void>((resolve) => waitQueue.push(resolve));
  }
  activeCount++;
  try {
    return await fn();
  } finally {
    activeCount--;
    const next = waitQueue.shift();
    if (next) next();
  }
}

export function isDirectlyLoadableCover(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    return !BLOCKED_COVER_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const stripEditionSuffix = (s: string): string =>
  s.replace(/\s*(?:\((?:explicit|deluxe[^)]*)\)|-\s*(?:ep|single))$/i, '').trim();

function titleMatches(candidate: string | undefined, albumTitle: string): boolean {
  if (!candidate) return false;
  const target = normalizeIdentity(albumTitle);
  if (!target) return false;
  if (normalizeIdentity(candidate) === target) return true;
  const cleanTarget = normalizeIdentity(stripEditionSuffix(albumTitle));
  const cleanCandidate = normalizeIdentity(stripEditionSuffix(candidate));
  return Boolean(cleanTarget && cleanCandidate === cleanTarget);
}

function artistMatches(candidate: string | undefined, albumArtist: string): boolean {
  if (!candidate) return false;
  const target = normalizeIdentity(albumArtist);
  const cand = normalizeIdentity(candidate);
  if (!target || !cand) return false;
  if (cand === target) return true;
  const primary = albumArtist.split(/\s*(?:&|\/|,|\band\b|\bwith\b)\s*/i)[0]?.trim() ?? '';
  const normPrimary = normalizeIdentity(primary);
  return normPrimary.length >= 2 && cand === normPrimary;
}

interface ItunesSearchResult {
  results?: { artistName?: string; collectionName?: string; artworkUrl100?: string }[];
}

interface DeezerSearchResult {
  data?: { title?: string; cover_medium?: string; cover_big?: string; artist?: { name?: string } }[];
}

/**
 * Resolve a browser-loadable cover URL from public catalog APIs (iTunes, then Deezer)
 * when the album lacks a directly loadable cover URL. Never throws.
 */
export async function resolvePublicCover(
  artist: string,
  title: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (!artist.trim() || !title.trim()) return null;
  return withConcurrencyLimit(async () => {
    const query = encodeURIComponent(`${artist} ${title}`);
    try {
      const itRes = await fetchImpl(
        `https://itunes.apple.com/search?term=${query}&entity=album&limit=5`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      );
      if (itRes.ok) {
        const body = (await itRes.json()) as ItunesSearchResult;
        const match = (body.results ?? []).find(
          (r) => r.artworkUrl100 && titleMatches(r.collectionName, title) && artistMatches(r.artistName, artist)
        );
        if (match?.artworkUrl100) {
          const sized = match.artworkUrl100.replace(/\/100x100bb\./, '/300x300bb.');
          if (isDirectlyLoadableCover(sized)) return sized;
        }
      }
    } catch {
      // Fall through to Deezer lookup.
    }
    try {
      const dzRes = await fetchImpl(
        `https://api.deezer.com/search/album?q=${query}&limit=5`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      );
      if (dzRes.ok) {
        const body = (await dzRes.json()) as DeezerSearchResult;
        const match = (body.data ?? []).find(
          (r) => (r.cover_medium || r.cover_big) && titleMatches(r.title, title) && artistMatches(r.artist?.name, artist)
        );
        const url = match?.cover_medium || match?.cover_big;
        if (isDirectlyLoadableCover(url)) return url!;
      }
    } catch {
      // Ignore upstream timeout/network failure and let UI render placeholder.
    }
    return null;
  });
}
