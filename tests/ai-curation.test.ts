import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DefaultLlmClient, extractJsonText, GEMINI_DEFAULT_BASE_URL, saveAiSettings, DEFAULT_AI_SETTINGS, type GeminiClientFactory, type LlmClient, type LlmJsonRequest } from '../server/ai/client.js';
import { curateMonthlyPlaylistAlbums, generateAiPlaylistDescription } from '../server/ai/playlist.js';
import { createApp } from '../server/app.js';
import { NeteaseClient, type CommandRunner } from '../server/netease.js';
import { Runner } from '../server/runner.js';
import { importPersonalData } from '../server/personal/imports.js';
import { albumId, decide, defaultSettings } from '../server/policy.js';
import { Store } from '../server/store.js';
import type { AiConnectionCheck, AiSettings, Album } from '../shared/types.js';

function makeAlbum(
  artist: string,
  title: string,
  genres: string[],
  opts: {
    rymScore?: number;
    aotyScore?: number;
    aotyCritic?: number;
    p4kScore?: number;
    bnm?: boolean;
    detailCaptured?: boolean;
    admittedMonth?: string;
    descriptors?: string[];
  } = {}
): Album {
  const now = new Date().toISOString();
  const releaseDate = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const sources: Album['sources'] = [
    {
      source: 'rym',
      score: opts.rymScore ?? 3.85,
      scale: 5,
      votes: 2400,
      url: `https://rateyourmusic.com/release/album/x/${albumId(artist, title)}/`,
      observedAt: now,
      status: 'ok',
      collectionMethod: 'browser-capture',
      ...(opts.detailCaptured ? { detailCaptured: true } : {}),
      ...(opts.descriptors ? { descriptors: opts.descriptors } : {})
    },
    {
      source: 'aoty',
      score: opts.aotyScore ?? 84,
      scale: 100,
      votes: 1800,
      url: `https://www.albumoftheyear.org/album/1-${albumId(artist, title)}.php`,
      observedAt: now,
      status: 'ok',
      collectionMethod: 'browser-capture',
      ...(opts.aotyCritic !== undefined ? { criticScore: opts.aotyCritic, criticVotes: 10 } : {}),
      ...(opts.detailCaptured ? { detailCaptured: true } : {})
    }
  ];
  if (opts.p4kScore !== undefined) {
    sources.push({
      source: 'pitchfork',
      score: opts.p4kScore,
      scale: 10,
      votes: null,
      bestNewMusic: Boolean(opts.bnm),
      url: `https://pitchfork.com/reviews/albums/${albumId(artist, title)}/`,
      observedAt: now,
      status: 'ok',
      collectionMethod: 'browser-capture',
      ...(opts.detailCaptured ? { detailCaptured: true, editorialSummary: 'Shimmery textures meet crisp melodies.' } : {})
    });
  }
  const album: Album = {
    id: albumId(artist, title),
    artist,
    title,
    releaseDate,
    format: 'LP',
    genres,
    ...(opts.descriptors ? { descriptors: opts.descriptors } : {}),
    ...(opts.admittedMonth ? { admittedMonth: opts.admittedMonth } : {}),
    sources,
    excluded: false
  };
  album.decision = decide(album, defaultSettings, new Date().toISOString().slice(0, 10));
  return album;
}

