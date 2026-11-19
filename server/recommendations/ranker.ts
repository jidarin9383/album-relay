import { randomUUID } from 'node:crypto';
import type { RecommendationItem, RecommendationSet } from '../../shared/personal.js';
import type { Album, SourceName } from '../../shared/types.js';
import type { Store } from '../store.js';
import { decide, isObservationFresh, todayInTimezone } from '../policy.js';
import { normalizeIdentity } from '../sources/parsers.js';
import { computeTasteData, scoreAlbumTaste, splitArtistNorms } from '../personal/profile.js';

const sourceLabels: Record<SourceName, string> = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'Pitchfork' };

function formatQualifyingSources(album: Album, sources: SourceName[]): string {
  return sources
    .map((name) => {
      const o = album.sources.find((s) => s.source === name && s.status === 'ok');
      if (!o || o.score === null) return sourceLabels[name];
      return `${sourceLabels[name]} ${o.score}${o.bestNewMusic ? ' BNM' : ''}`;
    })
    .join(' · ');
}

export function listRecommendationSets(store: Store, limit = 12): RecommendationSet[] {
  const rows = store.database
    .prepare('SELECT payload_json FROM recommendation_sets ORDER BY created_at DESC LIMIT ?')
    .all(limit) as { payload_json: string }[];
  return rows.map((r) => JSON.parse(r.payload_json) as RecommendationSet);
}

