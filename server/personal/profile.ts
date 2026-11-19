import { createHash } from 'node:crypto';
import type { AffinityEntry, CorroborationItem, FeedbackQueueState, FeedbackReaction, MetadataCoverage, TasteProfile } from '../../shared/personal.js';
import type { Album, SourceName } from '../../shared/types.js';
import type { Store } from '../store.js';
import { decide, isObservationFresh, todayInTimezone } from '../policy.js';
import { normalizeIdentity } from '../sources/parsers.js';
import { canonicalizeGenre } from './enrichment.js';

export function splitArtistNorms(artist: string): string[] {
  const rawParts = artist
    .split(/\s*(?:\/|;|\bwith\b|\bfeat\.?|\bft\.?)\s*|\s+&\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const expanded: string[] = [];
  for (const part of [artist, ...rawParts]) {
    expanded.push(part);
    // Split bilingual CJK + Latin credits (e.g. "落日飛車 Sunset Rollercoaster")
    const hasCjk = /[\u4e00-\u9fff]/.test(part);
    const hasLatin = /[A-Za-z]{2,}/.test(part);
    if (hasCjk && hasLatin) {
      const cjkOnly = part.replace(/[A-Za-z0-9\s'’".,!?()[\]&/-]+/g, ' ').trim();
      const latinOnly = part.replace(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ').trim();
      if (cjkOnly) expanded.push(cjkOnly);
      if (latinOnly) expanded.push(latinOnly);
    }
  }
  return [...new Set(expanded.map((p) => normalizeIdentity(p)).filter((n) => n.length >= 2))];
}

export interface CandidateTasteState {
  candidateId?: string;
  queueState: FeedbackQueueState | null;
  reaction: FeedbackReaction | null;
  weight: number;
  artistNorm: string;
}

export interface ComputedTasteData {
  profile: TasteProfile;
  artistScoreMap: Map<string, AffinityEntry>;
  genreScoreMap: Map<string, AffinityEntry>;
  candidateStates: Map<string, CandidateTasteState>;
}

export interface AlbumTasteMatch {
  artistAffinity: number;
  genreOverlap: number;
  matchedArtists: string[];
  matchedGenres: string[];
}

export function scoreAlbumTaste(
  album: Album,
  artistScoreMap: Map<string, AffinityEntry>,
  genreScoreMap: Map<string, AffinityEntry>
): AlbumTasteMatch {
  const candTokens = splitArtistNorms(album.artist);
  let bestArtistScore = 0;
  const matchedArtists: string[] = [];
  for (const [key, entry] of artistScoreMap) {
    if (entry.score <= 0) continue;
    const entryTokens = splitArtistNorms(entry.name);
    if (candTokens.some((ct) => ct === key || entryTokens.includes(ct))) {
      bestArtistScore = Math.max(bestArtistScore, entry.score);
      if (!matchedArtists.includes(entry.name)) matchedArtists.push(entry.name);
    }
  }
  const artistAffinity = Math.min(45, Math.round(bestArtistScore * 8));

  let matchedGenreWeight = 0;
  const matchedGenres: string[] = [];
  const seenGenreNorms = new Set<string>();
  for (const rawGenre of album.genres ?? []) {
    const clean = canonicalizeGenre(rawGenre) ?? rawGenre;
    const gn = normalizeIdentity(clean);
    if (!gn || seenGenreNorms.has(gn)) continue;
    seenGenreNorms.add(gn);
    const ge = genreScoreMap.get(gn);
    if (ge && ge.score > 0) {
      matchedGenreWeight += Math.min(ge.score, 3);
      matchedGenres.push(rawGenre);
    }
  }
  const genreOverlap = Math.min(35, Math.round(matchedGenreWeight * 7));
  return { artistAffinity, genreOverlap, matchedArtists, matchedGenres };
}

function addEntry(
  map: Map<string, AffinityEntry>,
  key: string,
  name: string,
  deltaScore: number,
  listens = 0,
  recentListens = 0,
  signals = 0
): void {
  if (!key) return;
  const cur = map.get(key) ?? { key, name, score: 0, listenCount: 0, recentListenCount: 0, signalCount: 0 };
  if (name && (!cur.name || cur.name === cur.key)) cur.name = name;
  cur.score += deltaScore;
  cur.listenCount += listens;
  cur.recentListenCount += recentListens;
  cur.signalCount += signals;
  map.set(key, cur);
}

export function computeTasteData(store: Store, now = new Date()): ComputedTasteData {
  const nowMs = now.getTime();
  const db = store.database;
  const albums = store.albums();
  const settings = store.settings();
  const today = todayInTimezone(settings.schedule.timezone, now);

  // Known artist -> genres mapping derived from library albums, artist_metadata enrichment & historical signals
  const artistGenres = new Map<string, Map<string, string>>();
  const bindGenreMap = (normKey: string, genres: string[]) => {
    if (!normKey || !genres.length) return;
    const m = artistGenres.get(normKey) ?? new Map<string, string>();
    for (const g of genres) {
      const clean = canonicalizeGenre(g) ?? g.trim();
      const gn = normalizeIdentity(clean);
      if (gn) m.set(gn, clean);
    }
    if (m.size) artistGenres.set(normKey, m);
  };
  const recordArtistGenre = (artist: string, genres: string[]) => {
    if (!genres.length) return;
    for (const norm of splitArtistNorms(artist)) {
      bindGenreMap(norm, genres);
    }
  };
  for (const a of albums) recordArtistGenre(a.artist, a.genres ?? []);

  const metaGenreRows = db.prepare(`
    SELECT artist_norm, artist_name, genres_json, manual_genres_json
    FROM artist_metadata
    WHERE status IN ('resolved', 'manual')
  `).all() as { artist_norm: string; artist_name: string; genres_json: string; manual_genres_json: string | null }[];
  for (const m of metaGenreRows) {
    try {
      const gs = JSON.parse(m.manual_genres_json || m.genres_json || '[]') as string[];
      if (gs.length) {
        bindGenreMap(m.artist_norm, gs);
        recordArtistGenre(m.artist_name || m.artist_norm, gs);
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  // 1. Aggregate listening events with per-(artist, track) diminishing weight
  const maxPlayedRow = db.prepare('SELECT MAX(played_at) AS max_at FROM listening_events').get() as { max_at?: string | null };
  const maxPlayedMs = maxPlayedRow?.max_at ? Date.parse(maxPlayedRow.max_at) : 0;
  // If an imported archive ended >90 days ago, treat its final 90 days as the recent slice.
  const recentAnchorMs = maxPlayedMs > 0 && nowMs - maxPlayedMs > 90 * 86400000 ? maxPlayedMs : nowMs;
  const recentCutoffMs = recentAnchorMs - 90 * 86400000;

  const trackGroups = db.prepare(`
    SELECT artist, artist_norm, track_norm,
      COUNT(*) AS play_count,
      SUM(CASE WHEN played_at >= ? THEN 1 ELSE 0 END) AS recent_count
    FROM listening_events
    GROUP BY artist_norm, track_norm
  `).all(new Date(recentCutoffMs).toISOString()) as {
    artist: string;
    artist_norm: string;
    track_norm: string;
    play_count: number;
    recent_count: number;
  }[];

  const artistLong = new Map<string, AffinityEntry>();
  const artistRecent = new Map<string, AffinityEntry>();
  const trackCountPerArtist = new Map<string, number>();

  for (const row of trackGroups) {
    const seen = trackCountPerArtist.get(row.artist_norm) ?? 0;
    trackCountPerArtist.set(row.artist_norm, seen + 1);
    const damp = 1 / (1 + 0.08 * seen);
    const wLong = Math.log1p(row.play_count) * damp;
    addEntry(artistLong, row.artist_norm, row.artist, wLong, row.play_count, row.recent_count, 0);
    if (row.recent_count > 0) {
      const wRecent = Math.log1p(row.recent_count) * damp;
      addEntry(artistRecent, row.artist_norm, row.artist, wRecent, row.play_count, row.recent_count, 0);
    }
  }

  // 2. Scan append-only preference_signals in chronological order (latest interactive row supersedes earlier ones)
  const signalRows = db.prepare(`
    SELECT source, entity_type, artist, artist_norm, title_norm, genres_json,
           candidate_id, queue_state, reaction, weight
    FROM preference_signals
    ORDER BY rowid ASC
  `).all() as {
    source: string;
    entity_type: string;
    artist: string;
    artist_norm: string;
    title_norm: string;
    genres_json: string;
    candidate_id: string | null;
    queue_state: FeedbackQueueState | null;
    reaction: FeedbackReaction | null;
    weight: number;
  }[];

  const candidateStates = new Map<string, CandidateTasteState>();
  const importedSignalCounts = new Map<string, number>();
  const directGenreMap = new Map<string, AffinityEntry>();
  let totalListenRows = 0;
  const totalCountRow = db.prepare('SELECT COUNT(*) AS count FROM listening_events').get() as { count: number };
  totalListenRows = totalCountRow.count;

  let hasMeaningfulPersonalEvidence = totalListenRows > 0;

  for (const s of signalRows) {
    let genres: string[] = [];
    try {
      genres = JSON.parse(s.genres_json || '[]') as string[];
    } catch {
      genres = [];
    }
    recordArtistGenre(s.artist, genres);

    if (s.source === 'in-app' || s.source === 'legacy-migration') {
      const stateKey = s.candidate_id || `${s.artist_norm}:${s.title_norm}`;
      candidateStates.set(stateKey, {
        candidateId: s.candidate_id ?? undefined,
        queueState: s.queue_state,
        reaction: s.reaction,
        weight: s.weight,
        artistNorm: s.artist_norm
      });
      continue;
    }

    const seen = importedSignalCounts.get(s.artist_norm) ?? 0;
    importedSignalCounts.set(s.artist_norm, seen + 1);
    const damp = s.weight >= 0 ? 1 / (1 + 0.15 * seen) : 1;
    const w = s.weight * damp;
    if (Math.abs(w) > 0.01) hasMeaningfulPersonalEvidence = true;
    addEntry(artistLong, s.artist_norm, s.artist, w, 0, 0, 1);
    if (s.source === 'in-app-favorite') {
      addEntry(artistRecent, s.artist_norm, s.artist, w, 0, 0, 1);
    }
    for (const g of genres) {
      const clean = canonicalizeGenre(g) ?? g.trim();
      const gn = normalizeIdentity(clean);
      if (gn && w !== 0) addEntry(directGenreMap, gn, clean, w * 0.7, 0, 0, 1);
    }
  }

  let likedCount = 0;
  let dislikedCount = 0;
  let savedCount = 0;
  for (const st of candidateStates.values()) {
    if (st.reaction === 'liked') likedCount++;
    if (st.reaction === 'disliked') dislikedCount++;
    if (st.queueState === 'saved') savedCount++;
    if (Math.abs(st.weight) > 0.01) hasMeaningfulPersonalEvidence = true;
    if (st.weight !== 0) {
      const alb = st.candidateId ? albums.find((a) => a.id === st.candidateId) : undefined;
      const artistName = alb?.artist || st.artistNorm;
      addEntry(artistLong, st.artistNorm, artistName, st.weight, 0, 0, 1);
      addEntry(artistRecent, st.artistNorm, artistName, st.weight, 0, 0, 1);
      if (alb) {
        for (const g of alb.genres ?? []) {
          const clean = canonicalizeGenre(g) ?? g.trim();
          const gn = normalizeIdentity(clean);
          if (gn) addEntry(directGenreMap, gn, clean, st.weight * 0.75, 0, 0, 1);
        }
      }
    }
  }

  // Propagate positive artist affinity to known genres (0.5x weight, capped to prevent single-artist dominance)
  for (const [artistNorm, entry] of artistLong) {
    if (entry.score <= 0) continue;
    const known = new Map<string, string>();
    const direct = artistGenres.get(artistNorm);
    if (direct) for (const [gn, gName] of direct) known.set(gn, gName);
    for (const t of splitArtistNorms(entry.name)) {
      const sub = artistGenres.get(t);
      if (sub) for (const [gn, gName] of sub) if (!known.has(gn)) known.set(gn, gName);
    }
    if (!known.size) continue;
    const share = Math.min(entry.score, 6) * 0.5 / Math.max(1, Math.sqrt(known.size));
    for (const [gn, gName] of known) {
      addEntry(directGenreMap, gn, gName, share, 0, 0, 0);
    }
  }

  const eligibleCandidates = albums.filter(
    (a) =>
      !a.excluded &&
      decide(a, settings, today).status === 'selected' &&
      a.sources.some((s) => settings.sources[s.source] && s.status === 'ok' && isObservationFresh(s, nowMs))
  );
  const candidatesWithGenres = eligibleCandidates.filter((a) => a.genres.length > 0).length;
  const batchesRow = db.prepare("SELECT COUNT(*) AS count FROM import_batches WHERE status = 'committed'").get() as { count: number };
  const ambiguousRow = db.prepare("SELECT COUNT(*) AS count FROM artist_metadata WHERE status = 'ambiguous'").get() as { count: number };

  const positiveArtists = [...artistLong.values()].filter((e) => e.score > 0.05);
  const personalArtistsWithGenres = positiveArtists.filter((e) => {
    if (artistGenres.get(e.key)?.size) return true;
    return splitArtistNorms(e.name).some((t) => (artistGenres.get(t)?.size ?? 0) > 0);
  }).length;

  const sortPositive = (m: Map<string, AffinityEntry>, limit: number) =>
    [...m.values()]
      .filter((e) => e.score > 0.05)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .map((e) => ({ ...e, score: Number(e.score.toFixed(2)) }))
      .slice(0, limit);

  const topArtistsLongTerm = sortPositive(artistLong, 100);
  const topArtistsRecent = sortPositive(artistRecent, 50);
  const topGenres = sortPositive(directGenreMap, 50);

  const coverage: MetadataCoverage = {
    totalCandidates: albums.length,
    eligibleCandidates: eligibleCandidates.length,
    candidatesWithGenres,
    genreCoverageRatio: eligibleCandidates.length ? Number((candidatesWithGenres / eligibleCandidates.length).toFixed(3)) : 0,
    listeningEventsCount: totalListenRows,
    preferenceSignalsCount: signalRows.length,
    importBatchesCount: batchesRow.count,
    personalArtistsTotal: positiveArtists.length,
    personalArtistsWithGenres,
    ambiguousArtistsCount: ambiguousRow.count
  };

  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        long: topArtistsLongTerm.slice(0, 30),
        recent: topArtistsRecent.slice(0, 20),
        genres: topGenres.slice(0, 20),
        likedCount,
        dislikedCount,
        savedCount,
        events: totalListenRows,
        signals: signalRows.length
      })
    )
    .digest('hex')
    .slice(0, 16);

  return {
    profile: {
      revision,
      generatedAt: now.toISOString(),
      coldStart: !hasMeaningfulPersonalEvidence,
      topArtistsLongTerm,
      topArtistsRecent,
      topGenres,
      likedCount,
      dislikedCount,
      savedCount,
      coverage
    },
    artistScoreMap: artistLong,
    genreScoreMap: directGenreMap,
    candidateStates
  };
}

export function buildTasteProfile(store: Store, now = new Date()): TasteProfile {
  return computeTasteData(store, now).profile;
}

function rymGoogleSearchUrl(artist: string, title: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`site:rateyourmusic.com/release/album "${artist}" "${title}"`)}`;
}

function searchUrlForSource(
  source: SourceName,
  artist: string,
  title: string,
  cachedUrls?: { rymUrl?: string; aotyUrl?: string }
): string {
  if (source === 'rym') return cachedUrls?.rymUrl || rymGoogleSearchUrl(artist, title);
  if (source === 'aoty') return cachedUrls?.aotyUrl || `https://www.albumoftheyear.org/search/?q=${encodeURIComponent(`${artist} ${title}`)}`;
  return `https://pitchfork.com/search/?q=${encodeURIComponent(`${artist} ${title}`)}`;
}

export function buildCorroborationQueue(store: Store, now = new Date(), limit = 20): CorroborationItem[] {
  const taste = computeTasteData(store, now);
  const settings = store.settings();
  const today = todayInTimezone(settings.schedule.timezone, now);
  const nowMs = now.getTime();
  const enabledSources = (['rym', 'aoty', 'pitchfork'] as SourceName[]).filter((s) => settings.sources[s]);

  const directUrlMap = new Map<string, { rymUrl?: string; aotyUrl?: string }>();
  const cacheRows = store.database
    .prepare("SELECT cache_key, payload_json FROM catalog_cache WHERE cache_key LIKE 'ext_urls:%' AND status = 'ok'")
    .all() as { cache_key: string; payload_json: string }[];
  for (const row of cacheRows) {
    try {
      directUrlMap.set(row.cache_key.slice('ext_urls:'.length), JSON.parse(row.payload_json) as { rymUrl?: string; aotyUrl?: string });
    } catch {
      // Ignore invalid JSON
    }
  }

  const items: (CorroborationItem & { peakScore: number })[] = [];

  for (const album of store.albums()) {
    if (album.excluded) continue;
    const state =
      taste.candidateStates.get(album.id) ??
      taste.candidateStates.get(`${normalizeIdentity(album.artist)}:${normalizeIdentity(album.title)}`);
    if (state) {
      if (state.reaction === 'liked' || state.reaction === 'disliked') continue;
      if (state.queueState === 'listened' || state.queueState === 'skipped') continue;
    } else if (album.listeningStatus && ['liked', 'listened', 'skipped', 'disliked'].includes(album.listeningStatus)) {
      continue;
    }

    const decision = decide(album, settings, today);
    if (decision.status !== 'pending' || decision.qualifyingSources.length < 1) continue;

    const rawMissing = enabledSources.filter(
      (s) => !album.sources.some((o) => o.source === s && o.status === 'ok' && o.score !== null && isObservationFresh(o, nowMs))
    );
    if (!rawMissing.length) continue;

    const missingSources =
      !album.releaseDate || album.format === 'Unknown'
        ? [...rawMissing.filter((s) => s !== 'pitchfork'), ...rawMissing.filter((s) => s === 'pitchfork')]
        : rawMissing;

    const match = scoreAlbumTaste(album, taste.artistScoreMap, taste.genreScoreMap);
    const personalScore = match.artistAffinity + match.genreOverlap;
    const peakScore = Math.max(
      0,
      ...album.sources
        .filter((o) => decision.qualifyingSources.includes(o.source) && o.score !== null)
        .map((o) => (o.scale > 0 ? o.score! / o.scale : 0))
    );

    const cachedUrls = directUrlMap.get(album.id);
    items.push({
      album,
      qualifyingSources: decision.qualifyingSources,
      missingSources,
      personalScore,
      matchedArtists: match.matchedArtists.slice(0, 3),
      matchedGenres: match.matchedGenres.slice(0, 4),
      searchLinks: missingSources.map((s) => ({ source: s, url: searchUrlForSource(s, album.artist, album.title, cachedUrls) })),
      peakScore
    });
  }

  return items
    .sort(
      (a, b) =>
        b.personalScore - a.personalScore ||
        b.qualifyingSources.length - a.qualifyingSources.length ||
        b.peakScore - a.peakScore ||
        a.album.id.localeCompare(b.album.id)
    )
    .slice(0, limit)
    .map(({ peakScore: _peakScore, ...rest }) => rest);
}
