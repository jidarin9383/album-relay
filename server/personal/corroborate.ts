import { dedupeCollaborativeAlbums, primaryArtistNorm } from '../capture.js';
import { decide, todayInTimezone } from '../policy.js';
import { origins, normalizeIdentity } from '../sources/parsers.js';
import type { Album } from '../../shared/types.js';
import type { Store } from '../store.js';

const CACHE_TTL_MS = 7 * 86_400_000;
const REQUEST_TIMEOUT_MS = 8_000;
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'AlbumRelay/0.2.0 (+https://github.com/jidarin9383/album-relay)';
export interface CorroborateOptions {
  maxCatalogLookups?: number;
  maxWikidataUrls?: number;
  catalogDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface CorroborationStats {
  mergedDuplicates: number;
  datesOrFormatsFilled: number;
  pitchforkMatched: number;
  newlySelectedCount: number;
  archivedOutOfWindowCount: number;
  directUrlsResolved: number;
}

interface CacheEntry<T = unknown> {
  status: string;
  payload: T;
  updatedAt: string;
}

interface ItunesAlbumRow {
  artistName?: string;
  collectionName?: string;
  collectionType?: string;
  trackCount?: number;
  releaseDate?: string;
  artworkUrl100?: string;
}

interface DeezerSearchRow {
  id?: number;
  title?: string;
  record_type?: string;
  nb_tracks?: number;
  cover_medium?: string;
  cover_big?: string;
  artist?: { name?: string };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const stripEditionSuffix = (s: string): string =>
  s.replace(/\s*(?:\((?:explicit|deluxe[^)]*|remaster(?:ed)?[^)]*|anniversary[^)]*)\)|\[(?:explicit|deluxe[^\]]*)\]|-\s*(?:ep|single))$/i, '').trim();

const REISSUE_TITLE_RE = /\b(?:reissue|remaster(?:ed)?|anniversary|expanded edition)\b/i;

function primaryArtistRaw(artist: string): string {
  return artist.split(/\s*(?:&|\/|;|\bwith\b|\band\b|\bfeat\.?|\bft\.?)\s*/i)[0]?.trim() ?? artist;
}

function titleMatchesLoose(candidate: string | undefined, targetTitle: string): boolean {
  if (!candidate) return false;
  const target = normalizeIdentity(targetTitle);
  const cand = normalizeIdentity(candidate);
  if (!target || !cand) return false;
  if (cand === target) return true;
  const cleanTarget = normalizeIdentity(stripEditionSuffix(targetTitle));
  const cleanCand = normalizeIdentity(stripEditionSuffix(candidate));
  return Boolean(cleanTarget && cleanCand && cleanCand === cleanTarget);
}

