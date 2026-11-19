import type { ArtistGenreCandidate, ArtistGenreSummary, EnrichmentResult } from '../../shared/personal.js';
import type { Store } from '../store.js';
import { normalizeIdentity } from '../sources/parsers.js';
import { buildTasteProfile, splitArtistNorms } from './profile.js';

const USER_AGENT = 'AlbumRelay/0.2.0 (+https://github.com/jidarin9383/album-relay)';
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const MUSICBRAINZ_ARTIST_URL = 'https://musicbrainz.org/ws/2/artist/';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_STALE_MS = 7 * 86_400_000;
const DEFAULT_MB_DELAY_MS = 1_150;
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

const NON_GENRE_TAGS = new Set([
  'chinese',
  'mandarin',
  'cantonese',
  'english',
  'american',
  'british',
  'japanese',
  'korean',
  'french',
  'german',
  'taiwanese',
  'beijing',
  'seen live',
  'favorites',
  'favorite',
  'music'
]);

const KEEP_MUSIC_SUFFIX = /^(?:chamber|electronic dance|industrial|library|outsider|world)\s+music$/i;

const ACRONYMS: Record<string, string> = {
  idm: 'IDM',
  'r&b': 'R&B',
  edm: 'EDM',
  ukg: 'UKG',
  mpb: 'MPB',
  'k-pop': 'K-Pop',
  'j-pop': 'J-Pop',
  'j-rock': 'J-Rock',
  'c-pop': 'C-Pop',
  'lo-fi': 'Lo-Fi'
};

const LOWERCASE_WORDS = new Set(['and', 'of', 'in', 'the']);

function titleCaseLowercaseGenre(input: string): string {
  const words = input.split(' ');
  return words
    .map((word, wIdx) => {
      if (ACRONYMS[word]) return ACRONYMS[word];
      if (wIdx > 0 && wIdx < words.length - 1 && LOWERCASE_WORDS.has(word)) return word;
      return word
        .split('/')
        .map((slashPart) =>
          slashPart
            .split('-')
            .map((dashPart) => {
              if (!dashPart) return dashPart;
              if (ACRONYMS[dashPart]) return ACRONYMS[dashPart];
              return dashPart.charAt(0).toUpperCase() + dashPart.slice(1);
            })
            .join('-')
        )
        .join('/');
    })
    .join(' ');
}

export function canonicalizeGenre(raw: string): string | null {
  let cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 60) return null;
  if (NON_GENRE_TAGS.has(cleaned.toLowerCase())) return null;

  if (!KEEP_MUSIC_SUFFIX.test(cleaned)) {
    cleaned = cleaned.replace(/\s+music$/i, '').trim();
  }
  if (!cleaned || NON_GENRE_TAGS.has(cleaned.toLowerCase())) return null;

  const exactAcronym = ACRONYMS[cleaned.toLowerCase()];
  if (exactAcronym) return exactAcronym;

  return cleaned === cleaned.toLowerCase() ? titleCaseLowercaseGenre(cleaned) : cleaned;
}

function dedupeGenres(rawList: string[], limit = 10): string[] {
  const byNorm = new Map<string, string>();
  for (const raw of rawList) {
    const formatted = canonicalizeGenre(raw);
    if (!formatted) continue;
    const key = normalizeIdentity(formatted);
    if (key && !byNorm.has(key)) byNorm.set(key, formatted);
    if (byNorm.size >= limit) break;
  }
  return [...byNorm.values()];
}