export function generateRecommendations(
  store: Store,
  options: { preferenceSlots?: number; explorationSlots?: number; now?: Date } = {}
): RecommendationSet {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const prefLimit = Math.max(1, Math.min(20, options.preferenceSlots ?? 7));
  const exploreLimit = Math.max(0, Math.min(10, options.explorationSlots ?? 3));

  const taste = computeTasteData(store, now);
  const { profile, artistScoreMap, genreScoreMap, candidateStates } = taste;
  const settings = store.settings();
  const today = todayInTimezone(settings.schedule.timezone, now);
  const albums = store.albums();

  const notes: string[] = [];

  interface ScoredCandidate {
    album: Album;
    qualifyingSources: SourceName[];
    artistAffinity: number;
    genreOverlap: number;
    referenceBoost: number;
    preferenceScore: number;
    matchedArtists: string[];
    matchedGenres: string[];
    isSaved: boolean;
  }

  const eligible: ScoredCandidate[] = [];

  for (const album of albums) {
    if (album.excluded) continue;
    const decision = decide(album, settings, today);
    if (decision.status !== 'selected') continue;
    const freshOk = album.sources.some((s) => settings.sources[s.source] && s.status === 'ok' && isObservationFresh(s, nowMs));
    if (!freshOk) continue;

    // Exclude already-listened, liked, skipped or disliked albums from weekly recommendations
    const state = candidateStates.get(album.id) ?? candidateStates.get(`${normalizeIdentity(album.artist)}:${normalizeIdentity(album.title)}`);
    if (state) {
      if (state.reaction === 'liked' || state.reaction === 'disliked') continue;
      if (state.queueState === 'listened' || state.queueState === 'skipped') continue;
    } else if (album.listeningStatus && ['liked', 'listened', 'skipped', 'disliked'].includes(album.listeningStatus)) {
      continue;
    }

    const { artistAffinity, genreOverlap, matchedArtists, matchedGenres } = scoreAlbumTaste(album, artistScoreMap, genreScoreMap);

    const isSaved = state ? state.queueState === 'saved' : album.listeningStatus === 'saved';
    const hasBnm = album.sources.some((s) => s.status === 'ok' && s.bestNewMusic);
    const referenceBoost = Math.min(15, (isSaved ? 8 : 0) + (hasBnm ? 4 : 0) + (decision.qualifyingSources.length >= 3 ? 3 : 0));

    eligible.push({
      album,
      qualifyingSources: decision.qualifyingSources,
      artistAffinity,
      genreOverlap,
      referenceBoost,
      preferenceScore: artistAffinity + genreOverlap + referenceBoost,
      matchedArtists: matchedArtists.slice(0, 3),
      matchedGenres: matchedGenres.slice(0, 4),
      isSaved
    });
  }

  const chosen: RecommendationItem[] = [];
  const usedIds = new Set<string>();
  const usedArtists = new Set<string>();
  const usedGenres = new Set<string>();

  const primaryArtistKey = (album: Album) => splitArtistNorms(album.artist)[0] ?? normalizeIdentity(album.artist);

  // Preference slots (up to 7)
  const prefSorted = [...eligible].sort((a, b) => {
    if (!profile.coldStart && b.preferenceScore !== a.preferenceScore) return b.preferenceScore - a.preferenceScore;
    if (b.qualifyingSources.length !== a.qualifyingSources.length) return b.qualifyingSources.length - a.qualifyingSources.length;
    if (b.referenceBoost !== a.referenceBoost) return b.referenceBoost - a.referenceBoost;
    return a.album.id.localeCompare(b.album.id);
  });

  for (const c of prefSorted) {
    if (chosen.length >= prefLimit) break;
    const pk = primaryArtistKey(c.album);
    if (usedArtists.has(pk)) continue;
    usedIds.add(c.album.id);
    usedArtists.add(pk);
    for (const g of c.album.genres) usedGenres.add(normalizeIdentity(g));

    const matchIndex = profile.coldStart
      ? Math.min(60, 35 + c.referenceBoost * 2)
      : Math.max(1, Math.min(100, Math.round(c.preferenceScore + (c.album.genres.length > 0 ? 5 : 0))));
    const confidence: RecommendationItem['confidence'] =
      profile.coldStart || (!c.album.genres.length && c.artistAffinity === 0) || (c.artistAffinity === 0 && c.genreOverlap === 0 && !c.isSaved)
        ? 'low'
        : c.artistAffinity >= 12 || (c.artistAffinity + c.genreOverlap >= 28 && c.album.genres.length > 0)
          ? 'high'
          : 'medium';

    const reasons: string[] = [];
    if (!profile.coldStart) {
      if (c.matchedArtists.length) reasons.push(`常听 ${c.matchedArtists.join('、')}`);
      if (c.matchedGenres.length) reasons.push(`契合你偏爱的 ${c.matchedGenres.slice(0, 3).join(' / ')}`);
      if (c.isSaved) reasons.push('已在你的「想听」清单中');
    }
    const scoreLine = formatQualifyingSources(c.album, c.qualifyingSources);
    if (scoreLine) reasons.push(scoreLine);

    chosen.push({
      rank: chosen.length + 1,
      album: c.album,
      slotType: 'preference',
      matchIndex,
      confidence,
      qualifyingSources: c.qualifyingSources,
      reasons,
      breakdown: {
        artistAffinity: c.artistAffinity,
        genreOverlap: c.genreOverlap,
        referenceBoost: c.referenceBoost,
        explorationBonus: 0,
        totalScore: c.preferenceScore,
        matchedArtists: c.matchedArtists,
        matchedGenres: c.matchedGenres
      }
    });
  }

  // Exploration slots (up to 3): remaining qualified albums offering novel genres / discoveries
  const remaining = eligible.filter((c) => !usedIds.has(c.album.id) && !usedArtists.has(primaryArtistKey(c.album)));
  const exploreScored = remaining
    .map((c) => {
      const novelGenres = c.album.genres.filter((g) => {
        const gn = normalizeIdentity(g);
        return gn && !usedGenres.has(gn);
      });
      const explorationBonus = Math.min(
        30,
        (novelGenres.length ? 14 : 4) + (c.qualifyingSources.length >= 2 ? 6 : 0) + (c.album.sources.some((s) => s.bestNewMusic) ? 5 : 0)
      );
      return { candidate: c, novelGenres, explorationBonus };
    })
    .sort((a, b) => b.explorationBonus - a.explorationBonus || b.candidate.referenceBoost - a.candidate.referenceBoost || a.candidate.album.id.localeCompare(b.candidate.album.id));

  for (const e of exploreScored) {
    if (chosen.length >= prefLimit + exploreLimit) break;
    const c = e.candidate;
    const pk = primaryArtistKey(c.album);
    if (usedArtists.has(pk)) continue;
    usedIds.add(c.album.id);
    usedArtists.add(pk);

    const confidence: RecommendationItem['confidence'] =
      profile.coldStart || !c.album.genres.length ? 'low' : 'medium';
    const matchIndex = Math.max(20, Math.min(85, e.explorationBonus + Math.round(c.genreOverlap * 0.4) + c.referenceBoost + 20));
    const reasons: string[] = [
      e.novelGenres.length ? `拓展尝试 ${e.novelGenres.slice(0, 3).join(' / ')}` : '跨站高口碑新锐之选'
    ];
    const scoreLine = formatQualifyingSources(c.album, c.qualifyingSources);
    if (scoreLine) reasons.push(scoreLine);

    chosen.push({
      rank: chosen.length + 1,
      album: c.album,
      slotType: 'exploration',
      matchIndex,
      confidence,
      qualifyingSources: c.qualifyingSources,
      reasons,
      breakdown: {
        artistAffinity: c.artistAffinity,
        genreOverlap: c.genreOverlap,
        referenceBoost: c.referenceBoost,
        explorationBonus: e.explorationBonus,
        totalScore: e.explorationBonus + c.referenceBoost,
        matchedArtists: c.matchedArtists,
        matchedGenres: c.matchedGenres
      }
    });
  }

  const set: RecommendationSet = {
    id: randomUUID(),
    createdAt: now.toISOString(),
    profileRevision: profile.revision,
    coldStart: profile.coldStart,
    preferenceSlots: prefLimit,
    explorationSlots: exploreLimit,
    eligibleCount: eligible.length,
    coverage: profile.coverage,
    notes,
    items: chosen
  };

  store.database
    .prepare('INSERT INTO recommendation_sets(id, created_at, profile_revision, payload_json) VALUES (?, ?, ?, ?)')
    .run(set.id, set.createdAt, set.profileRevision, JSON.stringify(set));

  return set;
}