describe('Ollama / AI configuration, audience+critic reviews, taste curator, and extension detail backfill', () => {
  it('discovers Ollama /api/tags models, strips <think> blocks, and masks API keys in /api/ai', async () => {
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s === 'http://192.0.2.10:11434/api/tags') {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen2.5:14b' }, { name: 'deepseek-r1:8b' }] }),
          { status: 200 }
        );
      }
      if (s === 'http://192.0.2.10:11434/v1/chat/completions') {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '<think>Internal reasoning here</think>\n```json\n{"shortReview":"冷峻合成器与梦幻吉他交织。","longReview":"第一段：声景质感细腻。\\n\\n第二段：媒体与大众高度一致。\\n\\n第三段：建议夜间整张听。"}\n```'
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${s}`);
    });

    const llm = new DefaultLlmClient(mockFetch as unknown as typeof fetch);
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-settings-'));
    const app = await createApp({ dataDir: dir, scheduler: false, ai: llm });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'ai-settings-password' } });
      const cookie = setup.headers['set-cookie'] as string;

      // Root Ollama URL normalizes cleanly to /v1 and never echoes API key
      const saveRes = await app.inject({
        method: 'PUT',
        url: '/api/ai',
        headers: { cookie },
        payload: {
          enabled: true,
          provider: 'ollama',
          baseUrl: 'http://192.0.2.10:11434',
          model: 'qwen2.5:14b',
          apiKey: 'secret-token-should-not-echo',
          autoReviewSelected: false,
          timeoutMs: 30000
        }
      });
      expect(saveRes.statusCode).toBe(200);
      expect(saveRes.json().settings).toMatchObject({
        enabled: true,
        provider: 'ollama',
        baseUrl: 'http://192.0.2.10:11434/v1',
        model: 'qwen2.5:14b',
        hasApiKey: true
      });
      expect(JSON.stringify(saveRes.json())).not.toContain('secret-token-should-not-echo');

      const checkRes = await app.inject({
        method: 'POST',
        url: '/api/ai/check',
        headers: { cookie },
        payload: { provider: 'ollama', baseUrl: 'http://192.0.2.10:11434', model: 'qwen2.5:14b' }
      });
      expect(checkRes.statusCode).toBe(200);
      expect(checkRes.json()).toMatchObject({
        ok: true,
        models: ['qwen2.5:14b', 'deepseek-r1:8b']
      });

      expect(extractJsonText('<think>x</think>{"a":1}')).toBe('{"a":1}');

      // Clear API key
      const clearRes = await app.inject({
        method: 'PUT',
        url: '/api/ai',
        headers: { cookie },
        payload: {
          enabled: true,
          provider: 'ollama',
          baseUrl: 'http://192.0.2.10:11434/v1',
          model: 'qwen2.5:14b',
          clearApiKey: true
        }
      });
      expect(clearRes.json().settings.hasApiKey).toBe(false);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches AI short/long reviews by evidenceHash, distinguishes scores_only vs full, and regenerates when detail snippets arrive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-reviews-'));
    const alb = makeAlbum('Soft Halo', 'Glass Garden', ['Dream Pop'], {
      aotyCritic: 89,
      p4kScore: 8.4,
      bnm: true,
      detailCaptured: false
    });
    const seed = new Store(dir);
    seed.saveAlbums([alb]);
    seed.close();

    let callCount = 0;
    let lastSystemPrompt = '';
    const mockAi: LlmClient = {
      async checkConnection(): Promise<AiConnectionCheck> {
        return { ok: true, message: 'ok', models: ['qwen3.6:35b-a3b-mxfp8'], checkedAt: new Date().toISOString() };
      },
      async completeJson<T>(req: LlmJsonRequest<T>): Promise<T> {
        callCount++;
        lastSystemPrompt = req.system;
        const payload = JSON.parse(req.user) as { evidenceLevel: string };
        return req.schema.parse({
          shortReview: payload.evidenceLevel === 'full' ? '雾面吉他墙包裹下的冷调合成器叙事，张力内敛。' : '极简器乐与冷峻人声搭建出的梦幻流行声景。',
          longReview:
            payload.evidenceLevel === 'full'
              ? '【声音质地】混响吉他与合成器形成绵密雾面。\n\n【风格坐标】延续自赏与梦幻流派细腻声场。\n\n【口碑拆解】媒体与乐迷一致推崇其音色统一性。\n\n【适听与劝退】适合偏好缓慢沉浸质感，节奏密度偏轻。'
              : '【声音质地】以清澈器乐与朦胧混响构筑空间感。\n\n【风格坐标】锚定梦幻流行核心语法。\n\n【口碑拆解】大众高票与媒体定调共振度极高。\n\n【适听与劝退】追求强鼓点驱动者可能会觉得整体偏缓。',
          audienceSummary: 'RYM 与 AOTY 听众普遍认可其声景完成度。',
          criticSummary: '媒体高度推崇其声音统一性与制作细腻度。'
        });
      }
    };

    const app = await createApp({ dataDir: dir, scheduler: false, ai: mockAi });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'ai-review-password' } });
      const cookie = setup.headers['set-cookie'] as string;

      await app.inject({
        method: 'PUT',
        url: '/api/ai',
        headers: { cookie },
        payload: {
          enabled: true,
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'qwen2.5:7b',
          autoReviewSelected: false
        }
      });

      // 1. First generation (scores_only) using Format A dossier prompt & calibrated thresholds
      const first = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(first.statusCode).toBe(200);
      expect(first.json().review.evidenceLevel).toBe('scores_only');
      expect(callCount).toBe(1);
      expect(lastSystemPrompt).toContain('【声音质地】');
      expect(lastSystemPrompt).toContain('【适听与劝退】');
      expect(lastSystemPrompt).toContain('RYM >= 3.70');
      expect(lastSystemPrompt).not.toContain('自动抓取媒体与大众评论原文并丰富本篇长评');

      // 2. Second request with unchanged evidence -> hits SQLite cache
      const cached = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(cached.statusCode).toBe(200);
      expect(callCount).toBe(1);

      // 3. New detail page evidence arrives via extension capture -> hash changes -> regenerates as 'full'
      const token = (await app.inject({ method: 'POST', url: '/api/extension/token', headers: { cookie } })).json().token as string;
      const aotyDetailHtml = `
        <div class="artist">Soft Halo</div>
        <div class="albumTitle">Glass Garden</div>
        <div class="albumCriticScoreBox"><div class="albumCriticScore">89</div><div class="text numReviews">Based on <strong>12</strong> reviews</div></div>
        <div class="albumUserScore">84</div><div class="userScoreBox">Based on 1,800 ratings</div>
        <div class="detailRow">${alb.releaseDate} / release date</div><div class="detailRow">LP / format</div>
        <div id="critic-reviews"><div class="albumReviewRow"><div class="albumReviewPublication">The Quietus</div><div class="albumReviewRating">90</div><div class="albumReviewText">Luminous shoegaze textures.</div></div></div>
      `;
      const capRes = await app.inject({
        method: 'POST',
        url: '/api/ext/capture',
        headers: { authorization: `Bearer ${token}` },
        payload: { url: alb.sources[1]!.url, html: aotyDetailHtml }
      });
      expect(capRes.statusCode).toBe(200);

      const refreshed = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().review.evidenceLevel).toBe('full');
      expect(callCount).toBe(2);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses AI TastePersona + Curator Agent to avoid stuffing incompatible genres, filters hallucinated IDs, and falls back gracefully on errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-curator-'));
    const dreamPopAlb = makeAlbum('Lush Echo', 'Velvet Morning', ['Dream Pop', 'Shoegaze']);
    const exploreAlb = makeAlbum('Ambient Drift', 'Polar Light', ['Ambient', 'Electronic']);
    const noiseMetalAlb = makeAlbum('Iron Brutality', 'Mangle', ['Sludge Metal', 'Noise Rock']);

    const seed = new Store(dir);
    seed.saveAlbums([dreamPopAlb, exploreAlb, noiseMetalAlb]);
    // Import Spotify favorites WITHOUT genre columns (simulating real TuneMyMusic CSV!)
    importPersonalData(seed, {
      source: 'spotify',
      fileName: 'My_Spotify.csv',
      content: 'Track name,Artist name,Album,Playlist name,Type\n"Sugar Hiccup","Cocteau Twins","Head over Heels","Favorite Songs","Favorite"\n"Alison","Slowdive","Souvlaki","Favorite Songs","Favorite"'
    });
    seed.close();

    let shouldFail = false;
    const mockAi: LlmClient = {
      async checkConnection(): Promise<AiConnectionCheck> {
        return { ok: true, message: 'ok', models: ['qwen2.5:7b'], checkedAt: new Date().toISOString() };
      },
      async completeJson<T>(req: LlmJsonRequest<T>): Promise<T> {
        if (shouldFail) throw new Error('Ollama timeout');
        if (req.system.includes('私人音乐品味顾问')) {
          return req.schema.parse({
            summary: '长期偏爱以 Cocteau Twins、Slowdive 为代表的梦幻流行与自赏摇滚，重视空灵人声与混响氛围。',
            sonicSignatures: ['空灵混响吉他', '柔和梦幻人声', '氛围层叠'],
            preferredGenres: ['Dream Pop', 'Shoegaze', 'Ambient'],
            avoidances: ['Sludge Metal', '极端噪音金属'],
            explorationAngles: ['Atmosphere / Ambient Electronic']
          });
        }
        return req.schema.parse({
          items: [
            {
              albumId: dreamPopAlb.id,
              slotType: 'preference',
              matchIndex: 92,
              confidence: 'high',
              reasons: ['契合你常听的 Cocteau Twins 与 Slowdive 的梦幻吉他质感']
            },
            {
              albumId: noiseMetalAlb.id,
              slotType: 'hold',
              matchIndex: 12,
              confidence: 'high',
              reasons: ['极端污泥金属与你的梦幻氛围听感相悖，不硬塞推荐']
            },
            {
              albumId: exploreAlb.id,
              slotType: 'exploration',
              matchIndex: 74,
              confidence: 'medium',
              reasons: ['在氛围电子方向为你延伸相近的空灵空间感']
            },
            {
              albumId: 'hallucinated-nonexistent-id',
              slotType: 'preference',
              matchIndex: 99,
              confidence: 'high',
              reasons: ['should be filtered out']
            }
          ]
        });
      }
    };

    const app = await createApp({ dataDir: dir, scheduler: false, ai: mockAi });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'curator-test-password' } });
      const cookie = setup.headers['set-cookie'] as string;

      await app.inject({
        method: 'PUT',
        url: '/api/ai',
        headers: { cookie },
        payload: {
          enabled: true,
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'qwen2.5:7b',
          autoReviewSelected: false
        }
      });

      const genRes = await app.inject({
        method: 'POST',
        url: '/api/recommendations/generate',
        headers: { cookie },
        payload: { preferenceSlots: 7, explorationSlots: 3 }
      });
      expect(genRes.statusCode).toBe(200);
      const recSet = genRes.json();
      expect(recSet.engine).toBe('ai');
      expect(recSet.persona.preferredGenres).toContain('Dream Pop');
      // Only Dream Pop (preference) + Ambient (exploration); Sludge Metal held back; hallucinated ID dropped
      expect(recSet.items.map((i: { album: { id: string } }) => i.album.id)).toEqual([dreamPopAlb.id, exploreAlb.id]);
      expect(recSet.items[0].slotType).toBe('preference');
      expect(recSet.items[1].slotType).toBe('exploration');

      const overview = (await app.inject({ url: '/api/personal/overview', headers: { cookie } })).json();
      expect(overview.aiEnabled).toBe(true);
      expect(overview.persona.summary).toContain('Cocteau Twins');

      // Simulate Ollama failure -> falls back cleanly to heuristic engine with explicit note
      shouldFail = true;
      const fallbackRes = await app.inject({
        method: 'POST',
        url: '/api/recommendations/generate',
        headers: { cookie },
        payload: {}
      });
      expect(fallbackRes.statusCode).toBe(200);
      expect(fallbackRes.json().engine).toBe('heuristic');
      expect(fallbackRes.json().notes[0]).toContain('AI 策展模型暂不可用');
      expect(fallbackRes.json().items.length).toBe(3);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prioritizes selected non-admitted detail URLs in /api/ext/config only when detailBackfill is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ext-backfill-'));
    const unadmittedSelected = makeAlbum('Act One', 'Priority LP', ['Rock'], { detailCaptured: false });
    const admittedSelected = makeAlbum('Act Two', 'Already In Playlist', ['Rock'], { detailCaptured: false, admittedMonth: '2026-11' });
    const alreadyDetailed = makeAlbum('Act Three', 'Detailed LP', ['Rock'], { detailCaptured: true });
    unadmittedSelected.sources.push({
      source: 'pitchfork',
      score: null,
      scale: 10,
      votes: null,
      url: 'https://pitchfork.com/search/?q=Act+One',
      observedAt: new Date().toISOString(),
      status: 'missing'
    });

    const seed = new Store(dir);
    seed.saveAlbums([admittedSelected, unadmittedSelected, alreadyDetailed]);
    seed.close();

    const app = await createApp({ dataDir: dir, scheduler: false });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'backfill-test-password' } });
      const cookie = setup.headers['set-cookie'] as string;
      const token = (await app.inject({ method: 'POST', url: '/api/extension/token', headers: { cookie } })).json().token as string;

      // Default: detailBackfill enabled out of the box
      const cfgDefault = (await app.inject({ url: '/api/ext/config', headers: { authorization: `Bearer ${token}` } })).json();
      expect(cfgDefault.detailBackfill).toMatchObject({
        enabled: true,
        batchSize: 4,
        pendingCount: 4
      });

      // Disable detailBackfill -> omits detailBackfill field cleanly
      await app.inject({
        method: 'PUT',
        url: '/api/extension/refresh',
        headers: { cookie },
        payload: {
          enabled: true,
          hour: 10,
          targets: ['https://rateyourmusic.com/charts/top/album/{year}/1/'],
          detailBackfill: false
        }
      });
      const cfgOff = (await app.inject({ url: '/api/ext/config', headers: { authorization: `Bearer ${token}` } })).json();
      expect(cfgOff.detailBackfill).toBeUndefined();

      // Enable detailBackfill with batchSize = 2
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/extension/refresh',
        headers: { cookie },
        payload: {
          enabled: true,
          hour: 10,
          targets: ['https://rateyourmusic.com/charts/top/album/{year}/1/'],
          detailBackfill: true,
          detailBatchSize: 2
        }
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().pendingDetailCount).toBe(4); // 2 canonical URLs on unadmitted + 2 on admitted (excludes search URL & alreadyDetailed)

      const cfgOn = (await app.inject({ url: '/api/ext/config', headers: { authorization: `Bearer ${token}` } })).json();
      expect(cfgOn.detailBackfill).toMatchObject({
        enabled: true,
        batchSize: 2,
        pendingCount: 4
      });
      // First 2 targets come from the unadmitted selected album and exclude the non-canonical Pitchfork search URL
      expect(cfgOn.detailBackfill.targets).toEqual([
        unadmittedSelected.sources[0]!.url,
        unadmittedSelected.sources[1]!.url
      ]);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports native Gemini Interactions API provider config, discovery, structured JSON, 400 fallback, and key redaction', async () => {
    const createCalls: Record<string, unknown>[] = [];
    let forceBadSchemaOnce = true;

    const fakeGeminiFactory: GeminiClientFactory = () => ({
      models: {
        list: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { name: 'models/gemini-2.5-flash' };
            yield { name: 'models/text-embedding-004' };
            yield { name: 'models/gemini-4-argon' };
            yield { name: 'models/gemini-4-hydrogen' };
            yield { name: 'models/gemini-3.5-flash-lite' };
          }
        })
      },
      interactions: {
        create: async (params) => {
          createCalls.push(params as unknown as Record<string, unknown>);
          if (forceBadSchemaOnce) {
            forceBadSchemaOnce = false;
            throw new Error('400 INVALID_ARGUMENT: thinking_level not supported on AIzaSecretKey12345');
          }
          return {
            output_text: JSON.stringify({
              shortReview: '硬朗极简鼓组切分下藏着冷峻都市叙事。',
              longReview: '第一段：主创把极简碎拍和低频贝斯压得很紧，人声偏冷、字句密度极高。\n\n第二段：大众与乐评人几乎一致给出高评价。\n\n第三段：适合先听前两首进入律动再整张推进。'
            })
          };
        }
      }
    });

    const llm = new DefaultLlmClient(fetch, fakeGeminiFactory);
    const dir = mkdtempSync(join(tmpdir(), 'relay-gemini-provider-'));
    const app = await createApp({ dataDir: dir, scheduler: false, ai: llm });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'gemini-provider-password' } });
      const cookie = setup.headers['set-cookie'] as string;

      // Missing API key fails connection check clearly
      const missingKeyCheck = await app.inject({
        method: 'POST',
        url: '/api/ai/check',
        headers: { cookie },
        payload: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-4-hydrogen' }
      });
      expect(missingKeyCheck.statusCode).toBe(200);
      expect(missingKeyCheck.json()).toMatchObject({ ok: false, message: '请先填写 Gemini API Key' });

      // Save Gemini config with trailing /v1 -> normalized cleanly without exposing secret
      const saveRes = await app.inject({
        method: 'PUT',
        url: '/api/ai',
        headers: { cookie },
        payload: {
          enabled: true,
          provider: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1',
          model: 'gemini-4-hydrogen',
          apiKey: 'AIzaSecretKey12345',
          autoReviewSelected: false,
          timeoutMs: 45000
        }
      });
      expect(saveRes.statusCode).toBe(200);
      expect(saveRes.json().settings).toMatchObject({
        enabled: true,
        provider: 'gemini',
        baseUrl: GEMINI_DEFAULT_BASE_URL,
        model: 'gemini-4-hydrogen',
        hasApiKey: true
      });
      expect(JSON.stringify(saveRes.json())).not.toContain('AIzaSecretKey12345');

      // Saved API key powers connection check and filters out embedding + legacy models while prioritizing Gemini 4
      const checkRes = await app.inject({
        method: 'POST',
        url: '/api/ai/check',
        headers: { cookie },
        payload: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-4-hydrogen' }
      });
      expect(checkRes.statusCode).toBe(200);
      expect(checkRes.json().ok).toBe(true);
      expect(checkRes.json().models).toEqual(['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.5-flash-lite']);

      // completeJson uses store: false + stripped JSON schema, and retries cleanly on 400
      const schema = z.object({
        shortReview: z.string().min(10),
        longReview: z.string().min(40)
      });
      const out = await llm.completeJson({
        settings: saveRes.json().settings,
        apiKey: 'AIzaSecretKey12345',
        system: 'You are a concise music critic.',
        user: '{"artist":"Test"}',
        schema
      });
      expect(out.shortReview).toContain('极简鼓组');
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]).toMatchObject({
        model: 'gemini-4-hydrogen',
        store: false,
        system_instruction: 'You are a concise music critic.',
        generation_config: { thinking_level: 'low' }
      });
      const rf0 = createCalls[0]!.response_format as { schema?: Record<string, unknown> };
      expect(rf0.schema).toBeDefined();
      expect(rf0.schema!.$schema).toBeUndefined();
      expect(rf0.schema!.additionalProperties).toBeUndefined();
      expect(createCalls[1]!.generation_config).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends reasoning_effort=none for Ollama and falls back on 400 when unsupported', async () => {
    const payloads: Record<string, unknown>[] = [];
    const mockFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      payloads.push(body);
      if (payloads.length === 1) {
        return new Response('unknown field reasoning_effort', { status: 400 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        { status: 200 }
      );
    });
    const llm = new DefaultLlmClient(mockFetch as unknown as typeof fetch);
    const out = await llm.completeJson({
      settings: {
        enabled: true,
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3.5:4b',
        autoReviewSelected: false,
        timeoutMs: 20_000
      },
      apiKey: null,
      system: 'sys',
      user: 'usr',
      schema: z.object({ ok: z.boolean() })
    });
    expect(out.ok).toBe(true);
    expect(payloads[0]!.reasoning_effort).toBe('none');
    expect(payloads[1]!.reasoning_effort).toBeUndefined();
  });

  it('uses active AI engine for monthly playlist curation, coherent playlist description, /api/playlists/preview-ai, and Runner auto_sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-monthly-ai-'));
    const keepAlb = makeAlbum('Dreamy Act', 'Velvet Horizon', ['Dream Pop', 'Shoegaze'], { rymScore: 3.9, aotyScore: 86 });
    const clashAlb = makeAlbum('Harsh Wreck', 'Static Scream', ['Sludge Metal', 'Noise Rock'], { rymScore: 3.85, aotyScore: 85 });

    const seed = new Store(dir);
    seed.saveAlbums([keepAlb, clashAlb]);
    saveAiSettings(seed, { ...DEFAULT_AI_SETTINGS, enabled: true, provider: 'gemini', baseUrl: GEMINI_DEFAULT_BASE_URL, model: 'gemini-4-hydrogen', apiKey: 'AIzaTest' });
    seed.close();

    const aiMock: LlmClient = {
      async checkConnection() {
        return { ok: true, message: 'ok', models: ['gemini-4-hydrogen'], checkedAt: new Date().toISOString() };
      },
      async completeJson<T>(req: LlmJsonRequest<T>): Promise<T> {
        if (req.system.includes('最终入单把关')) {
          return req.schema.parse({
            items: [
              { albumId: keepAlb.id, decision: 'admit', reason: '双站高口碑且兼具梦幻流行柔光质感，适合日常连贯聆听' },
              { albumId: clashAlb.id, decision: 'hold', reason: '重型噪音金属噪度较高，暂缓混入本期温和精选月单' }
            ]
          });
        }
        return req.schema.parse({
          description: '十一月的新声流向在柔和混响与精密节拍之间铺开，Dreamy Act 用朦胧的吉他层叠为整期奠定克制而透明的听觉主线。'
        });
      }
    };

    const app = await createApp({ dataDir: dir, scheduler: false, ai: aiMock });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'monthly-ai-password' } });
      const cookie = setup.headers['set-cookie'] as string;

      // HTTP /api/playlists/preview-ai persists draft with coherent prose + AI admit/hold decisions
      const draftRes = await app.inject({ method: 'POST', url: '/api/playlists/preview-ai', headers: { cookie }, payload: {} });
      expect(draftRes.statusCode).toBe(200);
      const { draft } = draftRes.json();
      expect(draft.engine).toBe('ai');
      expect(draft.provider).toBe('gemini');
      expect(draft.model).toBe('gemini-4-hydrogen');
      expect(draft.admitted.map((x: { albumId: string }) => x.albumId)).toEqual([keepAlb.id]);
      expect(draft.held.map((x: { albumId: string }) => x.albumId)).toEqual([clashAlb.id]);
      expect(draft.description).toContain('柔和混响');
      expect(draft.description).not.toContain('入选理由：');

      const getDraft = await app.inject({ url: '/api/playlists/draft', headers: { cookie } });
      expect(getDraft.statusCode).toBe(200);
      expect(getDraft.json().draft.description).toBe(draft.description);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // Runner auto_sync uses AI curation + AI coherent description cleanly
    const runDir = mkdtempSync(join(tmpdir(), 'relay-runner-monthly-ai-'));
    const store = new Store(runDir);
    store.saveAlbums([keepAlb, clashAlb]);
    saveAiSettings(store, { ...DEFAULT_AI_SETTINGS, enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3.6:35b-a3b-mxfp8' });
    let described = '';
    const cmd: CommandRunner = async (args) => {
      if (args[0] === 'search' && args[1] === 'album') {
        const kw = args[args.indexOf('--keyword') + 1] ?? '';
        if (kw.includes('Dreamy Act')) {
          return {
            code: 200,
            data: {
              records: [{
                id: 'ncm-keep', originalId: 101, name: keepAlb.title,
                artists: [{ name: keepAlb.artist }],
                publishTime: Date.parse(`${keepAlb.releaseDate}T00:00:00+08:00`)
              }]
            }
          };
        }
        return { code: 200, data: { records: [] } };
      }
      if (args[0] === 'album' && args[1] === 'tracks') return { code: 200, data: [{ id: 'tr-1', originalId: 11, name: 'Track 1' }] };
      if (args[0] === 'playlist' && args[1] === 'create') return { code: 200, data: { id: 'pl-1', originalId: 500 } };
      if (args[0] === 'playlist' && args[1] === 'tracks') return { code: 200, data: [{ id: 'tr-1', originalId: 11, name: 'Track 1' }] };
      if (args[0] === 'playlist' && args[1] === 'updateDesc') {
        described = args[args.indexOf('--desc') + 1] ?? '';
        return { code: 200, data: {} };
      }
      if (args[0] === 'playlist' && args[1] === 'get') {
        return { code: 200, data: { name: '高分新专辑', describe: described, trackCount: 1 } };
      }
      return { code: 200, data: {} };
    };
    const netease = new NeteaseClient(runDir, { command: cmd });
    const runner = new Runner(store, { refresh: vi.fn() }, netease, aiMock);
    try {
      const curation = await curateMonthlyPlaylistAlbums(store, [keepAlb, clashAlb], aiMock, { month: '2026-11' });
      expect(curation.admittedAlbums.map((a) => a.id)).toEqual([keepAlb.id]);
      const intro = await generateAiPlaylistDescription(store, '2026-11', '高分新专辑｜2026-11', [keepAlb], 1000, aiMock);
      expect(intro).toContain('柔和混响');

      runner.start('auto_sync');
      await runner.wait();
      const pls = store.playlists();
      expect(pls).toHaveLength(1);
      expect(pls[0]!.albumIds).toEqual([keepAlb.id]); // held clashAlb is NOT admitted
      expect(pls[0]!.description).toContain('柔和混响');
      expect(described).toContain('柔和混响');
    } finally {
      await netease.close();
      store.close();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
