import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { AiConnectionCheck, AiProviderKind, AiSettings } from '../../shared/types.js';
import type { Store } from '../store.js';

const AI_SETTINGS_KEY = 'ai-settings';
const AI_API_KEY_STORAGE = 'ai-api-key';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-4-hydrogen';
export const GEMINI_RECOMMENDED_MODELS = [
  'gemini-4-hydrogen',
  'gemini-4-argon',
  'gemini-3.5-flash-lite',
  'gemini-4-carbon'
] as const;

export const DEFAULT_AI_SETTINGS: Omit<AiSettings, 'hasApiKey'> = {
  enabled: false,
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3.6:35b-a3b-mxfp8',
  autoReviewSelected: true,
  timeoutMs: 60_000
};

export interface LlmJsonRequest<T> {
  settings: AiSettings;
  apiKey: string | null;
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

export interface LlmClient {
  checkConnection(settings: AiSettings, apiKey: string | null): Promise<AiConnectionCheck>;
  completeJson<T>(request: LlmJsonRequest<T>): Promise<T>;
}

export interface GeminiSdkClient {
  models: {
    list(params?: {
      config?: { pageSize?: number; abortSignal?: AbortSignal };
    }): Promise<AsyncIterable<{ name?: string; supportedActions?: string[] }>>;
  };
  interactions: {
    create(
      params: {
        model: string;
        input: string;
        system_instruction?: string;
        store?: boolean;
        response_format?: { type: 'text'; mime_type?: string; schema?: Record<string, unknown> };
        generation_config?: Record<string, unknown>;
      },
      options?: { timeout_ms?: number }
    ): Promise<{ output_text?: string | null; steps?: unknown[] }>;
  };
}

export type GeminiClientFactory = (opts: {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}) => GeminiSdkClient;

const defaultGeminiFactory: GeminiClientFactory = ({ apiKey, baseUrl, timeoutMs }) => {
  const normalized = normalizeAiBaseUrl(baseUrl || GEMINI_DEFAULT_BASE_URL, 'gemini');
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(normalized !== GEMINI_DEFAULT_BASE_URL ? { baseUrl: normalized } : {}),
      ...(timeoutMs ? { timeout: timeoutMs } : {})
    }
  }) as unknown as GeminiSdkClient;
};