function artistMatchesLoose(candidate: string | undefined, targetArtist: string): boolean {
  if (!candidate) return false;
  const target = normalizeIdentity(targetArtist);
  const cand = normalizeIdentity(candidate);
  if (!target || !cand) return false;
  if (cand === target) return true;
  const pTarget = primaryArtistNorm(targetArtist);
  const pCand = primaryArtistNorm(candidate);
  return pTarget.length >= 2 && (cand === pTarget || pCand === pTarget);
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function inferItunesFormat(item: ItunesAlbumRow): Album['format'] | null {
  const name = item.collectionName ?? '';
  if (REISSUE_TITLE_RE.test(name)) return 'Reissue';
  if (/-\s*ep\b|\bep$/i.test(name)) return 'EP';
  if (/-\s*single\b/i.test(name)) return null;
  const count = item.trackCount ?? 0;
  if (count > 0 && count <= 3) return null;
  if (item.collectionType === 'Album' && count >= 4) return 'LP';
  return count >= 6 ? 'LP' : null;
}

async function lookupItunesMetadata(
  album: Album,
  fetchImpl: typeof fetch
): Promise<{ releaseDate: string; format: Album['format']; coverUrl?: string } | null> {
  const q = encodeURIComponent(`${album.artist} ${album.title}`);
  const data = await fetchJson<{ results?: ItunesAlbumRow[] }>(
    fetchImpl,
    `https://itunes.apple.com/search?term=${q}&entity=album&limit=8`
  );
  const candidates = (data?.results ?? [])
    .filter((r) => titleMatchesLoose(r.collectionName, album.title) && artistMatchesLoose(r.artistName, album.artist))
    .map((r) => ({
      row: r,
      format: inferItunesFormat(r),
      exactTitle: normalizeIdentity(r.collectionName ?? '') === normalizeIdentity(album.title),
      isReissue: REISSUE_TITLE_RE.test(r.collectionName ?? '')
    }))
    .filter((x) => x.format !== null);

  if (!candidates.length) return null;
  candidates.sort(
    (a, b) =>
      Number(a.isReissue) - Number(b.isReissue) ||
      Number(b.exactTitle) - Number(a.exactTitle) ||
      (a.row.releaseDate ?? '').localeCompare(b.row.releaseDate ?? '')
  );
  const best = candidates[0]!;
  const releaseDate = best.row.releaseDate?.slice(0, 10) ?? '';
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ? releaseDate : '';
  const coverUrl = best.row.artworkUrl100?.replace(/\/100x100bb\./, '/300x300bb.');
  return { releaseDate: validDate, format: best.format!, ...(coverUrl ? { coverUrl } : {}) };
}

async function lookupDeezerMetadata(
  album: Album,
  fetchImpl: typeof fetch,
  delayMs: number
): Promise<{ releaseDate: string; format: Album['format']; coverUrl?: string } | null> {
  const q = encodeURIComponent(`artist:"${primaryArtistRaw(album.artist)}" album:"${album.title}"`);
  const data = await fetchJson<{ data?: DeezerSearchRow[] }>(
    fetchImpl,
    `https://api.deezer.com/search/album?q=${q}&limit=8`
  );
  const candidates = (data?.data ?? []).filter(
    (r) =>
      titleMatchesLoose(r.title, album.title) &&
      artistMatchesLoose(r.artist?.name, album.artist) &&
      r.record_type !== 'single'
  );
  if (!candidates.length) return null;
  const best = candidates[0]!;
  let releaseDate = '';
  let recordType = best.record_type ?? '';
  if (best.id && !album.releaseDate) {
    if (delayMs > 0) await sleep(delayMs);
    const detail = await fetchJson<{ release_date?: string; record_type?: string }>(
      fetchImpl,
      `https://api.deezer.com/album/${best.id}`
    );
    if (detail?.release_date && /^\d{4}-\d{2}-\d{2}$/.test(detail.release_date)) releaseDate = detail.release_date;
    if (detail?.record_type) recordType = detail.record_type;
  }
  const format: Album['format'] = REISSUE_TITLE_RE.test(best.title ?? '')
    ? 'Reissue'
    : recordType === 'ep'
      ? 'EP'
      : recordType === 'album' || (best.nb_tracks ?? 0) >= 6
        ? 'LP'
        : 'Unknown';
  const coverUrl = best.cover_medium || best.cover_big;
  if (!releaseDate && format === 'Unknown') return null;
  return { releaseDate, format, ...(coverUrl ? { coverUrl } : {}) };
}

export async function autoCorroborateAlbums(
  store: Store,
  options: CorroborateOptions = {}
): Promise<CorroborationStats> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const maxCatalogLookups = options.maxCatalogLookups ?? 45;
  const maxWikidataUrls = options.maxWikidataUrls ?? 25;
  const catalogDelayMs = options.catalogDelayMs ?? 150;

  const settings = store.settings();
  const today = todayInTimezone(settings.schedule.timezone, now);
  const db = store.database;

  // Read existing fresh cache entries before any async HTTP work
  const existingCache = new Map<string, CacheEntry>();
  const cacheRows = db.prepare('SELECT cache_key, status, payload_json, updated_at FROM catalog_cache').all() as {
    cache_key: string;
    status: string;
    payload_json: string;
    updated_at: string;
  }[];
  for (const row of cacheRows) {
    try {
      existingCache.set(row.cache_key, {
        status: row.status,
        payload: JSON.parse(row.payload_json),
        updatedAt: row.updated_at
      });
    } catch {
      // Ignore malformed cache row
    }
  }
  const isCachedFresh = (key: string, ttlMs = CACHE_TTL_MS): CacheEntry | null => {
    const entry = existingCache.get(key);
    if (!entry) return null;
    const at = Date.parse(entry.updatedAt);
    return Number.isFinite(at) && nowMs - at < ttlMs ? entry : null;
  };
  const pendingCacheWrites = new Map<string, { status: string; payload: unknown }>();

  const originalAlbums = store.albums();
  const prevStatusById = new Map<string, string>(
    originalAlbums.map((a) => [a.id, a.decision?.status ?? decide(a, settings, today).status])
  );

  // Stage 1: Merge collaborative artist variants of the same release
  const deduped = dedupeCollaborativeAlbums(originalAlbums);
  const albums = deduped.albums;
  const mergedDuplicates = deduped.mergedCount;
  let dirtyAlbums = mergedDuplicates > 0;

  let datesOrFormatsFilled = 0;
  let directUrlsResolved = 0;

  // Public catalog (iTunes Search + Deezer fallback) releaseDate & format backfill
  const catalogTargets = albums
    .filter((a) => !a.excluded && (!a.releaseDate || a.format === 'Unknown') && !isCachedFresh(`cat_miss:${a.id}`))
    .sort((a, b) => {
      const da = decide(a, settings, today);
      const dbDec = decide(b, settings, today);
      return (
        dbDec.qualifyingSources.length - da.qualifyingSources.length ||
        Number(dbDec.status === 'pending') - Number(da.status === 'pending')
      );
    })
    .slice(0, maxCatalogLookups);

  for (let i = 0; i < catalogTargets.length; i++) {
    if (i > 0 && catalogDelayMs > 0) await sleep(catalogDelayMs);
    const alb = catalogTargets[i]!;
    let meta = await lookupItunesMetadata(alb, fetchImpl);
    if (!meta || (!alb.releaseDate && !meta.releaseDate) || (alb.format === 'Unknown' && meta.format === 'Unknown')) {
      if (catalogDelayMs > 0) await sleep(catalogDelayMs);
      const dz = await lookupDeezerMetadata(alb, fetchImpl, catalogDelayMs);
      if (dz) {
        meta = {
          releaseDate: meta?.releaseDate || dz.releaseDate,
          format: meta?.format && meta.format !== 'Unknown' ? meta.format : dz.format,
          coverUrl: meta?.coverUrl || dz.coverUrl
        };
      }
    }

    let filled = false;
    if (meta) {
      if (!alb.releaseDate && meta.releaseDate) {
        alb.releaseDate = meta.releaseDate;
        filled = true;
      }
      if (alb.format === 'Unknown' && meta.format !== 'Unknown') {
        alb.format = meta.format;
        filled = true;
      }
      if (meta.coverUrl && !alb.coverUrl) {
        alb.coverUrl = meta.coverUrl;
        dirtyAlbums = true;
      }
    }
    if (filled) {
      datesOrFormatsFilled++;
      dirtyAlbums = true;
    } else if (!meta) {
      pendingCacheWrites.set(`cat_miss:${alb.id}`, { status: 'not_found', payload: {} });
    }
  }

  // Wikidata direct RYM (P8392) / AOTY (P7067) release URL lookup for remaining 1-source pending candidates
  const urlTargets = albums
    .filter((a) => {
      if (a.excluded) return false;
      const d = decide(a, settings, today);
      return d.status === 'pending' && d.qualifyingSources.length >= 1 && !isCachedFresh(`ext_urls:${a.id}`);
    })
    .slice(0, maxWikidataUrls);

  if (urlTargets.length > 0) {
    const titleToAlbums = new Map<string, Album[]>();
    const titleLiterals = new Set<string>();
    for (const a of urlTargets) {
      const cleanTitle = a.title.replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();
      if (!cleanTitle) continue;
      titleLiterals.add(`"${cleanTitle}"@en`);
      const arr = titleToAlbums.get(normalizeIdentity(cleanTitle)) ?? [];
      arr.push(a);
      titleToAlbums.set(normalizeIdentity(cleanTitle), arr);
    }

    if (titleLiterals.size > 0) {
      const query = `SELECT ?title ?item ?rymRel ?aotyId ?artistLabel WHERE { VALUES ?title { ${[...titleLiterals].join(' ')} } ?item rdfs:label ?title . OPTIONAL { ?item wdt:P8392 ?rymRel . } OPTIONAL { ?item wdt:P7067 ?aotyId . } OPTIONAL { ?item wdt:P175 ?artist . ?artist rdfs:label ?artistLabel . FILTER(LANG(?artistLabel) = "en") } FILTER(BOUND(?rymRel) || BOUND(?aotyId)) }`;
      try {
        const res = await fetchImpl(WIKIDATA_SPARQL_URL, {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
          },
          body: new URLSearchParams({ query }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (res.ok) {
          const body = (await res.json()) as {
            results?: {
              bindings?: Record<string, { value?: string }>[];
            };
          };
          const resolvedIds = new Set<string>();
          for (const b of body.results?.bindings ?? []) {
            const titleVal = b.title?.value?.trim();
            const artistVal = b.artistLabel?.value?.trim();
            if (!titleVal || !artistVal) continue;
            const matching = (titleToAlbums.get(normalizeIdentity(titleVal)) ?? []).filter((a) => artistMatchesLoose(artistVal, a.artist));
            for (const a of matching) {
              const rymRel = b.rymRel?.value?.trim();
              const aotyId = b.aotyId?.value?.trim();
              const rymUrl = rymRel ? `${origins.rym}/release/${rymRel.replace(/^\/+/, '').replace(/\/?$/, '/')}` : undefined;
              const aotyUrl = aotyId ? `${origins.aoty}/album/${aotyId.replace(/^\/+/, '')}` : undefined;
              if (rymUrl || aotyUrl) {
                const prev = (pendingCacheWrites.get(`ext_urls:${a.id}`)?.payload as { rymUrl?: string; aotyUrl?: string } | undefined) ?? {};
                pendingCacheWrites.set(`ext_urls:${a.id}`, {
                  status: 'ok',
                  payload: { rymUrl: prev.rymUrl || rymUrl, aotyUrl: prev.aotyUrl || aotyUrl }
                });
                if (!resolvedIds.has(a.id)) {
                  resolvedIds.add(a.id);
                  directUrlsResolved++;
                }
              }
            }
          }
          for (const a of urlTargets) {
            if (!pendingCacheWrites.has(`ext_urls:${a.id}`)) {
              pendingCacheWrites.set(`ext_urls:${a.id}`, { status: 'not_found', payload: {} });
            }
          }
        }
      } catch {
        // Ignore Wikidata timeout; other stages still persist cleanly
      }
    }
  }

  // Recompute policy decisions and commit atomically
  let newlySelectedCount = 0;
  let archivedOutOfWindowCount = 0;
  for (const a of albums) {
    const prev = prevStatusById.get(a.id);
    const next = decide(a, settings, today);
    a.decision = next;
    if (prev !== 'selected' && next.status === 'selected') newlySelectedCount++;
    if (!['out_of_window', 'format_conflict', 'excluded'].includes(prev ?? '') && ['out_of_window', 'format_conflict'].includes(next.status)) {
      archivedOutOfWindowCount++;
    }
  }

  store.transaction(() => {
    if (dirtyAlbums) {
      store.saveAlbums(albums);
      store.setValue('latest-preview', '');
    } else if (albums.some((a) => prevStatusById.get(a.id) !== a.decision?.status)) {
      store.saveAlbums(albums);
    }

    const upsertCache = db.prepare(`
      INSERT INTO catalog_cache(cache_key, status, payload_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    for (const [key, val] of pendingCacheWrites) {
      upsertCache.run(key, val.status, JSON.stringify(val.payload), nowIso);
    }
  });

  return {
    mergedDuplicates,
    datesOrFormatsFilled,
    pitchforkMatched: 0, // Legacy API field. Pitchfork evidence now arrives via capture.
    newlySelectedCount,
    archivedOutOfWindowCount,
    directUrlsResolved
  };
}
