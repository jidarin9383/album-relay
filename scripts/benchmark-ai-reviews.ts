/**
 * Benchmarks AI album review formats (A/B/C) across local Ollama models
 * (and optionally Google Gemini when --gemini + GEMINI_API_KEY are set).
 *
 * Usage:
 *   npx tsx scripts/benchmark-ai-reviews.ts
 *   GEMINI_API_KEY=... npx tsx scripts/benchmark-ai-reviews.ts --gemini
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DefaultLlmClient, extractJsonText, GEMINI_DEFAULT_BASE_URL } from '../server/ai/client.js';
import { resolveDbPath } from '../server/store.js';
import type { AiSettings, Album } from '../shared/types.js';

export type FormatVariantId = 'A' | 'B' | 'C';

const reviewSchema = z.object({
  shortReview: z.string().trim().min(12).max(160),
  longReview: z.string().trim().min(60).max(1400),
  audienceSummary: z.string().trim().min(6).max(200),
  criticSummary: z.string().trim().min(6).max(200)
});

type ReviewOutput = z.infer<typeof reviewSchema>;

interface BenchmarkCase {
  id: string;
  label: string;
  evidenceLevel: 'full' | 'scores_only';
  album: Album;
}

export interface BenchmarkRunRecord {
  phase: 'model-compare' | 'thinking-compare' | 'format-compare' | 'v1-check' | 'gemini';
  provider: 'ollama' | 'gemini';
  model: string;
  think?: boolean;
  variant: FormatVariantId;
  caseId: string;
  evidenceLevel: 'full' | 'scores_only';
  ok: boolean;
  wallMs: number;
  loadMs?: number;
  evalMs?: number;
  evalTokens?: number;
  tokPerSec?: number;
  output?: ReviewOutput;
  rawPreview?: string;
  error?: string;
  flags: string[];
}

function buildPacket(c: BenchmarkCase) {
  const { album } = c;
  const rym = album.sources.find((s) => s.source === 'rym' && s.score !== null);
  const aoty = album.sources.find((s) => s.source === 'aoty' && (s.score !== null || s.criticScore != null));
  const p4k = album.sources.find((s) => s.source === 'pitchfork' && s.score !== null);

  const descriptors = [
    ...new Set([...(album.descriptors ?? []), ...album.sources.flatMap((s) => s.descriptors ?? [])])
  ].slice(0, 15);

  const audienceSnippets = album.sources
    .flatMap((s) => (s.reviewSnippets ?? []).filter((r) => r.kind === 'user').map((r) => ({ source: s.source, ...r })))
    .slice(0, 6);
  const criticSnippets = album.sources
    .flatMap((s) => (s.reviewSnippets ?? []).filter((r) => r.kind === 'critic').map((r) => ({ source: s.source, ...r })))
    .slice(0, 6);

  return {
    evidenceLevel: c.evidenceLevel,
    album: {
      artist: album.artist,
      title: album.title,
      releaseDate: album.releaseDate || '未知',
      format: album.format,
      genres: album.genres ?? [],
      descriptors
    },
    audienceReception: {
      rym: rym ? { score: `${rym.score}/${rym.scale}`, votes: rym.votesDisplay || rym.votes || '未知' } : null,
      aotyUser: aoty && aoty.score !== null ? { score: `${aoty.score}/${aoty.scale}`, votes: aoty.votesDisplay || aoty.votes || '未知' } : null,
      snippets: audienceSnippets
    },
    criticReception: {
      pitchfork: p4k ? { score: `${p4k.score}/${p4k.scale}`, bestNewMusic: Boolean(p4k.bestNewMusic), editorialSummary: p4k.editorialSummary || null } : null,
      aotyCritic: aoty && aoty.criticScore != null ? { score: `${aoty.criticScore}/100`, reviewCount: aoty.criticVotes ?? null } : null,
      snippets: criticSnippets
    }
  };
}

const COMMON_ANTI_FLUFF_RULES = [
  '严格写作纪律（违反任一条即判不合格）：',
  '1. 禁止车轱辘话与跨字段重复：shortReview 与 longReview 内禁止照抄 UI 已经展示的原始分数、站名（如不要写“RYM 3.83分、Pitchfork 8.3分获得好评”）；只谈口碑背后的“意味”（例如：大众高票认同 vs 媒体更激进推崇的温差、核心圈层追捧等）。具体评分归属放在 audienceSummary / criticSummary（保持各 ≤32 字，且不和 shortReview 重复措辞）。',
  '2. 禁止虚构细节：严禁编造具体曲目名（tracklist 之外的歌名）、制作人姓名、原话引语或媒体机构名。若 evidenceLevel="scores_only"（无原文摘录），可结合你对这位艺人与所列流派的客观音乐美学认知，分析制作质感与风格定位，但绝不假装读过该专辑某首单曲。',
  '3. 禁止空洞套话：禁止出现“值得整张聆听”“适合深夜佩戴耳机静静品味”“带来全新听觉体验”“令人耳目一新”“点开原网站详情页自动抓取”等任何废话或系统操作提示。',
  '4. 所有字符串使用简洁有力、信息密度高的简体中文（流派与专业词可保留必要英文术语），只输出严格 JSON 对象，字段：shortReview, longReview, audienceSummary, criticSummary。'
];

export function buildPromptForVariant(variant: FormatVariantId): { name: string; system: string } {
  if (variant === 'A') {
    return {
      name: 'Format A · 唱片档案卡（4行结构化要点）',
      system: [
        '你是一位资深独立音乐档案编辑，写给挑剔老乐迷看的高密度唱片笔记。',
        ...COMMON_ANTI_FLUFF_RULES,
        '字段结构（Format A）：',
        '- shortReview: 24–42 字中文一句话抓手，直点核心声音特质与创作野心（不得含分数或站点名）。',
        '- longReview: 160–260 字，必须用 \\n\\n 分隔以下 4 个带方括号标题的小节：',
        '  【声音质地】点明音色肌理、节奏骨架构成与制作取向（不空泛形容“很棒”）。',
        '  【风格坐标】点出该作在流派谱系或艺人创作线上的具体落点与辨识度。',
        '  【口碑拆解】解读大众投票规模/倾向与媒体评价之间的共识或微妙温差（不罗列数字）。',
        '  【适听与劝退】明确指出最能击中哪类偏好，以及可能让人劝退的具体听感门槛。',
        '- audienceSummary: 12–34 字概括 RYM/AOTY 乐迷口碑定调与核心评价倾向。',
        '- criticSummary: 12–34 字概括媒体态度；若无 Pitchfork/AOTY 媒体分则写「暂无媒体评分，当前仅由核心乐迷高分推高」。'
      ].join('\n')
    };
  }
  if (variant === 'B') {
    return {
      name: 'Format B · 编辑部短评（Pitchfork / 音乐志专栏风）',
      system: [
        '你是一位锋利克制的音乐志主笔，行文紧凑有画面感与判断力，不堆砌形容词。',
        ...COMMON_ANTI_FLUFF_RULES,
        '字段结构（Format B）：',
        '- shortReview: 26–45 字杂志副标题式短句，凸显这张专辑最鲜明的审美反差或核心张力（不得含分数或站点名）。',
        '- longReview: 180–280 字，必须用 \\n\\n 分三段，采用以下轻量分段形式：',
        '  ▸ 听感切面：紧凑写清这张专辑的声音材质、编排重心与情绪底色。',
        '  ▸ 口碑看点：解析为何大众乐迷与专业乐评会同时买账或出现评分温差；若有 snippets / editorialSummary 须精准转述核心观点，否则克制说明“暂无长评摘录”后再分析其圈层受众意义。',
        '  ▸ 试听判断：一句干脆的入耳切入提示或明确跳过信号（例如编排密集度、人声风格、噪度风险）。',
        '- audienceSummary: 12–34 字概括大众乐迷评价方向。',
        '- criticSummary: 12–34 字概括媒体立场；若无媒体分则写「媒体暂未入评，口碑主要来自乐迷自发传播」。'
      ].join('\n')
    };
  }
  return {
    name: 'Format C · 听前速判单（五维对比清单）',
    system: [
      '你是一位偏重实用筛选的唱片选片人，把专辑拆成快速扫读就能决定是否加入播放队列的五维清单。',
      ...COMMON_ANTI_FLUFF_RULES,
      '字段结构（Format C）：',
      '- shortReview: 20–38 字「流派切面 + 听觉核心卖点」（不得含分数、站点名或废话）。',
      '- longReview: 160–250 字，必须用 \\n\\n 分隔以下 5 行维度：',
      '  听感关键词：用 3–4 个具象质感短语（如“干燥无鼓点采样 / 紧绷叙事”而非笼统褒义词）',
      '  制作与编排：简析器乐、合成器/采样、节奏或人声是如何组织张力的',
      '  口碑格局：点明大众热度规模与媒体态度之间呈现怎样的共识或冷热差（不照抄 UI 已有具体数字）',
      '  气质参照：给出 1–2 个风格接近的场景脉络或气质相近的音乐流派/年代坐标（禁止编造虚构合作）',
      '  雷区预警：直白写出听感门槛（如高噪度/低旋律性/偏流行取向），没有硬伤也要指出偏向哪类耳朵',
      '- audienceSummary: 12–32 字总结大众乐迷侧表现。',
      '- criticSummary: 12–32 字总结媒体评分态度；若无媒体分则写「暂无权威媒体打分」。'
    ].join('\n')
  };
}

function loadBenchmarkCases(): BenchmarkCase[] {
  const db = new DatabaseSync(resolveDbPath('./data'), { readOnly: true });
  try {
    const raw = db.prepare('SELECT value FROM config WHERE key = ?').get('albums') as { value: string } | undefined;
    const albums: Album[] = raw ? (JSON.parse(raw.value) as Album[]) : [];
    const pick = (idPrefix: string, fallbackIdx: number): Album => {
      const found = albums.find((a) => a.id.startsWith(idPrefix));
      if (found) return found;
      return albums.filter((a) => !a.excluded && a.decision?.status === 'selected')[fallbackIdx]!;
    };

    const armand = pick('1ce47f4b', 0);
    const tinashe = pick('47c3', 5);
    const tinaReal = albums.find((a) => a.artist === 'Tinashe') ?? tinashe;

    const fullSample: Album = {
      id: 'fixture-full-geese',
      artist: 'Geese',
      title: 'Getting Killed',
      releaseDate: '2026-09-26',
      format: 'LP',
      genres: ['Art Punk', 'Indie Rock', 'Post-Punk'],
      descriptors: ['angular guitars', 'sardonic vocals', 'kinetic grooves', 'raw production', 'nervous energy'],
      excluded: false,
      sources: [
        {
          source: 'rym',
          score: 3.88,
          scale: 5,
          votes: 4200,
          votesDisplay: '4k',
          url: 'https://rateyourmusic.com/release/album/geese/getting-killed/',
          observedAt: new Date().toISOString(),
          status: 'ok',
          collectionMethod: 'browser-capture',
          detailCaptured: true,
          descriptors: ['angular', 'eccentric', 'energetic'],
          reviewSnippets: [
            {
              kind: 'user',
              author: 'tape_hiss',
              score: 4.5,
              text: 'Tighter rhythm section than their debut, less sprawling jam-band excess and way sharper hooks.'
            },
            {
              kind: 'user',
              author: 'mono_ear',
              score: 3.5,
              text: 'The theatrical baritone vocal quirks can grate after track 6, though the drum pocket is undeniable.'
            }
          ]
        },
        {
          source: 'aoty',
          score: 84,
          scale: 100,
          votes: 3100,
          criticScore: 86,
          criticVotes: 18,
          url: 'https://www.albumoftheyear.org/album/999999-geese-getting-killed.php',
          observedAt: new Date().toISOString(),
          status: 'ok',
          collectionMethod: 'browser-capture',
          detailCaptured: true,
          reviewSnippets: [
            {
              kind: 'critic',
              publication: 'The Quietus',
              score: 85,
              text: 'A wiry, rhythm-obsessed record that channels krautrock propulsion through dry New York post-punk snarl.'
            }
          ]
        },
        {
          source: 'pitchfork',
          score: 8.4,
          scale: 10,
          votes: null,
          bestNewMusic: true,
          url: 'https://pitchfork.com/reviews/albums/geese-getting-killed/',
          observedAt: new Date().toISOString(),
          status: 'ok',
          collectionMethod: 'browser-capture',
          detailCaptured: true,
          editorialSummary: 'Anchored by clipping snare hits and taut funk-punk basslines, the band channels nervous humor into disciplined songwriting.'
        }
      ]
    };

    return [
      { id: 'armand_scores_only', label: `${armand.artist} — ${armand.title} (实库 scores_only)`, evidenceLevel: 'scores_only', album: armand },
      { id: 'tinashe_scores_only', label: `${tinaReal.artist} — ${tinaReal.title} (实库 scores_only)`, evidenceLevel: 'scores_only', album: tinaReal },
      { id: 'geese_full', label: `${fullSample.artist} — ${fullSample.title} (样例 full 证据)`, evidenceLevel: 'full', album: fullSample }
    ];
  } finally {
    db.close();
  }
}

function auditFlags(output: ReviewOutput, c: BenchmarkCase): string[] {
  const flags: string[] = [];
  const allText = `${output.shortReview}\n${output.longReview}`;
  if (/(?:夜晚|深夜|耳机|安静|闭上眼睛|一场听觉盛宴|耳目一新|点开原网站|详情页后扩展)/.test(allText)) {
    flags.push('cliche_filler');
  }
  if (/(?:\b3\.\d{1,2}\b|\b8\.\d\b|\b8\d\/\d+|\b10\.\d\b|Pitchfork|RYM|AOTY)/i.test(output.shortReview)) {
    flags.push('short_repeats_score_or_site');
  }
  if (/(?:3\.83|3\.72|8\.3|9\.0|81\/100|84\/100)/.test(output.longReview)) {
    flags.push('long_repeats_exact_score');
  }
  if (c.evidenceLevel === 'scores_only' && /《[^》]{2,30}》/.test(allText.replace(`《${c.album.title}》`, ''))) {
    flags.push('possible_invented_title_in_scores_only');
  }
  if (output.shortReview.trim() === output.audienceSummary.trim()) {
    flags.push('duplicate_short_and_audience');
  }
  return flags;
}

async function unloadOllamaModel(model: string): Promise<void> {
  await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 })
  }).catch(() => {});
}

async function runOllamaNative(
  model: string,
  variant: FormatVariantId,
  testCase: BenchmarkCase,
  opts: { think: boolean; timeoutMs?: number }
): Promise<BenchmarkRunRecord> {
  const { system } = buildPromptForVariant(variant);
  const packet = buildPacket(testCase);
  const started = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        ...(opts.think !== undefined && !model.startsWith('qwen2.5') ? { think: opts.think } : {}),
        options: { temperature: 0.3 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(packet) }
        ]
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000)
    });
    const wallMs = Date.now() - started;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return {
        phase: opts.think ? 'thinking-compare' : 'model-compare',
        provider: 'ollama',
        model,
        think: opts.think,
        variant,
        caseId: testCase.id,
        evidenceLevel: testCase.evidenceLevel,
        ok: false,
        wallMs,
        error: `HTTP ${res.status}: ${txt.slice(0, 120)}`,
        flags: []
      };
    }
    const body = (await res.json()) as {
      message?: { content?: string; thinking?: string };
      load_duration?: number;
      eval_duration?: number;
      eval_count?: number;
    };
    const loadMs = body.load_duration ? Math.round(body.load_duration / 1e6) : undefined;
    const evalMs = body.eval_duration ? Math.round(body.eval_duration / 1e6) : undefined;
    const evalTokens = body.eval_count;
    const tokPerSec = evalMs && evalTokens ? Number((evalTokens / (evalMs / 1000)).toFixed(1)) : undefined;
    const rawContent = body.message?.content ?? '';
    const jsonText = extractJsonText(rawContent);
    const output = reviewSchema.parse(JSON.parse(jsonText));
    return {
      phase: opts.think ? 'thinking-compare' : 'model-compare',
      provider: 'ollama',
      model,
      think: opts.think,
      variant,
      caseId: testCase.id,
      evidenceLevel: testCase.evidenceLevel,
      ok: true,
      wallMs,
      loadMs,
      evalMs,
      evalTokens,
      tokPerSec,
      output,
      flags: auditFlags(output, testCase)
    };
  } catch (err) {
    return {
      phase: opts.think ? 'thinking-compare' : 'model-compare',
      provider: 'ollama',
      model,
      think: opts.think,
      variant,
      caseId: testCase.id,
      evidenceLevel: testCase.evidenceLevel,
      ok: false,
      wallMs: Date.now() - started,
      rawPreview: undefined,
      error: err instanceof Error ? err.message : String(err),
      flags: []
    };
  }
}

async function runViaDefaultClient(
  provider: 'ollama' | 'gemini',
  model: string,
  baseUrl: string,
  apiKey: string | null,
  variant: FormatVariantId,
  testCase: BenchmarkCase,
  phase: BenchmarkRunRecord['phase'],
  timeoutMs = 90_000
): Promise<BenchmarkRunRecord> {
  const client = new DefaultLlmClient();
  const settings: AiSettings = {
    enabled: true,
    provider,
    baseUrl,
    model,
    autoReviewSelected: false,
    timeoutMs,
    hasApiKey: Boolean(apiKey)
  };
  const { system } = buildPromptForVariant(variant);
  const packet = buildPacket(testCase);
  const started = Date.now();
  try {
    const output = await client.completeJson({
      settings,
      apiKey,
      system,
      user: JSON.stringify(packet),
      schema: reviewSchema
    });
    return {
      phase,
      provider,
      model,
      variant,
      caseId: testCase.id,
      evidenceLevel: testCase.evidenceLevel,
      ok: true,
      wallMs: Date.now() - started,
      output,
      flags: auditFlags(output, testCase)
    };
  } catch (err) {
    return {
      phase,
      provider,
      model,
      variant,
      caseId: testCase.id,
      evidenceLevel: testCase.evidenceLevel,
      ok: false,
      wallMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      flags: []
    };
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const runGemini = args.has('--gemini');
  const outArgIdx = process.argv.indexOf('--out');
  const outPath = outArgIdx >= 0 && process.argv[outArgIdx + 1] ? process.argv[outArgIdx + 1]! : null;
  const formatsForIdx = process.argv.indexOf('--formats-for');
  const formatsForModel = formatsForIdx >= 0 && process.argv[formatsForIdx + 1] ? process.argv[formatsForIdx + 1]! : null;

  const cases = loadBenchmarkCases();
  const records: BenchmarkRunRecord[] = [];

  if (formatsForModel) {
    console.error(`\n=== Comparing Formats B & C + v1-check on ${formatsForModel} ===`);
    for (const variant of ['B', 'C'] as FormatVariantId[]) {
      for (const c of cases) {
        console.error(`[${formatsForModel}] Format ${variant} | ${c.id} ...`);
        const rec = await runOllamaNative(formatsForModel, variant, c, { think: false, timeoutMs: 95_000 });
        rec.phase = 'format-compare';
        records.push(rec);
        console.error(
          `  -> ${rec.ok ? 'OK' : 'FAIL'} wall=${rec.wallMs}ms tok/s=${rec.tokPerSec ?? '-'} flags=[${rec.flags.join(',')}] ${rec.error ?? ''}`
        );
      }
    }
    const v1Rec = await runViaDefaultClient('ollama', formatsForModel, 'http://127.0.0.1:11434/v1', null, 'A', cases[0]!, 'v1-check', 60_000);
    records.push(v1Rec);
    console.error(`[${formatsForModel}] DefaultLlmClient (/v1 reasoning_effort='none') -> ${v1Rec.ok ? 'OK' : 'FAIL'} wall=${v1Rec.wallMs}ms ${v1Rec.error ?? ''}`);
    await unloadOllamaModel(formatsForModel);
  } else if (runGemini) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
    if (!apiKey) {
      console.error('Missing GEMINI_API_KEY or GOOGLE_API_KEY env var.');
      process.exit(2);
    }
    for (const model of ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.5-flash-lite']) {
      for (const variant of ['A', 'B', 'C'] as FormatVariantId[]) {
        for (const c of cases) {
          console.error(`[gemini] ${model} | variant ${variant} | ${c.id} ...`);
          const rec = await runViaDefaultClient('gemini', model, GEMINI_DEFAULT_BASE_URL, apiKey, variant, c, 'gemini', 60_000);
          records.push(rec);
          console.error(`  -> ${rec.ok ? 'OK' : 'ERR'} ${rec.wallMs}ms flags=[${rec.flags.join(',')}] ${rec.error ?? ''}`);
        }
      }
    }
  } else {
    const ollamaModels = ['qwen3.5:4b', 'qwen2.5:7b', 'qwen3.8:27b-mlx', 'qwen3.6:35b-a3b-mxfp8'];

    for (const model of ollamaModels) {
      const isThinkingCapable = !model.startsWith('qwen2.5');
      console.error(`\n=== Benchmarking Ollama model: ${model} ===`);
      for (const c of cases) {
        console.error(`[${model}] Format A | think=false | ${c.id} ...`);
        const rec = await runOllamaNative(model, 'A', c, { think: false, timeoutMs: 95_000 });
        records.push(rec);
        console.error(
          `  -> ${rec.ok ? 'OK' : 'FAIL'} wall=${rec.wallMs}ms load=${rec.loadMs ?? '-'}ms eval=${rec.evalMs ?? '-'}ms tok/s=${rec.tokPerSec ?? '-'} flags=[${rec.flags.join(',')}] ${rec.error ?? ''}`
        );
      }

      if (isThinkingCapable) {
        console.error(`[${model}] Format A | think=true (latency comparison) | ${cases[0]!.id} ...`);
        const thinkRec = await runOllamaNative(model, 'A', cases[0]!, { think: true, timeoutMs: 95_000 });
        records.push(thinkRec);
        console.error(
          `  -> ${thinkRec.ok ? 'OK' : 'FAIL'} wall=${thinkRec.wallMs}ms eval=${thinkRec.evalMs ?? '-'}ms tok/s=${thinkRec.tokPerSec ?? '-'} ${thinkRec.error ?? ''}`
        );
      }

      await unloadOllamaModel(model);
    }

    // Format B & Format C comparison on top MoE, dense large, and baseline models
    const formatModels = ['qwen3.6:35b-a3b-mxfp8', 'qwen3.8:27b-mlx', 'qwen2.5:7b'];
    for (const model of formatModels) {
      console.error(`\n=== Comparing Formats B & C on ${model} ===`);
      for (const variant of ['B', 'C'] as FormatVariantId[]) {
        for (const c of cases) {
          console.error(`[${model}] Format ${variant} | ${c.id} ...`);
          const rec = await runOllamaNative(model, variant, c, { think: false, timeoutMs: 95_000 });
          rec.phase = 'format-compare';
          records.push(rec);
          console.error(
            `  -> ${rec.ok ? 'OK' : 'FAIL'} wall=${rec.wallMs}ms tok/s=${rec.tokPerSec ?? '-'} flags=[${rec.flags.join(',')}] ${rec.error ?? ''}`
          );
        }
      }
      await unloadOllamaModel(model);
    }

    // Verify production /v1/chat/completions path with reasoning_effort='none'
    for (const model of ['qwen3.6:35b-a3b-mxfp8', 'qwen3.5:4b', 'qwen2.5:7b']) {
      console.error(`\n=== Verifying DefaultLlmClient (/v1 reasoning_effort='none') on ${model} ===`);
      const rec = await runViaDefaultClient('ollama', model, 'http://127.0.0.1:11434/v1', null, 'A', cases[0]!, 'v1-check', 60_000);
      records.push(rec);
      console.error(`  -> ${rec.ok ? 'OK' : 'FAIL'} wall=${rec.wallMs}ms ${rec.error ?? ''}`);
      await unloadOllamaModel(model);
    }
  }

  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), cases: cases.map((c) => ({ id: c.id, label: c.label, evidenceLevel: c.evidenceLevel })), records }, null, 2);
  if (outPath) {
    writeFileSync(outPath, payload, 'utf8');
    console.error(`\nSaved benchmark output to ${outPath}`);
  } else {
    console.log(payload);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
