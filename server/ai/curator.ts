import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RecommendationItem, RecommendationSet, TastePersona } from '../../shared/personal.js';
import type { Album, SourceName } from '../../shared/types.js';
import type { Store } from '../store.js';
import { decide, isObservationFresh, todayInTimezone } from '../policy.js';
import { normalizeIdentity } from '../sources/parsers.js';
import { computeTasteData, scoreAlbumTaste, splitArtistNorms, type ComputedTasteData } from '../personal/profile.js';
import { generateRecommendations } from '../recommendations/ranker.js';
import { getAiApiKey, getAiSettings, type LlmClient } from './client.js';
import { readAiReviewsMap } from './reviews.js';

const sourceLabels: Record<SourceName, string> = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'Pitchfork' };

const personaResponseSchema = z.object({
  summary: z.string().trim().min(10).max(500),
  sonicSignatures: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
  preferredGenres: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
  avoidances: z.array(z.string().trim().min(1).max(60)).max(6),
  explorationAngles: z.array(z.string().trim().min(1).max(80)).min(1).max(6)
});

const curatorResponseSchema = z.object({
  items: z.array(
    z.object({
      albumId: z.string().min(1),
      slotType: z.enum(['preference', 'exploration', 'hold']),
      matchIndex: z.number().finite().min(0).max(100),
      confidence: z.enum(['high', 'medium', 'low']),
      reasons: z.array(z.string().trim().min(3).max(180)).min(1).max(3)
    })
  )
});

function formatQualifyingSources(album: Album, sources: SourceName[]): string {
  return sources
    .map((name) => {
      const o = album.sources.find((s) => s.source === name && s.status === 'ok');
      if (!o || o.score === null) return sourceLabels[name];
      return `${sourceLabels[name]} ${o.score}${o.bestNewMusic ? ' BNM' : ''}`;
    })
    .join(' · ');
}

export function readLatestPersona(store: Store, profileRevision?: string): TastePersona | null {
  if (profileRevision) {
    const exact = store.database
      .prepare('SELECT payload_json FROM ai_taste_personas WHERE profile_revision = ?')
      .get(profileRevision) as { payload_json: string } | undefined;
    if (exact) {
      try {
        return JSON.parse(exact.payload_json) as TastePersona;
      } catch {
        return null;
      }
    }
  }
  const latest = store.database
    .prepare('SELECT payload_json FROM ai_taste_personas ORDER BY generated_at DESC LIMIT 1')
    .get() as { payload_json: string } | undefined;
  if (!latest) return null;
  try {
    return JSON.parse(latest.payload_json) as TastePersona;
  } catch {
    return null;
  }
}

export async function getOrCreateTastePersona(
  store: Store,
  taste: ComputedTasteData,
  client: LlmClient
): Promise<TastePersona> {
  const existing = store.database
    .prepare('SELECT payload_json FROM ai_taste_personas WHERE profile_revision = ?')
    .get(taste.profile.revision) as { payload_json: string } | undefined;
  if (existing) {
    try {
      return JSON.parse(existing.payload_json) as TastePersona;
    } catch {
      // Regenerate if cached JSON is malformed.
    }
  }

  const settings = getAiSettings(store);
  const albums = store.albums();
  const likedAlbums = albums.filter((a) => {
    const st = taste.candidateStates.get(a.id);
    return st?.reaction === 'liked' || a.listeningStatus === 'liked';
  });
  const dislikedOrSkipped = albums.filter((a) => {
    const st = taste.candidateStates.get(a.id);
    return st?.reaction === 'disliked' || st?.queueState === 'skipped' || a.listeningStatus === 'disliked' || a.listeningStatus === 'skipped';
  });

  const evidence = {
    topArtistsLongTerm: taste.profile.topArtistsLongTerm.slice(0, 25).map((a) => ({
      name: a.name,
      score: a.score,
      listenCount: a.listenCount
    })),
    topArtistsRecent: taste.profile.topArtistsRecent.slice(0, 15).map((a) => ({
      name: a.name,
      score: a.score,
      recentListenCount: a.recentListenCount
    })),
    topGenres: taste.profile.topGenres.slice(0, 20).map((g) => ({ name: g.name, score: g.score })),
    likedAlbums: likedAlbums.slice(0, 12).map((a) => ({ artist: a.artist, title: a.title, genres: a.genres })),
    dislikedOrSkippedAlbums: dislikedOrSkipped.slice(0, 12).map((a) => ({ artist: a.artist, title: a.title, genres: a.genres }))
  };

  const system = [
    '你是一位深谙全球独立音乐、流派谱系与制作美学的私人音乐品味顾问。',
    '请根据用户的历史收听艺人、收藏和站内反馈，结合你自身的音乐百科知识（即使部分艺人未自带流派标签，也可依据你对该艺人的真实风格认知进行归纳），提炼出用户的听觉审美画像，输出严格 JSON：',
    '- summary: 60–140 字中文画像总结，描述核心听觉偏爱、声音质感偏好与涉猎宽度。',
    '- sonicSignatures: 3–6 个核心声音/氛围特征词（中文或英文标准术语，如「合成器氛围」「细腻器乐编曲」「低保真吉他」）。',
    '- preferredGenres: 3–8 个核心偏爱流派标签。',
    '- avoidances: 0–4 个大概率会排斥或不建议强塞入偏好位的方向（如极端噪音金属、硬核工业等，仅在证据不支持时谨慎指出）。',
    '- explorationAngles: 2–4 个有审美延展价值、适合推荐到「探索位」的新鲜方向。'
  ].join('\n');

  const parsed = await client.completeJson({
    settings,
    apiKey: getAiApiKey(store),
    system,
    user: JSON.stringify(evidence),
    schema: personaResponseSchema
  });

  const persona: TastePersona = {
    profileRevision: taste.profile.revision,
    summary: parsed.summary,
    sonicSignatures: parsed.sonicSignatures,
    preferredGenres: parsed.preferredGenres,
    avoidances: parsed.avoidances,
    explorationAngles: parsed.explorationAngles,
    model: settings.model,
    generatedAt: new Date().toISOString()
  };

  store.database
    .prepare(
      `INSERT INTO ai_taste_personas(profile_revision, payload_json, model, generated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_revision) DO UPDATE SET
         payload_json = excluded.payload_json,
         model = excluded.model,
         generated_at = excluded.generated_at`
    )
    .run(persona.profileRevision, JSON.stringify(persona), persona.model, persona.generatedAt);

  return persona;
}

