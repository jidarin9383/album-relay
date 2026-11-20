import { z } from 'zod';
import { normalizeLongReview } from '../../shared/review-evidence.js';
import type { AiProviderKind, Album, MonthlyAiDraft, MonthlyAiDraftItem, Playlist, Settings, SourceName } from '../../shared/types.js';
import type { TastePersona } from '../../shared/personal.js';
import { decide, isObservationFresh, todayInTimezone } from '../policy.js';
import { playlistName } from '../planner.js';
import { generateDescription } from '../reasons.js';
import type { Store } from '../store.js';
import { getAiApiKey, getAiSettings, type LlmClient } from './client.js';
import { readLatestPersona } from './curator.js';
import { readAiReviewsMap } from './reviews.js';

const MONTHLY_DRAFT_KEY = 'latest-monthly-ai-draft';
const SOURCE_LABELS: Record<SourceName, string> = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'P4K' };

const isDismissed = (album: Album) => album.listeningStatus === 'disliked' || album.listeningStatus === 'skipped';

type StoreLike = Pick<Store, 'setValue' | 'settings' | 'albums' | 'playlists'> &
  Partial<Pick<Store, 'database'>> & {
    getValue(key: string): string | null | undefined;
  };

const curationSchema = z.object({
  items: z.array(
    z.object({
      albumId: z.string().min(1),
      decision: z.enum(['admit', 'hold']),
      reason: z.string().trim().min(4).max(120)
    })
  )
});

const playlistIntroSchema = z.object({
  description: z.string().trim().min(30).max(1000)
});

export interface MonthlyCurationResult {
  engine: 'ai' | 'heuristic';
  provider?: AiProviderKind;
  model?: string;
  admittedAlbums: Album[];
  admitted: MonthlyAiDraftItem[];
  held: MonthlyAiDraftItem[];
}

function tryReadPersona(store: StoreLike): TastePersona | null {
  if (!store.database) return null;
  try {
    return readLatestPersona(store as Store);
  } catch {
    return null;
  }
}

function tryReadReviews(store: StoreLike) {
  if (!store.database) return new Map();
  try {
    return readAiReviewsMap(store as Store);
  } catch {
    return new Map();
  }
}

function formatQualifyingBrief(album: Album): string {
  const quals = album.decision?.qualifyingSources ?? [];
  const parts = quals
    .map((src) => {
      const obs = album.sources.find((s) => s.source === src && s.status === 'ok' && s.score !== null);
      if (!obs) return SOURCE_LABELS[src];
      return `${SOURCE_LABELS[src]} ${obs.score}${obs.bestNewMusic ? ' BNM' : ''}`;
    })
    .filter(Boolean);
  return parts.length ? `口碑达标：${parts.join(' · ')}` : '达到公开口碑精选门槛';
}

function acclaimRankScore(album: Album): number {
  let score = (album.decision?.qualifyingSources.length ?? 0) * 15;
  for (const obs of album.sources) {
    if (obs.status !== 'ok' || obs.score === null) continue;
    if (obs.source === 'rym') score += obs.score * 10 + (obs.votes && obs.votes >= 1000 ? 6 : 0);
    if (obs.source === 'aoty') score += obs.score * 0.45 + (obs.votes && obs.votes >= 1000 ? 5 : 0);
    if (obs.source === 'pitchfork') score += obs.score * 4 + (obs.bestNewMusic ? 12 : 0);
  }
  if (album.listeningStatus === 'liked' || album.listeningStatus === 'saved') score += 20;
  return score;
}

function heuristicCurate(candidates: Album[], maxNewAlbums: number): MonthlyCurationResult {
  const ranked = [...candidates].sort((a, b) => acclaimRankScore(b) - acclaimRankScore(a));
  const cap = Math.max(0, maxNewAlbums);
  const admittedAlbums = ranked.slice(0, cap);
  const heldAlbums = ranked.slice(cap);
  return {
    engine: 'heuristic',
    admittedAlbums,
    admitted: admittedAlbums.map((a) => ({
      albumId: a.id,
      artist: a.artist,
      title: a.title,
      decision: 'admit',
      reason: formatQualifyingBrief(a)
    })),
    held: heldAlbums.map((a) => ({
      albumId: a.id,
      artist: a.artist,
      title: a.title,
      decision: 'hold',
      reason: '超出本月单期入单容量上限，暂留待下轮评估'
    }))
  };
}

function trimToBoundary(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, maxChars);
  const sliced = clean.slice(0, maxChars);
  const lastStop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('！'), sliced.lastIndexOf('\n'));
  if (lastStop >= Math.floor(maxChars * 0.55)) {
    return sliced.slice(0, lastStop + 1).trim();
  }
  return `${sliced.slice(0, maxChars - 1).trimEnd()}…`;
}

