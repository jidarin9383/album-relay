import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Album, AlbumAiReview } from '../../shared/types.js';
import type { Store } from '../store.js';
import { getAiApiKey, getAiSettings, type LlmClient } from './client.js';

const REVIEW_PROMPT_VERSION = 'v2-dossier-a';

const reviewOutputSchema = z.object({
  shortReview: z.string().trim().min(12).max(160),
  longReview: z.string().trim().min(60).max(1400),
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

export function readAiReviewsMap(store: Store): Map<string, AlbumAiReview> {
  const rows = store.database.prepare('SELECT * FROM album_reviews_ai').all() as unknown as ReviewRow[];
  const map = new Map<string, AlbumAiReview>();
  for (const r of rows) map.set(r.album_id, rowToReview(r));
  return map;
}

export function getAiReview(store: Store, albumId: string): AlbumAiReview | null {
  const row = store.database
    .prepare('SELECT * FROM album_reviews_ai WHERE album_id = ?')
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
 * Generates and caches a short + long bilingual-evidence-grounded AI review for an album.
 * Never invents missing quotes or scores when `evidenceLevel === 'scores_only'`.
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

  const evidenceHash = computeAlbumEvidenceHash(album);
  if (!options.force) {
    const existing = getAiReview(store, album.id);
    if (existing && existing.evidenceHash === evidenceHash) {
      return existing;
    }
  }

  const hasDetailEvidence = album.sources.some(
    (s) => Boolean(s.detailCaptured) || Boolean(s.editorialSummary?.trim()) || Boolean(s.reviewSnippets?.length)
  );
  const evidenceLevel: 'full' | 'scores_only' = hasDetailEvidence ? 'full' : 'scores_only';
  const packet = buildReviewEvidencePacket(album);

  const system = [
    '你是一位资深独立音乐档案编辑，专写给挑剔老乐迷看的高密度唱片档案笔记，克制、精准、言之有物。',
    '请仅依据用户提供的专辑元数据、大众评分/短评、媒体评分/乐评摘录（可结合你对艺人及所列流派的真实音乐美学认知）输出严格 JSON 对象，不要附加任何解释文字。',
    '严守以下写作纪律：',
    '1. 禁止车轱辘话与跨字段重复：shortReview 与 longReview 内禁止照抄 UI 已展示的原始分数或网站名（如不要写“RYM 3.83、Pitchfork 8.3”）；audienceSummary 与 criticSummary 不得与 shortReview 措辞雷同。',
    '2. 评分标尺准确校准：RYM >= 3.70 或 AOTY >= 80（尤其投票数百至数千人以上）已属公开高分共识，RYM >= 3.90 或 AOTY >= 85 属年度尖货，Pitchfork >= 8.0 或 BNM 属媒体高度推崇；严禁将上述高分误判为「分数中庸」「大众接受度不高」。',
    '3. 禁止虚构与脑补：严禁捏造未在证据中出现的曲目名、制作人、合作嘉宾或原话引语；未抓取详情摘录（evidenceLevel="scores_only"）时，严禁无中生有猜测具体未列出的乐器配置。',
    '4. 禁止空洞套话：严禁出现“值得整张聆听”“适合深夜佩戴耳机”“带来全新听觉体验”“令人耳目一新”“点开原网站详情页”等任何水词或系统提示。',
    'JSON 字段结构（唱片档案卡）：',
    '- shortReview: 24–42 字中文一句话抓手，直点核心声音特质与创作野心（不得含分数、站名或套话）。',
    '- longReview: 160–280 字中文档案，必须用空行（\\n\\n）严格分成以下 4 个带方括号标题的小节：',
    '  【声音质地】点明音色肌理、节奏骨架与制作取向（不空泛夸赞）。',
    '  【风格坐标】点出该作在流派谱系或艺人创作线上的具体落点与辨识度。',
    '  【口碑拆解】解读大众投票规模/倾向与媒体评价之间的共识或温差原因（不复述数字）。',
    '  【适听与劝退】明确指出最击中哪类审美偏好，以及可能劝退的具体听感门槛。',
    '- audienceSummary: 12–38 字概括 RYM/AOTY 乐迷口碑定调与主要共鸣点。',
    '- criticSummary: 12–38 字概括媒体态度；若输入中无任何媒体评分/Pitchfork 时诚实写「暂无媒体评分，当前由核心乐迷高分推高」。',
    evidenceLevel === 'scores_only'
      ? '当前证据级别为 scores_only（仅评分与流派标签，尚未抓取详情页评论原文）：请紧扣已有流派、艺人谱系与口碑温差作深层拆解，绝不编造曲名、乐评原话或未提及的乐器细节。'
      : '当前证据级别为 full（含原页描述词、媒体导语或评论摘录）：请充分吸收并忠实转述其中的核心观点与争议细节。'
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

/** Serialized background queue for generating album reviews one at a time without blocking HTTP responses. */
export class ReviewQueue {
  private pendingIds: string[] = [];
  private running = false;
  private closed = false;
  private activePromise: Promise<void> | null = null;

  enqueueSelected(store: Store, client: LlmClient): { queuedCount: number; totalSelected: number } {
    if (this.closed) return { queuedCount: 0, totalSelected: 0 };
    const existingReviews = readAiReviewsMap(store);
    const selected = store.albums().filter((a) => !a.excluded && a.decision?.status === 'selected');
    let queuedCount = 0;
    for (const album of selected) {
      const cached = existingReviews.get(album.id);
      const hash = computeAlbumEvidenceHash(album);
      if (cached && cached.evidenceHash === hash) continue;
      if (!this.pendingIds.includes(album.id)) {
        this.pendingIds.push(album.id);
        queuedCount++;
      }
    }
    this.kick(store, client);
    return { queuedCount, totalSelected: selected.length };
  }

  private kick(store: Store, client: LlmClient): void {
    if (this.running || this.closed || !this.pendingIds.length) return;
    this.running = true;
    this.activePromise = (async () => {
      try {
        while (!this.closed && this.pendingIds.length) {
          const nextId = this.pendingIds.shift()!;
          const album = store.albums().find((a) => a.id === nextId);
          if (!album) continue;
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