/**
 * Generates personalized 7+3 recommendations using the configured Ollama / OpenAI-compatible Curator Agent
 * when enabled and past cold start, falling back transparently to the heuristic ranker on error or cold start.
 */
export async function generateRecommendationsSmart(
  store: Store,
  options: { preferenceSlots?: number; explorationSlots?: number; now?: Date },
  client: LlmClient
): Promise<RecommendationSet> {
  const aiSettings = getAiSettings(store);
  const now = options.now ?? new Date();
  const taste = computeTasteData(store, now);

  if (!aiSettings.enabled || taste.profile.coldStart) {
    const fallback = generateRecommendations(store, options);
    return { ...fallback, engine: 'heuristic' };
  }

  const nowMs = now.getTime();
  const prefLimit = Math.max(1, Math.min(20, options.preferenceSlots ?? 7));
  const exploreLimit = Math.max(0, Math.min(10, options.explorationSlots ?? 3));
  const settings = store.settings();
  const today = todayInTimezone(settings.schedule.timezone, now);
  const albums = store.albums();
  const reviewsMap = readAiReviewsMap(store);

  interface EligibleCandidate {
    album: Album;
    qualifyingSources: SourceName[];
    artistAffinity: number;
    genreOverlap: number;
    referenceBoost: number;
    matchedArtists: string[];
    matchedGenres: string[];
  }

  const eligible: EligibleCandidate[] = [];
  for (const album of albums) {
    if (album.excluded) continue;
    const decision = decide(album, settings, today);
    if (decision.status !== 'selected') continue;
    const freshOk = album.sources.some((s) => settings.sources[s.source] && s.status === 'ok' && isObservationFresh(s, nowMs));
    if (!freshOk) continue;

    const state =
      taste.candidateStates.get(album.id) ??
      taste.candidateStates.get(`${normalizeIdentity(album.artist)}:${normalizeIdentity(album.title)}`);
    if (state) {
      if (state.reaction === 'liked' || state.reaction === 'disliked') continue;
      if (state.queueState === 'listened' || state.queueState === 'skipped') continue;
    } else if (album.listeningStatus && ['liked', 'listened', 'skipped', 'disliked'].includes(album.listeningStatus)) {
      continue;
    }

    const match = scoreAlbumTaste(album, taste.artistScoreMap, taste.genreScoreMap);
    const isSaved = state ? state.queueState === 'saved' : album.listeningStatus === 'saved';
    const hasBnm = album.sources.some((s) => s.status === 'ok' && s.bestNewMusic);
    const referenceBoost = Math.min(15, (isSaved ? 8 : 0) + (hasBnm ? 4 : 0) + (decision.qualifyingSources.length >= 3 ? 3 : 0));

    eligible.push({
      album,
      qualifyingSources: decision.qualifyingSources,
      artistAffinity: match.artistAffinity,
      genreOverlap: match.genreOverlap,
      referenceBoost,
      matchedArtists: match.matchedArtists.slice(0, 3),
      matchedGenres: match.matchedGenres.slice(0, 4)
    });
  }

  if (!eligible.length) {
    const emptySet = generateRecommendations(store, options);
    return { ...emptySet, engine: 'heuristic' };
  }

  try {
    const persona = await getOrCreateTastePersona(store, taste, client);
    const candidatePackets = eligible.slice(0, 30).map((c) => {
      const review = reviewsMap.get(c.album.id);
      const descriptors = [
        ...new Set([...(c.album.descriptors ?? []), ...c.album.sources.flatMap((s) => s.descriptors ?? [])])
      ].slice(0, 10);
      const p4kSummary = c.album.sources.find((s) => s.source === 'pitchfork')?.editorialSummary;
      return {
        albumId: c.album.id,
        artist: c.album.artist,
        title: c.album.title,
        genres: c.album.genres,
        descriptors,
        scores: formatQualifyingSources(c.album, c.qualifyingSources),
        matchedArtists: c.matchedArtists,
        matchedGenres: c.matchedGenres,
        summary: review?.shortReview || p4kSummary || null
      };
    });

    const system = [
      '你是一位私人唱片策展 Agent，任务是从「已通过公开口碑门槛的候选专辑池」中，结合用户的听觉审美画像（TastePersona）挑选最值得听的本周推荐。',
      `请最多选出 ${prefLimit} 张 preference（审美高度契合）和最多 ${exploreLimit} 张 exploration（跨出舒适区但质感可共鸣的探索发现）。`,
      '核心原则：',
      '1. 宁缺毋滥：若候选专辑流派/听感与用户画像明显背道而驰（例如画像偏向梦幻流行/民谣，而候选为极端噪音/Sludge Metal），请标记为 hold，绝不硬塞进 preference！',
      '2. 只能使用候选列表中真实存在的 albumId，严禁编造专辑。',
      '3. 同一主艺人最多出现一次。',
      '4. 输出严格 JSON：{ "items": [ { "albumId": "...", "slotType": "preference" | "exploration" | "hold", "matchIndex": 0-100整数, "confidence": "high" | "medium" | "low", "reasons": ["结合用户过往具体艺人或审美画像解释为什么适合听这张"] } ] }。'
    ].join('\n');

    const aiDecision = await client.completeJson({
      settings: aiSettings,
      apiKey: getAiApiKey(store),
      system,
      user: JSON.stringify({
        persona,
        limits: { preferenceSlots: prefLimit, explorationSlots: exploreLimit },
        candidates: candidatePackets
      }),
      schema: curatorResponseSchema
    });

    const byId = new Map(eligible.map((c) => [c.album.id, c]));
    const primaryArtistKey = (album: Album) => splitArtistNorms(album.artist)[0] ?? normalizeIdentity(album.artist);
    const usedIds = new Set<string>();
    const usedArtists = new Set<string>();
    const prefItems: RecommendationItem[] = [];
    const exploreItems: RecommendationItem[] = [];

    for (const dec of aiDecision.items) {
      if (dec.slotType === 'hold') continue;
      const cand = byId.get(dec.albumId);
      if (!cand) continue;
      const pk = primaryArtistKey(cand.album);
      if (usedIds.has(cand.album.id) || usedArtists.has(pk)) continue;
      if (dec.slotType === 'preference' && prefItems.length >= prefLimit) continue;
      if (dec.slotType === 'exploration' && exploreItems.length >= exploreLimit) continue;

      usedIds.add(cand.album.id);
      usedArtists.add(pk);

      const reasons = [...dec.reasons];
      const item: RecommendationItem = {
        rank: 0,
        album: cand.album,
        slotType: dec.slotType,
        matchIndex: Math.round(dec.matchIndex),
        confidence: dec.confidence,
        qualifyingSources: cand.qualifyingSources,
        reasons,
        breakdown: {
          artistAffinity: cand.artistAffinity,
          genreOverlap: cand.genreOverlap,
          referenceBoost: cand.referenceBoost,
          explorationBonus: dec.slotType === 'exploration' ? Math.max(0, Math.round(dec.matchIndex * 0.25)) : 0,
          totalScore: Math.round(dec.matchIndex),
          matchedArtists: cand.matchedArtists,
          matchedGenres: cand.matchedGenres
        }
      };
      if (dec.slotType === 'preference') prefItems.push(item);
      else exploreItems.push(item);
    }

    const chosen = [...prefItems, ...exploreItems].map((item, idx) => ({ ...item, rank: idx + 1 }));
    const notes: string[] = [];

    const set: RecommendationSet = {
      id: randomUUID(),
      createdAt: now.toISOString(),
      profileRevision: taste.profile.revision,
      coldStart: taste.profile.coldStart,
      preferenceSlots: prefLimit,
      explorationSlots: exploreLimit,
      eligibleCount: eligible.length,
      coverage: taste.profile.coverage,
      notes,
      items: chosen,
      engine: 'ai',
      model: aiSettings.model,
      persona
    };

    store.database
      .prepare('INSERT INTO recommendation_sets(id, created_at, profile_revision, payload_json) VALUES (?, ?, ?, ?)')
      .run(set.id, set.createdAt, set.profileRevision, JSON.stringify(set));

    return set;
  } catch (err) {
    const fallback = generateRecommendations(store, options);
    const reason = err instanceof Error ? err.message : '未知错误';
    const warning = `AI 策展模型暂不可用（${reason}），本次已自动回退为本地规则推荐。`;
    const updatedSet: RecommendationSet = {
      ...fallback,
      engine: 'heuristic',
      notes: [warning, ...fallback.notes]
    };
    store.database
      .prepare('UPDATE recommendation_sets SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(updatedSet), updatedSet.id);
    return updatedSet;
  }
}
