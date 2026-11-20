import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hasAlbumReviewEvidence } from '../../shared/review-evidence.js';
import type { Album, AlbumAiReview } from '../../shared/types.js';
import type { Store } from '../store.js';
import { getAiApiKey, getAiSettings, type LlmClient } from './client.js';

export { hasAlbumReviewEvidence };

const REVIEW_PROMPT_VERSION = 'v3-evidence-only';

const reviewOutputSchema = z.object({
  shortReview: z.string().trim().min(12).max(160),
  longReview: z.string().trim().min(40).max(1400),
  audienceSummary: z.string().trim().max(200).optional(),
  criticSummary: z.string().trim().max(200).optional()
});

export function computeAlbumEvidenceHash(album: Album): string {
  const normalized = {
    promptVersion: REVIEW_PROMPT_VERSION,
    artist: album.artist,
    title: album.title,
    releaseDate: album.releaseDate,
    genres: [...(album.genres ?? [])].sort(),
    descriptors: [...(album.descriptors ?? [])].sort(),
    sources: [...(album.sources ?? [])]
      .map((s) => ({
        source: s.source,
        status: s.status,
        score: s.score,
        scale: s.scale,
        votes: s.votes,
        bnm: Boolean(s.bestNewMusic),
        criticScore: s.criticScore ?? null,
        criticVotes: s.criticVotes ?? null,
        editorialSummary: s.editorialSummary ?? null,
        detailCaptured: Boolean(s.detailCaptured),
        snippets: s.reviewSnippets ?? []
      }))
      .sort((a, b) => a.source.localeCompare(b.source))
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

interface ReviewRow {
  album_id: string;
  evidence_hash: string;
  evidence_level: 'full' | 'scores_only';
  short_review: string;
  long_review: string;
  audience_summary: string | null;
  critic_summary: string | null;
  model: string;
  generated_at: string;
}

function rowToReview(row: ReviewRow): AlbumAiReview {
  return {
    albumId: row.album_id,
    evidenceHash: row.evidence_hash,
    evidenceLevel: row.evidence_level,
    shortReview: row.short_review,
    longReview: row.long_review,
    ...(row.audience_summary ? { audienceSummary: row.audience_summary } : {}),
    ...(row.critic_summary ? { criticSummary: row.critic_summary } : {}),
    model: row.model,
    generatedAt: row.generated_at
  };
}

export function purgeSpeculativeAiReviews(store: Store): number {
  const result = store.database.prepare("DELETE FROM album_reviews_ai WHERE evidence_level != 'full'").run();
  return Number(result.changes ?? 0);
}

export function readAiReviewsMap(store: Store): Map<string, AlbumAiReview> {
  const rows = store.database
    .prepare("SELECT * FROM album_reviews_ai WHERE evidence_level = 'full'")
    .all() as unknown as ReviewRow[];
  const map = new Map<string, AlbumAiReview>();
  for (const r of rows) map.set(r.album_id, rowToReview(r));
  return map;
}

export function getAiReview(store: Store, albumId: string): AlbumAiReview | null {
  const row = store.database
    .prepare("SELECT * FROM album_reviews_ai WHERE album_id = ? AND evidence_level = 'full'")
    .get(albumId) as ReviewRow | undefined;
  return row ? rowToReview(row) : null;
}

function buildReviewEvidencePacket(album: Album) {
  const rym = album.sources.find((s) => s.source === 'rym' && s.score !== null);
  const aoty = album.sources.find((s) => s.source === 'aoty' && (s.score !== null || s.criticScore != null));
  const p4k = album.sources.find((s) => s.source === 'pitchfork' && s.score !== null);

  const descriptors = [
    ...new Set([
      ...(album.descriptors ?? []),
      ...album.sources.flatMap((s) => s.descriptors ?? [])
    ])
  ].slice(0, 15);

  const audienceSnippets = album.sources
    .flatMap((s) => (s.reviewSnippets ?? []).filter((r) => r.kind === 'user').map((r) => ({ source: s.source, ...r })))
    .slice(0, 6);
  const criticSnippets = album.sources
    .flatMap((s) => (s.reviewSnippets ?? []).filter((r) => r.kind === 'critic').map((r) => ({ source: s.source, ...r })))
    .slice(0, 6);

  return {
    album: {
      artist: album.artist,
      title: album.title,
      releaseDate: album.releaseDate || '未知',
      format: album.format,
      genres: album.genres ?? [],
      descriptors
    },
    audienceReception: {
      rym: rym
        ? {
            score: `${rym.score}/${rym.scale}`,
            votes: rym.votesDisplay || rym.votes || '未知'
          }
        : null,
      aotyUser:
        aoty && aoty.score !== null
          ? {
              score: `${aoty.score}/${aoty.scale}`,
              votes: aoty.votesDisplay || aoty.votes || '未知'
            }
          : null,
      snippets: audienceSnippets
    },
    criticReception: {
      pitchfork: p4k
        ? {
            score: `${p4k.score}/${p4k.scale}`,
            bestNewMusic: Boolean(p4k.bestNewMusic),
            editorialSummary: p4k.editorialSummary || null
          }
        : null,
      aotyCritic:
        aoty && aoty.criticScore != null
          ? {
              score: `${aoty.criticScore}/100`,
              reviewCount: aoty.criticVotes ?? null
            }
          : null,
      snippets: criticSnippets
    }
  };
}

/**
 * Generates and caches a bilingual-evidence-grounded AI review for an album.
 * Strictly refuses generation when no original-page review evidence has been captured yet.
 */
export async function generateAlbumAiReview(
  store: Store,
  album: Album,
  client: LlmClient,
  options: { force?: boolean } = {}
): Promise<AlbumAiReview> {
  const settings = getAiSettings(store);
  if (!settings.enabled) {
    throw new Error('请先在「设置 → AI 与高级」中启用并配置大模型');
  }
  if (!hasAlbumReviewEvidence(album)) {
    throw new Error(
      '暂无原页乐评素材：为避免模型编造，需等浏览器扩展补抓该专辑的 RYM / AOTY / Pitchfork 详情页（含评论摘录、描述词或媒体导语）后再生成 AI 乐评。'
    );
  }

  const evidenceHash = computeAlbumEvidenceHash(album);
  if (!options.force) {
    const existing = getAiReview(store, album.id);
    if (existing && existing.evidenceHash === evidenceHash) {
      return existing;
    }
  }

  const evidenceLevel: 'full' = 'full';
  const packet = buildReviewEvidencePacket(album);

  const system = [
    '你是一位资深独立音乐档案编辑，负责将采集到的海外原站乐评与听众反馈高密度提炼成中文唱片档案笔记，克制、精准、言之有物。',
    '请严格且仅依据用户 JSON 输入中的专辑元数据、原页描述词（descriptors）、大众评分/评论摘录（audienceReception）、媒体评分/导语/评论摘录（criticReception）输出严格 JSON 对象，不要附加任何解释文字。',
    '严守以下零编造写作纪律：',
    '1. 绝对禁止脑补与调用外部印象：严禁使用模型自身记忆或流派刻板印象脑补任何未在输入素材中明确提及的声音质感、具体乐器、制作手法、曲目名、制作人、合作嘉宾、发行故事或原话引语；输入里没写到的信息一概不得写入。',
    '2. 禁止车轱辘话与跨字段重复：shortReview 与 longReview 内禁止照抄 UI 已展示的原始分数或网站名（如不要写“RYM 3.83、Pitchfork 8.3”）；audienceSummary 与 criticSummary 不得与 shortReview 措辞雷同。',
    '3. 评分标尺准确校准：RYM >= 3.70 或 AOTY >= 80（尤其投票数百至数千人以上）已属公开高分共识，RYM >= 3.90 或 AOTY >= 85 属年度尖货，Pitchfork >= 8.0 或 BNM 属媒体高度推崇；严禁将上述高分误判为「分数中庸」「大众接受度不高」。',
    '4. 禁止空洞套话：严禁出现“值得整张聆听”“适合深夜佩戴耳机”“带来全新听觉体验”“令人耳目一新”“点开原网站详情页”等任何水词或系统提示。',
    'JSON 字段结构（唱片档案卡）：',
    '- shortReview: 16–42 字中文一句话提炼，必须直接概括输入摘录或描述词里的核心评价点（不得含分数、站名、脑补词汇或套话）。',
    '- longReview: 中文档案笔记（用空行 \\n\\n 分节），可从以下 4 个带方括号标题中选用有输入素材支撑的小节；**若某个小节在输入素材中缺乏具体依据，直接省略该小节，绝不允许硬凑或靠猜补齐**：',
    '  【声音质地】仅提炼原页描述词或乐评原文里明确写出的音色、节奏、人声与编配特征。',
    '  【风格坐标】仅结合输入流派、描述词与原文对创作定位的讨论做概括。',
    '  【口碑拆解】解读大众评分与媒体评价之间的共识点、关注焦点或分歧所在（不复述数字）。',
    '  【适听与劝退】仅提炼原文或受众反馈中明确提到的偏爱理由或听感门槛。',
    '- audienceSummary: 12–38 字概括输入中 RYM/AOTY 乐迷评语或评分反映的核心反馈；若无听众评论且仅大众高分共识则如实写清「核心乐迷高分认可，暂无具体听众短评摘录」。',
    '- criticSummary: 12–38 字概括输入中 Pitchfork/媒体导语与乐评摘录态度；若输入中无任何媒体评分/导语时诚实写「暂无媒体评分与乐评摘录」。',
    '再次强调：宁可简短诚实，绝不为了篇幅流畅而编造任何输入中不存在的听感判断。'
  ].join('\n');

  const parsed = await client.completeJson({
    settings,
    apiKey: getAiApiKey(store),
    system,
    user: JSON.stringify({ evidenceLevel, ...packet }),
    schema: reviewOutputSchema
  });

  const now = new Date().toISOString();
  const review: AlbumAiReview = {
    albumId: album.id,
    evidenceHash,
    evidenceLevel,
    shortReview: parsed.shortReview,
    longReview: parsed.longReview,
    ...(parsed.audienceSummary ? { audienceSummary: parsed.audienceSummary } : {}),
    ...(parsed.criticSummary ? { criticSummary: parsed.criticSummary } : {}),
    model: settings.model,
    generatedAt: now
  };

  store.database
    .prepare(
      `INSERT INTO album_reviews_ai(
        album_id, evidence_hash, evidence_level, short_review, long_review,
        audience_summary, critic_summary, model, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(album_id) DO UPDATE SET
        evidence_hash = excluded.evidence_hash,
        evidence_level = excluded.evidence_level,
        short_review = excluded.short_review,
        long_review = excluded.long_review,
        audience_summary = excluded.audience_summary,
        critic_summary = excluded.critic_summary,
        model = excluded.model,
        generated_at = excluded.generated_at`
    )
    .run(
      review.albumId,
      review.evidenceHash,
      review.evidenceLevel,
      review.shortReview,
      review.longReview,
      review.audienceSummary ?? null,
      review.criticSummary ?? null,
      review.model,
      review.generatedAt
    );

  return review;
}

export interface ReviewEnqueueResult {
  queuedCount: number;
  totalSelected: number;
  eligibleCount: number;
  skippedNoEvidenceCount: number;
}

/** Serialized background queue for generating album reviews one at a time without blocking HTTP responses. */
export class ReviewQueue {
  private pendingIds: string[] = [];
  private running = false;
  private closed = false;
  private activePromise: Promise<void> | null = null;

  enqueueSelected(store: Store, client: LlmClient): ReviewEnqueueResult {
    if (this.closed) return { queuedCount: 0, totalSelected: 0, eligibleCount: 0, skippedNoEvidenceCount: 0 };
    const existingReviews = readAiReviewsMap(store);
    const selected = store.albums().filter((a) => !a.excluded && a.decision?.status === 'selected');
    const eligible = selected.filter(hasAlbumReviewEvidence);
    let queuedCount = 0;
    for (const album of eligible) {
      const cached = existingReviews.get(album.id);
      const hash = computeAlbumEvidenceHash(album);
      if (cached && cached.evidenceHash === hash) continue;
      if (!this.pendingIds.includes(album.id)) {
        this.pendingIds.push(album.id);
        queuedCount++;
      }
    }
    this.kick(store, client);
    return {
      queuedCount,
      totalSelected: selected.length,
      eligibleCount: eligible.length,
      skippedNoEvidenceCount: selected.length - eligible.length
    };
  }

  private kick(store: Store, client: LlmClient): void {
    if (this.running || this.closed || !this.pendingIds.length) return;
    this.running = true;
    this.activePromise = (async () => {
      try {
        while (!this.closed && this.pendingIds.length) {
          const nextId = this.pendingIds.shift()!;
          const album = store.albums().find((a) => a.id === nextId);
          if (!album || !hasAlbumReviewEvidence(album)) continue;
          try {
            await generateAlbumAiReview(store, album, client);
          } catch {
            // Swallow background errors so remaining albums continue processing cleanly.
          }
        }
      } finally {
        this.running = false;
      }
    })();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.pendingIds = [];
    if (this.activePromise) await this.activePromise.catch(() => {});
  }
}