export async function curateMonthlyPlaylistAlbums(
  store: StoreLike,
  candidates: Album[],
  client: LlmClient,
  options: { maxNewAlbums?: number; currentMonthCount?: number; month?: string } = {}
): Promise<MonthlyCurationResult> {
  const settings = store.settings();
  const maxMonthly = settings.playlist.maxAlbumsPerMonth ?? 12;
  const maxNewAlbums = options.maxNewAlbums ?? Math.max(0, maxMonthly - (options.currentMonthCount ?? 0));
  if (!candidates.length) {
    return { engine: 'heuristic', admittedAlbums: [], admitted: [], held: [] };
  }
  if (maxNewAlbums <= 0) {
    return heuristicCurate(candidates, 0);
  }

  const aiSettings = getAiSettings(store as Store);
  if (!aiSettings.enabled || settings.playlist.aiCurated === false) {
    return heuristicCurate(candidates, maxNewAlbums);
  }

  const persona = tryReadPersona(store);
  const reviewsMap = tryReadReviews(store);
  const pool = [...candidates].sort((a, b) => acclaimRankScore(b) - acclaimRankScore(a)).slice(0, 30);
  const packetCandidates = pool.map((a) => ({
    albumId: a.id,
    artist: a.artist,
    title: a.title,
    releaseDate: a.releaseDate || '未知',
    genres: a.genres.slice(0, 5),
    listeningStatus: a.listeningStatus ?? 'unheard',
    acclaim: formatQualifyingBrief(a),
    shortReview: reviewsMap.get(a.id)?.shortReview ?? null
  }));

  const system = [
    '你是一位独立音乐月度歌单主编，负责把「已通过公开评分初筛的新专辑」做最终入单把关。',
    `本月歌单还可新增最多 ${maxNewAlbums} 张专辑（单月总容量上限 ${maxMonthly} 张，当前已有 ${options.currentMonthCount ?? 0} 张）。`,
    '判断原则：',
    '1. 宁缺毋滥：优先入选跨站高共识、有明显音乐代表性或契合用户品味画像（persona）的作品；同一艺人尽量只留最具代表性的一张。',
    '2. 明确剔除碰撞：若某张专辑的流派气质与 persona.avoidances 明显冲突（且用户未在站内点「喜欢/想听」），果断设为 hold，不强塞进日常月单。',
    '3. 若候选数量超出剩余名额，将相对边缘或风格高度重叠的作品设为 hold，保留最佳组合。',
    '4. 只能使用候选池真实存在的 albumId，禁止编造；每条 reason 用 12–40 字简体中文写清真实理由（禁止只复述分数）。',
    '输出严格 JSON：{ "items": [ { "albumId": "...", "decision": "admit" | "hold", "reason": "..." } ] }。'
  ].join('\n');

  try {
    const res = await client.completeJson({
      settings: aiSettings,
      apiKey: getAiApiKey(store as Store),
      system,
      user: JSON.stringify({
        month: options.month ?? '',
        remainingCapacity: maxNewAlbums,
        persona: persona
          ? {
              summary: persona.summary,
              preferredGenres: persona.preferredGenres,
              avoidances: persona.avoidances
            }
          : null,
        candidates: packetCandidates
      }),
      schema: curationSchema
    });

    const byId = new Map(candidates.map((a) => [a.id, a]));
    const seen = new Set<string>();
    const admittedAlbums: Album[] = [];
    const admitted: MonthlyAiDraftItem[] = [];
    const held: MonthlyAiDraftItem[] = [];

    for (const item of res.items) {
      const album = byId.get(item.albumId);
      if (!album || seen.has(album.id)) continue;
      seen.add(album.id);
      if (item.decision === 'admit' && admittedAlbums.length < maxNewAlbums) {
        admittedAlbums.push(album);
        admitted.push({ albumId: album.id, artist: album.artist, title: album.title, decision: 'admit', reason: item.reason });
      } else {
        held.push({
          albumId: album.id,
          artist: album.artist,
          title: album.title,
          decision: 'hold',
          reason: item.decision === 'admit' ? '受本月入单名额上限限制，暂缓加入' : item.reason
        });
      }
    }

    if (seen.size === 0) {
      return heuristicCurate(candidates, maxNewAlbums);
    }

    for (const remaining of candidates) {
      if (seen.has(remaining.id)) continue;
      held.push({
        albumId: remaining.id,
        artist: remaining.artist,
        title: remaining.title,
        decision: 'hold',
        reason: '本轮未进入 AI 精选入单席位'
      });
    }

    return {
      engine: 'ai',
      provider: aiSettings.provider,
      model: aiSettings.model,
      admittedAlbums,
      admitted,
      held
    };
  } catch {
    return heuristicCurate(candidates, maxNewAlbums);
  }
}