export function normalizeAiBaseUrl(raw: string, provider: AiProviderKind): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('模型服务地址仅支持有效的 http/https 地址，且不能包含用户名或密码');
  }
  if (provider === 'ollama' && (parsed.pathname === '/' || parsed.pathname === '')) {
    return `${parsed.origin}/v1`;
  }
  if (provider === 'gemini') {
    const cleanPath = parsed.pathname.replace(/\/(?:v1|v1beta|v1alpha)\/?$/i, '').replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath === '/' ? '' : cleanPath}`;
  }
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '');
}

function ollamaOriginFromBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return parsed.origin;
}

export function getAiApiKey(store: Store): string | null {
  const raw = store.getValue(AI_API_KEY_STORAGE);
  return raw && raw.trim() ? raw.trim() : null;
}

export function getAiSettings(store: Store): AiSettings {
  const raw = store.getValue(AI_SETTINGS_KEY);
  const hasApiKey = Boolean(getAiApiKey(store));
  if (!raw) return { ...DEFAULT_AI_SETTINGS, hasApiKey };
  try {
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const provider: AiProviderKind =
      parsed.provider === 'gemini'
        ? 'gemini'
        : parsed.provider === 'openai_compatible'
          ? 'openai_compatible'
          : 'ollama';
    const fallbackBase = provider === 'gemini' ? GEMINI_DEFAULT_BASE_URL : DEFAULT_AI_SETTINGS.baseUrl;
    const fallbackModel = provider === 'gemini' ? GEMINI_DEFAULT_MODEL : DEFAULT_AI_SETTINGS.model;
    const baseUrl =
      typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
        ? normalizeAiBaseUrl(parsed.baseUrl, provider)
        : fallbackBase;
    return {
      enabled: Boolean(parsed.enabled),
      provider,
      baseUrl,
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : fallbackModel,
      autoReviewSelected: parsed.autoReviewSelected ?? DEFAULT_AI_SETTINGS.autoReviewSelected,
      timeoutMs:
        typeof parsed.timeoutMs === 'number' && Number.isFinite(parsed.timeoutMs)
          ? Math.max(5_000, Math.min(180_000, Math.round(parsed.timeoutMs)))
          : DEFAULT_AI_SETTINGS.timeoutMs,
      hasApiKey
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS, hasApiKey };
  }
}

export function saveAiSettings(
  store: Store,
  input: Omit<AiSettings, 'hasApiKey'> & { apiKey?: string; clearApiKey?: boolean }
): AiSettings {
  const normalizedBaseUrl = normalizeAiBaseUrl(input.baseUrl, input.provider);
  const stored: Omit<AiSettings, 'hasApiKey'> = {
    enabled: Boolean(input.enabled),
    provider: input.provider,
    baseUrl: normalizedBaseUrl,
    model: input.model.trim(),
    autoReviewSelected: Boolean(input.autoReviewSelected),
    timeoutMs: Math.max(5_000, Math.min(180_000, Math.round(input.timeoutMs)))
  };
  store.transaction(() => {
    store.setValue(AI_SETTINGS_KEY, JSON.stringify(stored));
    if (input.clearApiKey) {
      store.deleteValue(AI_API_KEY_STORAGE);
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      store.setValue(AI_API_KEY_STORAGE, input.apiKey.trim());
    }
  });
  return getAiSettings(store);
}

/** Strips reasoning `<think>` tags and markdown fences before JSON parsing. */
export function extractJsonText(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

const UNSUPPORTED_GEMINI_SCHEMA_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains'
]);

function stripUnsupportedJsonSchemaKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedJsonSchemaKeys);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = stripUnsupportedJsonSchemaKeys(propSchema);
      }
      out[key] = propsOut;
    } else {
      out[key] = stripUnsupportedJsonSchemaKeys(value);
    }
  }
  return out;
}

export function zodSchemaToGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema);
  return stripUnsupportedJsonSchemaKeys(raw) as Record<string, unknown>;
}

function extractGeminiOutputText(interaction: { output_text?: string | null; steps?: unknown[] }): string {
  if (typeof interaction.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text;
  }
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as { type?: string; content?: { type?: string; text?: string }[] } | undefined;
    if (step?.type === 'model_output' && Array.isArray(step.content)) {
      const joined = step.content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('');
      if (joined.trim()) return joined;
    }
  }
  return '';
}

const EXCLUDED_GEMINI_MODEL_RE =
  /embedding|imagen|veo|lyria|tts|transcribe|aqa|robotics|nano-banana|decision|-image|live/i;
const LEGACY_GEMINI_MODEL_RE = /^gemini-(?:1\.|2\.|pro\b|ultra\b)/i;

function rankAndFilterGeminiModels(rawNames: string[]): string[] {
  const cleaned = [...new Set(rawNames.map((n) => n.replace(/^models\//, '').trim()).filter(Boolean))];
  const usable = cleaned.filter((id) => !EXCLUDED_GEMINI_MODEL_RE.test(id) && !LEGACY_GEMINI_MODEL_RE.test(id));
  const pool = usable.length ? usable : cleaned.filter((id) => !EXCLUDED_GEMINI_MODEL_RE.test(id));
  const priority = (id: string): number => {
    const recIdx = GEMINI_RECOMMENDED_MODELS.indexOf(id as (typeof GEMINI_RECOMMENDED_MODELS)[number]);
    if (recIdx >= 0) return recIdx;
    if (id.startsWith('gemini-4')) return 10;
    if (id.startsWith('gemini-3.')) return 20;
    if (id.startsWith('gemma-4')) return 30;
    return 50;
  };
  return pool.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

function sanitizeErrorMessage(err: unknown, apiKey: string | null): string {
  const raw = err instanceof Error ? err.message : String(err ?? '模型请求失败');
  let safe = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]');
  if (apiKey && apiKey.length >= 4) safe = safe.split(apiKey).join('[REDACTED]');
  return safe.slice(0, 240);
}

export class DefaultLlmClient implements LlmClient {
  private readonly createGeminiClient: GeminiClientFactory;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    geminiFactory?: GeminiClientFactory
  ) {
    this.createGeminiClient = geminiFactory ?? defaultGeminiFactory;
  }

  async checkConnection(settings: AiSettings, apiKey: string | null): Promise<AiConnectionCheck> {
    const checkedAt = new Date().toISOString();

    if (settings.provider === 'gemini') {
      if (!apiKey || !apiKey.trim()) {
        return { ok: false, message: '请先填写 Gemini API Key', models: [], checkedAt };
      }
      const baseUrl = normalizeAiBaseUrl(settings.baseUrl || GEMINI_DEFAULT_BASE_URL, 'gemini');
      const ai = this.createGeminiClient({ apiKey: apiKey.trim(), baseUrl, timeoutMs: 10_000 });
      try {
        const pager = await ai.models.list({
          config: { pageSize: 100, abortSignal: AbortSignal.timeout(8_000) }
        });
        const discovered: string[] = [];
        for await (const m of pager) {
          if (typeof m?.name === 'string' && m.name.trim()) discovered.push(m.name);
        }
        const ranked = rankAndFilterGeminiModels(discovered);
        const models = ranked.length ? ranked : [...GEMINI_RECOMMENDED_MODELS];
        return {
          ok: true,
          message: discovered.length ? `Gemini 连接成功 · 发现 ${models.length} 个可用模型` : 'Gemini 接口连接成功',
          models,
          checkedAt
        };
      } catch (listErr) {
        const msg = sanitizeErrorMessage(listErr, apiKey);
        if (/\b(404|405)\b/.test(msg)) {
          try {
            await ai.interactions.create(
              {
                model: settings.model || GEMINI_DEFAULT_MODEL,
                input: 'ping',
                store: false,
                generation_config: { max_output_tokens: 8 }
              },
              { timeout_ms: 10_000 }
            );
            return {
              ok: true,
              message: `Gemini 接口连通测试成功（模型：${settings.model || GEMINI_DEFAULT_MODEL}）`,
              models: [settings.model || GEMINI_DEFAULT_MODEL],
              checkedAt
            };
          } catch (pingErr) {
            return { ok: false, message: `Gemini 连接失败：${sanitizeErrorMessage(pingErr, apiKey)}`, models: [], checkedAt };
          }
        }
        return { ok: false, message: `Gemini 连接失败：${msg}`, models: [], checkedAt };
      }
    }

    const v1Base = normalizeAiBaseUrl(settings.baseUrl, settings.provider);
    const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    if (settings.provider === 'ollama') {
      try {
        const origin = ollamaOriginFromBaseUrl(v1Base);
        const tagsRes = await this.fetchImpl(`${origin}/api/tags`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(8_000)
        });
        if (tagsRes.ok) {
          const data = (await tagsRes.json()) as { models?: { name?: string; model?: string }[] };
          const models = [
            ...new Set(
              (data.models ?? [])
                .map((m) => (m.name || m.model || '').trim())
                .filter(Boolean)
            )
          ];
          const modelNote = models.length
            ? `发现 ${models.length} 个本地模型${settings.model && !models.includes(settings.model) ? `（当前填的模型「${settings.model}」不在列表中，请确认或改选）` : ''}`
            : '连接成功，但尚未检测到已拉取的模型（可执行 ollama pull 下载模型）';
          return { ok: true, message: `Ollama 连接成功 · ${modelNote}`, models, checkedAt };
        }
      } catch {
        // Fall through to /v1/models check below.
      }
    }

    try {
      const modelsRes = await this.fetchImpl(`${v1Base}/models`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(8_000)
      });
      if (modelsRes.ok) {
        const data = (await modelsRes.json()) as { data?: { id?: string }[] };
        const models = [...new Set((data.data ?? []).map((m) => (m.id ?? '').trim()).filter(Boolean))];
        return {
          ok: true,
          message: models.length ? `接口连接成功 · 发现 ${models.length} 个可用模型` : '接口连接成功',
          models,
          checkedAt
        };
      }
      if (modelsRes.status === 404 || modelsRes.status === 405) {
        const pingRes = await this.fetchImpl(`${v1Base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            model: settings.model,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'ping' }]
          }),
          signal: AbortSignal.timeout(10_000)
        });
        if (pingRes.ok) {
          return { ok: true, message: `接口连通测试成功（模型：${settings.model}）`, models: [settings.model], checkedAt };
        }
        return { ok: false, message: `模型接口返回 HTTP ${pingRes.status}`, models: [], checkedAt };
      }
      return { ok: false, message: `模型接口返回 HTTP ${modelsRes.status}`, models: [], checkedAt };
    } catch (e) {
      return { ok: false, message: `无法连接模型服务：${sanitizeErrorMessage(e, apiKey)}`, models: [], checkedAt };
    }
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<T> {
    if (request.settings.provider === 'gemini') {
      if (!request.apiKey || !request.apiKey.trim()) {
        throw new Error('AI 调用失败：请先在「设置 → AI 与高级」填写 Gemini API Key');
      }
      const apiKey = request.apiKey.trim();
      const baseUrl = normalizeAiBaseUrl(request.settings.baseUrl || GEMINI_DEFAULT_BASE_URL, 'gemini');
      const ai = this.createGeminiClient({ apiKey, baseUrl, timeoutMs: request.settings.timeoutMs });
      const jsonSchema = zodSchemaToGeminiJsonSchema(request.schema);
      const model = request.settings.model || GEMINI_DEFAULT_MODEL;
      const runGemini = async (withExtras: boolean) =>
        ai.interactions.create(
          {
            model,
            input: request.user,
            system_instruction: request.system,
            store: false,
            response_format: withExtras
              ? { type: 'text', mime_type: 'application/json', schema: jsonSchema }
              : { type: 'text', mime_type: 'application/json' },
            ...(withExtras && !model.startsWith('gemma-')
              ? { generation_config: { thinking_level: 'low' } }
              : {})
          },
          { timeout_ms: request.settings.timeoutMs }
        );

      try {
        let interaction: { output_text?: string | null; steps?: unknown[] };
        try {
          interaction = await runGemini(true);
        } catch (firstErr) {
          const msg = sanitizeErrorMessage(firstErr, apiKey);
          if (/\b400\b|INVALID_ARGUMENT|thinking|schema/i.test(msg)) {
            interaction = await runGemini(false);
          } else {
            throw firstErr;
          }
        }
        const rawText = extractGeminiOutputText(interaction);
        if (!rawText.trim()) {
          throw new Error('Gemini 返回内容为空');
        }
        const jsonText = extractJsonText(rawText);
        const parsed = JSON.parse(jsonText) as unknown;
        return request.schema.parse(parsed);
      } catch (e) {
        throw new Error(`AI 调用失败：${sanitizeErrorMessage(e, apiKey)}`);
      }
    }

    const v1Base = normalizeAiBaseUrl(request.settings.baseUrl, request.settings.provider);
    const authHeaders: Record<string, string> = request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {};
    const url = `${v1Base}/chat/completions`;
    const baseBody = {
      model: request.settings.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user }
      ]
    };

    const callOnce = async (useExtras: boolean): Promise<Response> => {
      const payload = useExtras
        ? {
            ...baseBody,
            response_format: { type: 'json_object' },
            ...(request.settings.provider === 'ollama' ? { reasoning_effort: 'none' } : {})
          }
        : baseBody;
      return this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(request.settings.timeoutMs)
      });
    };

    try {
      let res = await callOnce(true);
      if (res.status === 400) {
        // Some OpenAI-compatible proxies or older Ollama builds reject response_format or reasoning_effort.
        res = await callOnce(false);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 140)}` : ''}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('模型返回内容为空');
      }
      const jsonText = extractJsonText(content);
      const parsed = JSON.parse(jsonText) as unknown;
      return request.schema.parse(parsed);
    } catch (e) {
      throw new Error(`AI 调用失败：${sanitizeErrorMessage(e, request.apiKey)}`);
    }
  }
}
