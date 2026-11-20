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
import { hasAlbumReviewEvidence, normalizeLongReview, parseLongReviewBlocks } from '../shared/review-evidence.js';
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
  it('reuses a saved key only for the same provider and normalized endpoint', async () => {
    const checkConnection = vi.fn<LlmClient['checkConnection']>(async () => ({
      ok: true, message: 'Fixture', models: [], checkedAt: new Date().toISOString()
    }));
    const ai: LlmClient = { checkConnection, completeJson: async () => { throw new Error('Unexpected generation'); } };
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-key-scope-'));
    const app = await createApp({ dataDir: dir, scheduler: false, ai });
    const gemini = { ...DEFAULT_AI_SETTINGS, provider: 'gemini', baseUrl: GEMINI_DEFAULT_BASE_URL };
    const fixtureKey = 'synthetic-fixture-key';
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'fixture-admin-password' } });
      const headers = { cookie: setup.headers['set-cookie'] as string };
      const save = (payload: object) => app.inject({ method: 'PUT', url: '/api/ai', headers, payload });
      const probe = async (payload: object, expectedKey: string | null) => {
        const response = await app.inject({ method: 'POST', url: '/api/ai/check', headers, payload });
        expect(response.statusCode).toBe(200);
        expect(checkConnection).toHaveBeenLastCalledWith(expect.any(Object), expectedKey);
      };

      expect((await save({ ...gemini, apiKey: fixtureKey })).json().settings.hasApiKey).toBe(true);
      expect((await save({ ...gemini, model: 'another-model', baseUrl: `${gemini.baseUrl}/v1beta` })).json().settings.hasApiKey).toBe(true);
      await probe({ baseUrl: `${gemini.baseUrl}/v1beta/` }, fixtureKey);
      await probe({ baseUrl: 'https://alternate.example' }, null);
      await probe({ provider: 'openai_compatible' }, null);
      await probe({ clearApiKey: true }, null);
      await probe({ baseUrl: 'https://alternate.example', apiKey: 'replacement-fixture-key' }, 'replacement-fixture-key');
      expect((await save({ ...gemini, baseUrl: 'https://alternate.example' })).json().settings.hasApiKey).toBe(false);
      await probe({}, null);
      expect((await save({ ...gemini, apiKey: fixtureKey })).json().settings.hasApiKey).toBe(true);
      expect((await save({ ...gemini, provider: 'openai_compatible' })).json().settings.hasApiKey).toBe(false);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('refuses scores-only fabrication, purges legacy scores_only rows on startup, and caches full evidence-backed reviews', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-reviews-'));
    const alb = makeAlbum('Soft Halo', 'Glass Garden', ['Dream Pop'], {
      aotyCritic: 89,
      p4kScore: 8.4,
      bnm: true,
      detailCaptured: false
    });
    const seed = new Store(dir);
    seed.saveAlbums([alb]);
    seed.database
      .prepare(
        `INSERT INTO album_reviews_ai(
          album_id, evidence_hash, evidence_level, short_review, long_review,
          audience_summary, critic_summary, model, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alb.id,
        'legacy-hash',
        'scores_only',
        '旧版凭评分猜写的短评',
        '旧版凭评分猜写的长评内容，用于验证启动时清理机制。',
        null,
        null,
        'qwen2.5:7b',
        new Date().toISOString()
      );
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
        return req.schema.parse({
          shortReview: '雾面吉他墙包裹下的冷调合成器叙事，张力内敛。',
          longReview:
            '【声音质地】混响吉他与合成器形成绵密雾面。\n\n【口碑拆解】媒体与乐迷一致推崇其音色统一性。',
          audienceSummary: 'RYM 与 AOTY 听众普遍认可其声景完成度。',
          criticSummary: '媒体高度推崇其声音统一性与制作细腻度。'
        });
      }
    };

    const app = await createApp({ dataDir: dir, scheduler: false, ai: mockAi });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'ai-review-password' } });
      const cookie = setup.headers['set-cookie'] as string;

      // Legacy scores_only review was purged on startup
      const albumsBefore = await app.inject({ url: '/api/albums', headers: { cookie } });
      expect(albumsBefore.statusCode).toBe(200);
      expect(albumsBefore.json()[0].aiReview).toBeNull();

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

      // 1. Without original-page evidence, single & batch generation strictly refuse to fabricate
      const blocked = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error).toContain('暂无原页乐评素材');
      expect(callCount).toBe(0);

      const batchBlocked = await app.inject({ method: 'POST', url: '/api/ai/reviews/generate-selected', headers: { cookie }, payload: {} });
      expect(batchBlocked.statusCode).toBe(200);
      expect(batchBlocked.json()).toEqual({ queuedCount: 0, totalSelected: 1, eligibleCount: 0, skippedNoEvidenceCount: 1 });
      expect(callCount).toBe(0);

      // 2. Detail page evidence arrives via extension capture -> allowed & strictly evidence-grounded
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

      const generated = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(generated.statusCode).toBe(200);
      expect(generated.json().review.evidenceLevel).toBe('full');
      expect(callCount).toBe(1);
      expect(lastSystemPrompt).toContain('绝对禁止脑补与调用外部印象');
      expect(lastSystemPrompt).toContain('直接省略该小节');
      expect(lastSystemPrompt).not.toContain('结合你对艺人及所列流派的真实音乐美学认知');

      // 3. Repeated request with unchanged evidence hits SQLite cache
      const cached = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(cached.statusCode).toBe(200);
      expect(callCount).toBe(1);

      // 4. Additional detail evidence from another source invalidates hash and regenerates cleanly
      const pitchforkDetailHtml = `
        <html><head><meta name="description" content="Sharp nocturnal synthesizers frame every hook." /></head>
        <body><article><p>Across nine focused tracks, Soft Halo trades haze for crystalline pulse and stark vocal poise.</p></article></body></html>
      `;
      const seed2 = new Store(dir);
      const latestAlb = seed2.albums()[0]!;
      const p4kObs = latestAlb.sources.find((s) => s.source === 'pitchfork')!;
      p4kObs.editorialSummary = 'Sharp nocturnal synthesizers frame every hook.';
      p4kObs.detailCaptured = true;
      seed2.saveAlbums([latestAlb]);
      seed2.close();
      void pitchforkDetailHtml;

      const regenerated = await app.inject({ method: 'POST', url: `/api/albums/${alb.id}/review`, headers: { cookie }, payload: {} });
      expect(regenerated.statusCode).toBe(200);
      expect(regenerated.json().review.evidenceLevel).toBe('full');
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

  it('prioritizes zero-evidence selected albums breadth-first (P4K -> AOTY -> RYM) in /api/ext/config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ext-backfill-'));
    const unadmittedSelected = makeAlbum('Act One', 'Priority LP', ['Rock'], { detailCaptured: false });
    const admittedSelected = makeAlbum('Act Two', 'Already In Playlist', ['Rock'], { detailCaptured: false, admittedMonth: '2026-11' });
    const alreadyDetailed = makeAlbum('Act Three', 'Detailed LP', ['Rock'], { detailCaptured: true });
    const hasP4kSnippetFromChart = makeAlbum('Act Four', 'Has Summary LP', ['Rock'], { p4kScore: 8.2, detailCaptured: false });
    hasP4kSnippetFromChart.sources[2]!.editorialSummary = 'Chart dek already captured.';
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
    seed.saveAlbums([admittedSelected, unadmittedSelected, alreadyDetailed, hasP4kSnippetFromChart]);
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
        pendingCount: 7
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

      // Enable detailBackfill with batchSize = 2: picks 1 primary AOTY URL per zero-evidence album (covering BOTH albums)
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
      expect(putRes.json().pendingDetailCount).toBe(7);

      const cfgBatch2 = (await app.inject({ url: '/api/ext/config', headers: { authorization: `Bearer ${token}` } })).json();
      expect(cfgBatch2.detailBackfill).toMatchObject({
        enabled: true,
        batchSize: 2,
        pendingCount: 7
      });
      expect(cfgBatch2.detailBackfill.targets).toEqual([
        unadmittedSelected.sources[1]!.url, // Act One AOTY (excludes search URL, prefers AOTY over RYM)
        admittedSelected.sources[1]!.url    // Act Two AOTY (covers 2nd zero-evidence album before 1st album's RYM)
      ]);

      // Canonical Pitchfork URL takes priority over AOTY/RYM when present, and Pass 2 fills remaining capacity
      unadmittedSelected.sources[2]!.url = 'https://pitchfork.com/reviews/albums/act-one-priority-lp/';
      unadmittedSelected.sources[2]!.status = 'ok';
      const seed2 = new Store(dir);
      seed2.saveAlbums([admittedSelected, unadmittedSelected, alreadyDetailed, hasP4kSnippetFromChart]);
      seed2.close();

      await app.inject({
        method: 'PUT',
        url: '/api/extension/refresh',
        headers: { cookie },
        payload: {
          enabled: true,
          hour: 10,
          targets: ['https://rateyourmusic.com/charts/top/album/{year}/1/'],
          detailBackfill: true,
          detailBatchSize: 4
        }
      });
      const cfgBatch4 = (await app.inject({ url: '/api/ext/config', headers: { authorization: `Bearer ${token}` } })).json();
      expect(cfgBatch4.detailBackfill.targets).toEqual([
        unadmittedSelected.sources[2]!.url, // Pass 1: Act One Pitchfork first
        admittedSelected.sources[1]!.url,   // Pass 1: Act Two AOTY second (zero-evidence coverage before Act Four)
        unadmittedSelected.sources[1]!.url, // Pass 2: secondary sources (Act One AOTY)
        unadmittedSelected.sources[0]!.url  // Pass 2: secondary sources (Act One RYM)
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
            yield { name: 'models/gemini-3.8-flash' };
            yield { name: 'models/gemini-4-hydrogen' };
            yield { name: 'models/gemini-3.5-flash-lite' };
          }
        })
      },
      interactions: {
        create: async (params) => {
          createCalls.push(params as unknown as Record<string, unknown>);
          if (!params.response_format) {
            return { status: 'completed', output_text: 'OK' };
          }
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

      // Saved API key powers connection check (list + lightweight probe) and ranks recommended models first
      const checkRes = await app.inject({
        method: 'POST',
        url: '/api/ai/check',
        headers: { cookie },
        payload: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-4-hydrogen' }
      });
      expect(checkRes.statusCode).toBe(200);
      expect(checkRes.json().ok).toBe(true);
      expect(checkRes.json().models).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']);

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
      const generationCalls = createCalls.filter((c) => c.response_format);
      expect(generationCalls).toHaveLength(2);
      expect(generationCalls[0]).toMatchObject({
        model: 'gemini-4-hydrogen',
        store: false,
        system_instruction: 'You are a concise music critic.',
        generation_config: { thinking_level: 'low' }
      });
      const rf0 = generationCalls[0]!.response_format as { schema?: Record<string, unknown> };
      expect(rf0.schema).toBeDefined();
      expect(rf0.schema!.$schema).toBeUndefined();
      expect(rf0.schema!.additionalProperties).toBeUndefined();
      expect(generationCalls[1]!.generation_config).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 'incomplete', output_text: 'partial output' },
    { status: 'completed', output_text: '' }
  ])('rejects unsuccessful or empty Gemini probes ($status)', async (interaction) => {
    const llm = new DefaultLlmClient(fetch, () => ({
      models: { list: async () => ({ async *[Symbol.asyncIterator]() {
        yield { name: 'models/gemini-fixture' };
      } }) },
      interactions: { create: async () => interaction }
    }));
    const result = await llm.checkConnection({
      ...DEFAULT_AI_SETTINGS, provider: 'gemini', baseUrl: GEMINI_DEFAULT_BASE_URL,
      model: 'gemini-fixture', hasApiKey: true
    }, 'synthetic-fixture-key');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual(['gemini-fixture']);
  });

  it('surfaces clear Chinese HTTP 402 billing/model diagnostics without httpMeta noise and preserves discovered models during check', async () => {
    const fake402Factory: GeminiClientFactory = () => ({
      models: {
        list: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { name: 'models/gemini-4-hydrogen' };
            yield { name: 'models/gemini-3.8-flash' };
          }
        })
      },
      interactions: {
        create: async () => {
          const err = new Error('402 API error occurred: {"httpMeta":{"response":{},"request":{}}}') as Error & {
            statusCode: number;
            body: string;
          };
          err.statusCode = 402;
          err.body = JSON.stringify({ error: { message: 'Prepay credit balance depleted for AIzaSecretKey999' } });
          throw err;
        }
      }
    });

    const llm = new DefaultLlmClient(fetch, fake402Factory);
    const settings: AiSettings = {
      enabled: true,
      provider: 'gemini',
      baseUrl: GEMINI_DEFAULT_BASE_URL,
      model: 'gemini-4-hydrogen',
      autoReviewSelected: false,
      timeoutMs: 45_000
    };

    const check = await llm.checkConnection(settings, 'AIzaSecretKey999');
    expect(check.ok).toBe(false);
    expect(check.message).toContain('HTTP 402');
    expect(check.message).toContain('Prepay');
    expect(check.message).toContain('gemini-3.8-flash');
    expect(check.message).not.toContain('httpMeta');
    expect(check.message).not.toContain('AIzaSecretKey999');
    expect(check.models).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash']);

    await expect(
      llm.completeJson({
        settings,
        apiKey: 'AIzaSecretKey999',
        system: 'sys',
        user: 'usr',
        schema: z.object({ ok: z.boolean() })
      })
    ).rejects.toThrow(/HTTP 402.*Prepay.*\[REDACTED\]/);
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

  it('normalizes literal \\n\\n, single newlines, inline headings, and markdown wrappers in AI longReview', () => {
    const screenshotPayload =
      '【声音质地】以男声为主导，旋律流畅且兼具明亮、振奋与苦乐参半的质感。 \\n\\n 【风格坐标】横跨新迷幻、迷幻流行与声音拼贴等脉络。 \\n\\n 【口碑拆解】在海量乐迷投票中收获稳固的高分共识。 \\n\\n 【适听与劝退】偏爱精致旋律化迷幻流行的听众容易被打动。';
    expect(parseLongReviewBlocks(screenshotPayload)).toEqual([
      { label: '声音质地', body: '以男声为主导，旋律流畅且兼具明亮、振奋与苦乐参半的质感。' },
      { label: '风格坐标', body: '横跨新迷幻、迷幻流行与声音拼贴等脉络。' },
      { label: '口碑拆解', body: '在海量乐迷投票中收获稳固的高分共识。' },
      { label: '适听与劝退', body: '偏爱精致旋律化迷幻流行的听众容易被打动。' }
    ]);

    const mixedDecorated =
      '### **【声音质地】**：\n音色清冷。\n**【风格坐标】**：Dream Pop 与 Shoegaze 【口碑拆解】媒体与乐迷高度一致。【适听与劝退】\n';
    expect(normalizeLongReview(mixedDecorated)).toBe(
      '【声音质地】音色清冷。\n\n【风格坐标】Dream Pop 与 Shoegaze\n\n【口碑拆解】媒体与乐迷高度一致。\n\n【适听与劝退】'
    );
    expect(parseLongReviewBlocks(mixedDecorated)).toEqual([
      { label: '声音质地', body: '音色清冷。' },
      { label: '风格坐标', body: 'Dream Pop 与 Shoegaze' },
      { label: '口碑拆解', body: '媒体与乐迷高度一致。' }
    ]);

    const plainLiteral = '第一段概述声景纹理。\\n\\n第二段概括口碑共识。';
    expect(parseLongReviewBlocks(plainLiteral)).toEqual([
      { label: null, body: '第一段概述声景纹理。' },
      { label: null, body: '第二段概括口碑共识。' }
    ]);
  });

  it('normalizes literal \\n\\n during generation and cleans stored Not published snippets, Published suffixes, and malformed reviews on startup', async () => {
    const genDir = mkdtempSync(join(tmpdir(), 'relay-gen-normalize-'));
    const genAlbum = makeAlbum('Test Band', 'Crystal Dawn', ['Psychedelic Pop'], {
      detailCaptured: true,
      descriptors: ['melodic', 'lush']
    });
    const seedGen = new Store(genDir);
    seedGen.saveAlbums([genAlbum]);
    seedGen.close();

    let capturedSystem = '';
    const literalMockAi: LlmClient = {
      async checkConnection() {
        return { ok: true, message: 'ok', models: ['gemini-4-hydrogen'], checkedAt: new Date().toISOString() };
      },
      async completeJson<T>(req: LlmJsonRequest<T>): Promise<T> {
        capturedSystem = req.system;
        return req.schema.parse({
          shortReview: '明亮而细腻的迷幻流行声景，\\n旋律流畅。',
          longReview:
            '【声音质地】男声旋律流畅且饱满。 \\n\\n 【风格坐标】延续新迷幻与室内流行脉络。',
          audienceSummary: '核心乐迷高分认可，\\n反馈积极。',
          criticSummary: '暂无媒体评分与乐评摘录'
        });
      }
    };

    const genApp = await createApp({ dataDir: genDir, scheduler: false, ai: literalMockAi });
    try {
      const setup = await genApp.inject({ method: 'POST', url: '/api/setup', payload: { password: 'normalize-test-password' } });
      const cookie = setup.headers['set-cookie'] as string;
      await genApp.inject({
        method: 'PUT',
        url: '/api/ai',
        headers: { cookie },
        payload: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3.6:35b-a3b-mxfp8' }
      });

      const genRes = await genApp.inject({ method: 'POST', url: `/api/albums/${genAlbum.id}/review`, headers: { cookie }, payload: {} });
      expect(genRes.statusCode).toBe(200);
      expect(capturedSystem).not.toContain('\\n\\n');
      const review = genRes.json().review;
      expect(review.shortReview).toBe('明亮而细腻的迷幻流行声景， 旋律流畅。');
      expect(review.audienceSummary).toBe('核心乐迷高分认可， 反馈积极。');
      expect(review.longReview).toBe('【声音质地】男声旋律流畅且饱满。\n\n【风格坐标】延续新迷幻与室内流行脉络。');
      expect(review.longReview).not.toContain('\\n');
    } finally {
      await genApp.close();
      rmSync(genDir, { recursive: true, force: true });
    }

    // Startup migration cleanup for legacy stored snippets & literal \n\n reviews
    const dir = mkdtempSync(join(tmpdir(), 'relay-startup-cleanup-'));
    const onlyUnpublishedAlb = makeAlbum('Ghost Draft', 'Empty Note', ['Ambient'], { detailCaptured: true });
    onlyUnpublishedAlb.sources[0]!.reviewSnippets = [{ kind: 'user', author: 'example_user', text: 'Not published' }];

    const mixedAlbum = makeAlbum('The Olivia Tremor Control', 'The Same Place', ['Neo-Psychedelia'], { detailCaptured: true });
    mixedAlbum.sources[0]!.reviewSnippets = [
      { kind: 'user', author: 'example_user', text: 'Not published' },
      { kind: 'user', author: 'Turtlechris08', text: '초반 후반은 aoty급으로 좋은데 중반이 ㄹㅈㄷ로 루즈함Published' }
    ];

    const seed = new Store(dir);
    seed.saveAlbums([onlyUnpublishedAlb, mixedAlbum]);
    const insertReview = seed.database.prepare(
      `INSERT INTO album_reviews_ai(
        album_id, evidence_hash, evidence_level, short_review, long_review,
        audience_summary, critic_summary, model, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertReview.run(
      onlyUnpublishedAlb.id,
      'hash-1',
      'full',
      '凭无效草稿生成的短评',
      '【声音质地】应随无效证据一并清除的长评内容。',
      null,
      null,
      'gemini-4-hydrogen',
      new Date().toISOString()
    );
    insertReview.run(
      mixedAlbum.id,
      'hash-2',
      'full',
      '精致珍贵的遗作迷幻流行，\\n首尾惊艳而中段略显拖沓。',
      '【声音质地】以男声为主导，旋律流畅。 \\n\\n 【风格坐标】横跨新迷幻与室内流行。 \\n\\n 【口碑拆解】高分共识。 \\n\\n 【适听与劝退】偏爱精致迷幻流行的听众易被打动。',
      '乐迷高分认可。\\n部分听众认为中段拖沓。',
      '暂无媒体评分与乐评摘录',
      'gemini-4-hydrogen',
      new Date().toISOString()
    );
    seed.close();

    const app = await createApp({ dataDir: dir, scheduler: false });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'cleanup-test-password' } });
      const cookie = setup.headers['set-cookie'] as string;
      const albumsRes = await app.inject({ url: '/api/albums', headers: { cookie } });
      expect(albumsRes.statusCode).toBe(200);
      const albums = albumsRes.json() as Album[];

      const cleanedGhost = albums.find((a) => a.id === onlyUnpublishedAlb.id)!;
      expect(cleanedGhost.sources[0]!.reviewSnippets).toBeUndefined();
      expect(hasAlbumReviewEvidence(cleanedGhost)).toBe(false);
      expect(cleanedGhost.aiReview).toBeNull();

      const cleanedMixed = albums.find((a) => a.id === mixedAlbum.id)!;
      expect(cleanedMixed.sources[0]!.reviewSnippets).toEqual([
        {
          kind: 'user',
          author: 'Turtlechris08',
          text: '초반 후반은 aoty급으로 좋은데 중반이 ㄹㅈㄷ로 루즈함'
        }
      ]);
      expect(cleanedMixed.aiReview).not.toBeNull();
      expect(cleanedMixed.aiReview!.shortReview).toBe('精致珍贵的遗作迷幻流行， 首尾惊艳而中段略显拖沓。');
      expect(cleanedMixed.aiReview!.audienceSummary).toBe('乐迷高分认可。 部分听众认为中段拖沓。');
      expect(cleanedMixed.aiReview!.longReview).not.toContain('\\n');
      expect(parseLongReviewBlocks(cleanedMixed.aiReview!.longReview)).toHaveLength(4);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