export async function generateAiPlaylistDescription(
  store: StoreLike,
  month: string,
  playlistNameText: string,
  albums: Album[],
  maxChars: number,
  client: LlmClient
): Promise<string> {
  const limit = Math.max(20, Math.min(1000, maxChars));
  if (!albums.length) {
    return trimToBoundary(`听点好的月度新专精选（${month}），等待新的高分专辑收录同步。`, limit);
  }

  const aiSettings = getAiSettings(store as Store);
  const settings = store.settings();
  if (!aiSettings.enabled || settings.playlist.aiDescription === false) {
    return generateDescription(albums, { playlist: { namePattern: playlistNameText, descriptionMaxChars: limit } });
  }

  const reviewsMap = tryReadReviews(store);
  const footer = `\n\n本期收录 ${albums.length} 张新专 · 依据 AOTY / RYM / P4K 跨站口碑与 AI 策展生成。`;
  const proseBudget = Math.max(80, Math.min(460, limit - footer.length - 10));

  const digest = albums.slice(0, 16).map((a) => ({
    artist: a.artist,
    title: a.title,
    genres: a.genres.slice(0, 4),
    shortReview: reviewsMap.get(a.id)?.shortReview ?? null
  }));

  const system = [
    '你是一位独立音乐刊物的资深编辑，正在为当月网易云精选歌单撰写简介导语。',
    `请写一段总长度约 120–${proseBudget} 字的连贯中文导语，要求：`,
    '1. 必须写成通顺连贯的散文短段（1–2 段），有音乐线索与画面感，自然过渡串联不同风格与音乐人。',
    '2. 严禁写成流水账、清单、编号列表或机械复读格式（如禁止出现“1. 2. 3.”“艺人 — 专辑｜入选理由｜85/100”）。',
    '3. 不罗列具体分数数字，不编造未提及的曲目名，不使用“一场听觉盛宴”“令人耳目一新”“值得深夜单曲循环”等陈词滥调。',
    '输出严格 JSON：{ "description": "..." }。'
  ].join('\n');

  try {
    const res = await client.completeJson({
      settings: aiSettings,
      apiKey: getAiApiKey(store as Store),
      system,
      user: JSON.stringify({ month, playlistName: playlistNameText, albumCount: albums.length, albums: digest }),
      schema: playlistIntroSchema
    });
    const normalizedDescription = normalizeLongReview(res.description);
    const combined = normalizedDescription + (normalizedDescription.length + footer.length <= limit ? footer : '');
    return trimToBoundary(combined, limit);
  } catch {
    return generateDescription(albums, { playlist: { namePattern: playlistNameText, descriptionMaxChars: limit } });
  }
}

export function readLatestMonthlyDraft(store: StoreLike): MonthlyAiDraft | null {
  const raw = store.getValue(MONTHLY_DRAFT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MonthlyAiDraft;
  } catch {
    return null;
  }
}

export function saveLatestMonthlyDraft(store: StoreLike, draft: MonthlyAiDraft): void {
  store.setValue(MONTHLY_DRAFT_KEY, JSON.stringify(draft));
}

export async function buildMonthlyAiDraft(
  store: StoreLike,
  client: LlmClient,
  now = new Date()
): Promise<MonthlyAiDraft> {
  const settings = store.settings();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.schedule.timezone,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const month = `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
  const name = playlistName(settings.playlist.namePattern, month);
  const playlists: Playlist[] = store.playlists();
  const existing = playlists.find((p) => p.month === month) ?? null;
  const currentIds = new Set(existing?.albumIds ?? []);
  const otherMonthIds = new Set(playlists.filter((p) => p.month !== month).flatMap((p) => p.albumIds));
  const today = todayInTimezone(settings.schedule.timezone, now);
  const nowMs = now.getTime();

  const evaluated = store.albums().map((a) => {
    const copy = structuredClone(a);
    for (const o of copy.sources) {
      if (settings.sources[o.source] && o.status === 'ok' && !isObservationFresh(o, nowMs)) {
        o.status = 'error';
      }
    }
    copy.decision = decide(copy, settings, today);
    return copy;
  });

  const retained = evaluated.filter((a) => currentIds.has(a.id) || a.admittedMonth === month);
  const freshPool = evaluated.filter(
    (a) =>
      !currentIds.has(a.id) &&
      !a.admittedMonth &&
      !otherMonthIds.has(a.id) &&
      !a.excluded &&
      !isDismissed(a) &&
      a.decision?.status === 'selected'
  );

  const curation = await curateMonthlyPlaylistAlbums(store, freshPool, client, {
    currentMonthCount: retained.length,
    month
  });
  const combined = [...retained, ...curation.admittedAlbums];
  const description = await generateAiPlaylistDescription(
    store,
    month,
    name,
    combined,
    settings.playlist.descriptionMaxChars,
    client
  );

  const draft: MonthlyAiDraft = {
    month,
    playlistName: name,
    engine: curation.engine,
    ...(curation.provider ? { provider: curation.provider } : {}),
    ...(curation.model ? { model: curation.model } : {}),
    description,
    admitted: [
      ...retained.map((a) => ({
        albumId: a.id,
        artist: a.artist,
        title: a.title,
        decision: 'retained' as const,
        reason: '本月歌单已保留收录'
      })),
      ...curation.admitted
    ],
    held: curation.held,
    generatedAt: new Date().toISOString()
  };

  saveLatestMonthlyDraft(store, draft);
  return draft;
}