export function saveManualArtistGenres(
  store: Store,
  input: { artistNorm?: string; artistName: string; genres: string[] }
): void {
  const artistName = input.artistName.trim();
  const artistNorm = input.artistNorm?.trim() || normalizeIdentity(artistName);
  const cleanGenres = dedupeGenres(input.genres, 20);
  if (!artistNorm || !artistName || !cleanGenres.length) {
    throw new Error('请至少提供 1 个有效流派标签和艺人名称');
  }
  const now = new Date().toISOString();
  const genresJson = JSON.stringify(cleanGenres);
  store.database.prepare(`
    INSERT INTO artist_metadata(
      artist_norm, artist_name, spotify_id, mbid, wikidata_id,
      genres_json, manual_genres_json, source, status, confidence, candidates_json, updated_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'manual', 'manual', 'high', '[]', ?)
    ON CONFLICT(artist_norm) DO UPDATE SET
      artist_name = COALESCE(NULLIF(excluded.artist_name, ''), artist_metadata.artist_name),
      genres_json = excluded.genres_json,
      manual_genres_json = excluded.manual_genres_json,
      source = 'manual',
      status = 'manual',
      confidence = 'high',
      candidates_json = '[]',
      updated_at = excluded.updated_at
  `).run(artistNorm, artistName, genresJson, genresJson, now);
}

export function listArtistMetadataSummary(store: Store, limit = 40): ArtistGenreSummary[] {
  const rows = store.database.prepare(`
    SELECT artist_norm, artist_name, genres_json, manual_genres_json, source, status, confidence, candidates_json, updated_at
    FROM artist_metadata
    WHERE status IN ('ambiguous', 'manual', 'resolved')
    ORDER BY
      CASE status WHEN 'ambiguous' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END ASC,
      updated_at DESC
    LIMIT ?
  `).all(limit) as {
    artist_norm: string;
    artist_name: string;
    genres_json: string;
    manual_genres_json: string | null;
    source: string;
    status: ArtistGenreSummary['status'];
    confidence: ArtistGenreSummary['confidence'];
    candidates_json: string;
    updated_at: string;
  }[];

  return rows.map((r) => {
    let genres: string[] = [];
    let candidates: ArtistGenreCandidate[] = [];
    try {
      genres = JSON.parse(r.manual_genres_json || r.genres_json || '[]') as string[];
    } catch {
      genres = [];
    }
    try {
      candidates = JSON.parse(r.candidates_json || '[]') as ArtistGenreCandidate[];
    } catch {
      candidates = [];
    }
    return {
      artistNorm: r.artist_norm,
      artistName: r.artist_name,
      genres,
      source: r.source,
      status: r.status,
      confidence: r.confidence,
      ...(candidates.length ? { candidates } : {}),
      updatedAt: r.updated_at
    };
  });
}

interface CandidateArtist {
  artistNorm: string;
  artistName: string;
  spotifyId: string | null;
  weight: number;
}

interface StagedArtistMetadata {
  artistNorm: string;
  artistName: string;
  spotifyId: string | null;
  mbid: string | null;
  wikidataId: string | null;
  genres: string[];
  source: string;
  status: 'resolved' | 'ambiguous' | 'not_found' | 'pending';
  confidence: 'high' | 'medium' | 'low';
  candidates: ArtistGenreCandidate[];
}

interface SparqlBindingValue {
  type?: string;
  value?: string;
  'xml:lang'?: string;
}

interface SparqlResponse {
  results?: { bindings?: Record<string, SparqlBindingValue>[] };
}

const escapeSparql = (value: string) =>
  value.replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();

const wikidataIdFromUri = (uri?: string) => {
  if (!uri) return '';
  const m = /\/(Q\d+)$/.exec(uri);
  return m ? m[1]! : uri;
};

async function runSparql(fetchImpl: typeof fetch, query: string): Promise<Record<string, SparqlBindingValue>[] | null> {
  try {
    const res = await fetchImpl(SPARQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: new URLSearchParams({ query }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SparqlResponse;
    return data.results?.bindings ?? [];
  } catch {
    return null;
  }
}

function buildNameLiteralQueries(name: string): { literal: string; key: string }[] {
  const out: { literal: string; key: string }[] = [];
  const clean = escapeSparql(name);
  if (!clean) return out;
  const variants = new Set<string>([clean]);
  const hasCjk = /[\u4e00-\u9fff]/.test(clean);
  const hasLatin = /[A-Za-z]{2,}/.test(clean);
  if (hasCjk && hasLatin) {
    const cjk = clean.replace(/[A-Za-z0-9\s'’".,!?()[\]&/-]+/g, ' ').trim();
    const latin = clean.replace(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ').trim();
    if (cjk.length >= 2) variants.add(cjk);
    if (latin.length >= 2) variants.add(latin);
  }
  for (const v of variants) {
    out.push({ literal: `"${v}"@en`, key: `${v.toLowerCase()}@en` });
    if (/[\u4e00-\u9fff]/.test(v)) {
      out.push({ literal: `"${v}"@zh`, key: `${v.toLowerCase()}@zh` });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function enrichArtistGenres(
  store: Store,
  options: {
    maxSpotifyBatch?: number;
    maxNameBatch?: number;
    maxMbLookups?: number;
    fetchImpl?: typeof fetch;
    mbDelayMs?: number;
  } = {}
): Promise<EnrichmentResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxSpotifyBatch = options.maxSpotifyBatch ?? 360;
  const maxNameBatch = options.maxNameBatch ?? 120;
  const maxMbLookups = options.maxMbLookups ?? 15;
  const mbDelayMs = options.mbDelayMs ?? DEFAULT_MB_DELAY_MS;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const db = store.database;

  // Backfill Spotify Artist IDs from raw_records (TuneMyMusic Type=Artist / Favorite Artists)
  const spotifyIdsByNorm = new Map<string, string>();
  const rawArtistRows = db
    .prepare("SELECT raw_json FROM raw_records WHERE outcome IN ('accepted', 'duplicate')")
    .all() as { raw_json: string }[];
  for (const rr of rawArtistRows) {
    try {
      const parsed = JSON.parse(rr.raw_json) as Record<string, unknown>;
      const typeVal = String(parsed.Type ?? parsed.kind ?? '').trim().toLowerCase();
      const playlistVal = String(parsed['Playlist name'] ?? parsed.playlist ?? '').trim();
      const isArtistRow =
        typeVal === 'artist' ||
        typeVal === 'favorite_artist' ||
        /^(?:favorite|followed)\s+artists?$|关注歌手|收藏歌手/i.test(playlistVal);
      if (!isArtistRow) continue;
      const artistName = String(parsed['Artist name'] || parsed['Track name'] || parsed.artist || '').trim();
      const sid = String(parsed['Spotify - id'] ?? parsed['Spotify ID'] ?? '').trim();
      const norm = normalizeIdentity(artistName);
      if (norm && SPOTIFY_ID_RE.test(sid) && !spotifyIdsByNorm.has(norm)) {
        spotifyIdsByNorm.set(norm, sid);
      }
    } catch {
      // Ignore malformed raw JSON
    }
  }

  // Known genres already present in library albums or signal rows
  const alreadyKnownWithGenres = new Set<string>();
  for (const a of store.albums()) {
    if (a.genres?.length) {
      for (const norm of splitArtistNorms(a.artist)) alreadyKnownWithGenres.add(norm);
    }
  }
  const signalRows = db
    .prepare(`
      SELECT artist, artist_norm, genres_json, weight
      FROM preference_signals
      WHERE source NOT IN ('in-app', 'legacy-migration') AND weight > 0
    `)
    .all() as { artist: string; artist_norm: string; genres_json: string; weight: number }[];
  const artistWeights = new Map<string, { name: string; weight: number }>();
  for (const s of signalRows) {
    const cur = artistWeights.get(s.artist_norm) ?? { name: s.artist, weight: 0 };
    cur.weight += s.weight;
    if (s.artist && (!cur.name || cur.name === s.artist_norm)) cur.name = s.artist;
    artistWeights.set(s.artist_norm, cur);
    try {
      const gs = JSON.parse(s.genres_json || '[]') as string[];
      if (gs.length) {
        alreadyKnownWithGenres.add(s.artist_norm);
        for (const norm of splitArtistNorms(s.artist)) alreadyKnownWithGenres.add(norm);
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  const listenRows = db
    .prepare('SELECT artist, artist_norm, COUNT(*) AS plays FROM listening_events GROUP BY artist_norm')
    .all() as { artist: string; artist_norm: string; plays: number }[];
  for (const l of listenRows) {
    const cur = artistWeights.get(l.artist_norm) ?? { name: l.artist, weight: 0 };
    cur.weight += Math.log1p(l.plays);
    if (l.artist && (!cur.name || cur.name === l.artist_norm)) cur.name = l.artist;
    artistWeights.set(l.artist_norm, cur);
  }

  // Existing artist_metadata rows
  const existingMeta = new Map<
    string,
    { status: string; updatedAt: string; spotifyId: string | null; mbid: string | null; wikidataId: string | null }
  >();
  const metaRows = db
    .prepare('SELECT artist_norm, spotify_id, mbid, wikidata_id, status, updated_at FROM artist_metadata')
    .all() as {
    artist_norm: string;
    spotify_id: string | null;
    mbid: string | null;
    wikidata_id: string | null;
    status: string;
    updated_at: string;
  }[];
  for (const m of metaRows) {
    existingMeta.set(m.artist_norm, {
      status: m.status,
      updatedAt: m.updated_at,
      spotifyId: m.spotify_id,
      mbid: m.mbid,
      wikidataId: m.wikidata_id
    });
    if (m.spotify_id && SPOTIFY_ID_RE.test(m.spotify_id) && !spotifyIdsByNorm.has(m.artist_norm)) {
      spotifyIdsByNorm.set(m.artist_norm, m.spotify_id);
    }
  }

  // Build sorted queue of candidates needing enrichment
  const allCandidates: CandidateArtist[] = [];
  for (const [artistNorm, info] of artistWeights) {
    const tokens = splitArtistNorms(info.name);
    if (alreadyKnownWithGenres.has(artistNorm) || tokens.some((t) => alreadyKnownWithGenres.has(t))) continue;
    const prev = existingMeta.get(artistNorm);
    if (prev) {
      if (prev.status === 'resolved' || prev.status === 'manual') continue;
      if ((prev.status === 'not_found' || prev.status === 'ambiguous') && nowMs - Date.parse(prev.updatedAt) < RETRY_STALE_MS) {
        continue;
      }
    }
    allCandidates.push({
      artistNorm,
      artistName: info.name,
      spotifyId: spotifyIdsByNorm.get(artistNorm) ?? prev?.spotifyId ?? null,
      weight: info.weight
    });
  }
  allCandidates.sort((a, b) => b.weight - a.weight || a.artistNorm.localeCompare(b.artistNorm));

  const staged = new Map<string, StagedArtistMetadata>();
  const mbQueue: { artist: CandidateArtist; wikidataId: string | null; mbid: string }[] = [];

  // Pre-queue existing pending entries that already have an MBID from a prior throttled run
  const spotifyTargets = allCandidates.filter((c) => c.spotifyId).slice(0, maxSpotifyBatch);
  const nameTargets = allCandidates.filter((c) => !c.spotifyId).slice(0, maxNameBatch);

  // Stage 1A: Wikidata SPARQL POST by Spotify ID (wdt:P1902)
  for (let i = 0; i < spotifyTargets.length; i += 60) {
    const chunk = spotifyTargets.slice(i, i + 60);
    const values = chunk.map((c) => `"${escapeSparql(c.spotifyId!)}"`).join(' ');
    const query = `SELECT ?spotifyId ?item ?itemLabel ?mbid (GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genres) WHERE { VALUES ?spotifyId { ${values} } ?item wdt:P1902 ?spotifyId . OPTIONAL { ?item wdt:P434 ?mbid . } OPTIONAL { ?item wdt:P136 ?genre . ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en") } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,zh". } } GROUP BY ?spotifyId ?item ?itemLabel ?mbid`;
    const bindings = await runSparql(fetchImpl, query);
    if (!bindings) break;

    const bySid = new Map<string, { wikidataIds: Set<string>; mbids: Set<string>; genres: string[] }>();
    for (const b of bindings) {
      const sid = b.spotifyId?.value?.trim();
      if (!sid) continue;
      const entry = bySid.get(sid) ?? { wikidataIds: new Set(), mbids: new Set(), genres: [] };
      const qid = wikidataIdFromUri(b.item?.value);
      if (qid) entry.wikidataIds.add(qid);
      const mbid = b.mbid?.value?.trim();
      if (mbid) entry.mbids.add(mbid);
      const genreStr = b.genres?.value ?? '';
      if (genreStr) entry.genres.push(...genreStr.split('|'));
      bySid.set(sid, entry);
    }

    for (const c of chunk) {
      const hit = bySid.get(c.spotifyId!);
      const genres = dedupeGenres(hit?.genres ?? [], 10);
      const wikidataId = hit ? [...hit.wikidataIds][0] ?? null : null;
      const mbid = hit ? [...hit.mbids][0] ?? null : null;
      if (genres.length > 0) {
        staged.set(c.artistNorm, {
          artistNorm: c.artistNorm,
          artistName: c.artistName,
          spotifyId: c.spotifyId,
          mbid,
          wikidataId,
          genres,
          source: 'wikidata-spotify',
          status: 'resolved',
          confidence: 'high',
          candidates: []
        });
      } else if (mbid) {
        mbQueue.push({ artist: c, wikidataId, mbid });
        staged.set(c.artistNorm, {
          artistNorm: c.artistNorm,
          artistName: c.artistName,
          spotifyId: c.spotifyId,
          mbid,
          wikidataId,
          genres: [],
          source: 'wikidata-spotify',
          status: 'pending',
          confidence: 'low',
          candidates: []
        });
      } else {
        staged.set(c.artistNorm, {
          artistNorm: c.artistNorm,
          artistName: c.artistName,
          spotifyId: c.spotifyId,
          mbid: null,
          wikidataId,
          genres: [],
          source: 'wikidata-spotify',
          status: 'not_found',
          confidence: 'low',
          candidates: []
        });
      }
    }
  }

  // Stage 1B: Wikidata SPARQL POST by Artist Name + P434 MBID constraint
  for (let i = 0; i < nameTargets.length; i += 25) {
    const chunk = nameTargets.slice(i, i + 25);
    const keyToCandidates = new Map<string, CandidateArtist[]>();
    const literals = new Set<string>();
    for (const c of chunk) {
      for (const q of buildNameLiteralQueries(c.artistName)) {
        literals.add(q.literal);
        const arr = keyToCandidates.get(q.key) ?? [];
        if (!arr.some((x) => x.artistNorm === c.artistNorm)) arr.push(c);
        keyToCandidates.set(q.key, arr);
      }
    }
    if (!literals.size) continue;
    const query = `SELECT ?queryName ?item ?itemLabel ?mbid (GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genres) WHERE { VALUES ?queryName { ${[...literals].join(' ')} } ?item rdfs:label|skos:altLabel ?queryName ; wdt:P434 ?mbid . OPTIONAL { ?item wdt:P136 ?genre . ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en") } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,zh". } } GROUP BY ?queryName ?item ?itemLabel ?mbid`;
    const bindings = await runSparql(fetchImpl, query);
    if (!bindings) break;

    const perArtistItems = new Map<string, Map<string, ArtistGenreCandidate>>();
    for (const b of bindings) {
      const qVal = b.queryName?.value?.trim();
      const qLang = b.queryName?.['xml:lang']?.trim() || 'en';
      const qid = wikidataIdFromUri(b.item?.value);
      if (!qVal || !qid) continue;
      const targets = keyToCandidates.get(`${qVal.toLowerCase()}@${qLang}`) ?? [];
      for (const c of targets) {
        const itemsMap = perArtistItems.get(c.artistNorm) ?? new Map<string, ArtistGenreCandidate>();
        const existingItem = itemsMap.get(qid) ?? {
          wikidataId: qid,
          mbid: b.mbid?.value?.trim() || undefined,
          label: b.itemLabel?.value?.trim() || c.artistName,
          genres: []
        };
        const rawGenres = (b.genres?.value ?? '').split('|').filter(Boolean);
        existingItem.genres = dedupeGenres([...existingItem.genres, ...rawGenres], 10);
        if (!existingItem.mbid && b.mbid?.value) existingItem.mbid = b.mbid.value.trim();
        itemsMap.set(qid, existingItem);
        perArtistItems.set(c.artistNorm, itemsMap);
      }
    }

    for (const c of chunk) {
      const itemsMap = perArtistItems.get(c.artistNorm);
      const distinct = itemsMap ? [...itemsMap.values()] : [];
      if (distinct.length === 1) {
        const only = distinct[0]!;
        if (only.genres.length > 0) {
          staged.set(c.artistNorm, {
            artistNorm: c.artistNorm,
            artistName: c.artistName,
            spotifyId: null,
            mbid: only.mbid ?? null,
            wikidataId: only.wikidataId,
            genres: only.genres,
            source: 'wikidata-name',
            status: 'resolved',
            confidence: 'medium',
            candidates: []
          });
        } else if (only.mbid) {
          mbQueue.push({ artist: c, wikidataId: only.wikidataId, mbid: only.mbid });
          staged.set(c.artistNorm, {
            artistNorm: c.artistNorm,
            artistName: c.artistName,
            spotifyId: null,
            mbid: only.mbid,
            wikidataId: only.wikidataId,
            genres: [],
            source: 'wikidata-name',
            status: 'pending',
            confidence: 'low',
            candidates: []
          });
        } else {
          staged.set(c.artistNorm, {
            artistNorm: c.artistNorm,
            artistName: c.artistName,
            spotifyId: null,
            mbid: null,
            wikidataId: only.wikidataId,
            genres: [],
            source: 'wikidata-name',
            status: 'not_found',
            confidence: 'low',
            candidates: []
          });
        }
      } else if (distinct.length > 1) {
        const withGenres = distinct.filter((d) => d.genres.length > 0);
        if (withGenres.length > 0) {
          staged.set(c.artistNorm, {
            artistNorm: c.artistNorm,
            artistName: c.artistName,
            spotifyId: null,
            mbid: null,
            wikidataId: null,
            genres: [],
            source: 'wikidata-name',
            status: 'ambiguous',
            confidence: 'low',
            candidates: distinct.slice(0, 5)
          });
        } else {
          staged.set(c.artistNorm, {
            artistNorm: c.artistNorm,
            artistName: c.artistName,
            spotifyId: null,
            mbid: distinct[0]?.mbid ?? null,
            wikidataId: distinct[0]?.wikidataId ?? null,
            genres: [],
            source: 'wikidata-name',
            status: 'not_found',
            confidence: 'low',
            candidates: []
          });
        }
      } else {
        staged.set(c.artistNorm, {
          artistNorm: c.artistNorm,
          artistName: c.artistName,
          spotifyId: null,
          mbid: null,
          wikidataId: null,
          genres: [],
          source: 'wikidata-name',
          status: 'not_found',
          confidence: 'low',
          candidates: []
        });
      }
    }
  }

  // Stage 2: Direct MusicBrainz entity lookup by resolved MBID (strictly paced >= 1 req/s; never Lucene search)
  mbQueue.sort((a, b) => b.artist.weight - a.artist.weight);
  const mbSlice = mbQueue.slice(0, maxMbLookups);
  for (let i = 0; i < mbSlice.length; i++) {
    if (i > 0 && mbDelayMs > 0) await sleep(mbDelayMs);
    const item = mbSlice[i]!;
    let okPayload: { genres?: { name?: string; count?: number }[] } | null = null;
    let hardNotFound = false;
    let throttledOrDown = false;
    try {
      const res = await fetchImpl(`${MUSICBRAINZ_ARTIST_URL}${encodeURIComponent(item.mbid)}?inc=genres&fmt=json`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (res.ok) {
        okPayload = (await res.json()) as { genres?: { name?: string; count?: number }[] };
      } else if (res.status === 404) {
        hardNotFound = true;
      } else {
        throttledOrDown = true;
      }
    } catch {
      throttledOrDown = true;
    }

    if (throttledOrDown) break;
    if (hardNotFound) {
      staged.set(item.artist.artistNorm, {
        artistNorm: item.artist.artistNorm,
        artistName: item.artist.artistName,
        spotifyId: item.artist.spotifyId,
        mbid: item.mbid,
        wikidataId: item.wikidataId,
        genres: [],
        source: 'musicbrainz-mbid',
        status: 'not_found',
        confidence: 'low',
        candidates: []
      });
      continue;
    }

    const sortedRaw = [...(okPayload?.genres ?? [])]
      .filter((g) => typeof g.name === 'string' && g.name.trim())
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .map((g) => g.name!);
    const clean = dedupeGenres(sortedRaw, 8);
    staged.set(item.artist.artistNorm, {
      artistNorm: item.artist.artistNorm,
      artistName: item.artist.artistName,
      spotifyId: item.artist.spotifyId,
      mbid: item.mbid,
      wikidataId: item.wikidataId,
      genres: clean,
      source: 'musicbrainz-mbid',
      status: clean.length ? 'resolved' : 'not_found',
      confidence: clean.length ? (item.artist.spotifyId ? 'high' : 'medium') : 'low',
      candidates: []
    });
  }

  let resolvedCount = 0;
  let ambiguousCount = 0;
  let notFoundCount = 0;

  store.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO artist_metadata(
        artist_norm, artist_name, spotify_id, mbid, wikidata_id,
        genres_json, source, status, confidence, candidates_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artist_norm) DO UPDATE SET
        artist_name = COALESCE(NULLIF(excluded.artist_name, ''), artist_metadata.artist_name),
        spotify_id = COALESCE(excluded.spotify_id, artist_metadata.spotify_id),
        mbid = COALESCE(excluded.mbid, artist_metadata.mbid),
        wikidata_id = COALESCE(excluded.wikidata_id, artist_metadata.wikidata_id),
        genres_json = CASE WHEN artist_metadata.status = 'manual' THEN artist_metadata.genres_json ELSE excluded.genres_json END,
        source = CASE WHEN artist_metadata.status = 'manual' THEN artist_metadata.source ELSE excluded.source END,
        status = CASE WHEN artist_metadata.status = 'manual' THEN artist_metadata.status ELSE excluded.status END,
        confidence = CASE WHEN artist_metadata.status = 'manual' THEN artist_metadata.confidence ELSE excluded.confidence END,
        candidates_json = CASE WHEN artist_metadata.status = 'manual' THEN artist_metadata.candidates_json ELSE excluded.candidates_json END,
        updated_at = CASE WHEN artist_metadata.status = 'manual' THEN artist_metadata.updated_at ELSE excluded.updated_at END
    `);

    for (const row of staged.values()) {
      upsert.run(
        row.artistNorm,
        row.artistName,
        row.spotifyId,
        row.mbid,
        row.wikidataId,
        JSON.stringify(row.genres),
        row.source,
        row.status,
        row.confidence,
        JSON.stringify(row.candidates),
        nowIso
      );
      if (row.status === 'resolved') resolvedCount++;
      else if (row.status === 'ambiguous') ambiguousCount++;
      else if (row.status === 'not_found') notFoundCount++;
    }

    // Seed remaining candidates not visited in this bounded pass as 'pending'
    const insertPending = db.prepare(`
      INSERT OR IGNORE INTO artist_metadata(
        artist_norm, artist_name, spotify_id, mbid, wikidata_id,
        genres_json, source, status, confidence, candidates_json, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, '[]', 'pending', 'pending', 'low', '[]', ?)
    `);
    for (const c of allCandidates) {
      if (!staged.has(c.artistNorm)) {
        insertPending.run(c.artistNorm, c.artistName, c.spotifyId, nowIso);
      }
    }
  });

  const remainingRow = db.prepare("SELECT COUNT(*) AS count FROM artist_metadata WHERE status = 'pending'").get() as {
    count: number;
  };
  return {
    scannedArtists: spotifyTargets.length + nameTargets.length,
    resolvedCount,
    ambiguousCount,
    notFoundCount,
    remainingPendingCount: remainingRow.count,
    profile: buildTasteProfile(store)
  };
}
