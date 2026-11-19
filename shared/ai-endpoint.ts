import type { AiProviderKind, AiSettings } from './types.js';

type AiEndpoint = Pick<AiSettings, 'provider' | 'baseUrl'>;

export function normalizeAiBaseUrl(raw: string, provider: AiProviderKind): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('模型服务地址仅支持有效的 http/https 地址，且不能包含用户名或密码');
  }
  if (provider === 'ollama' && parsed.pathname === '/') {
    return `${parsed.origin}/v1`;
  }
  if (provider === 'gemini') {
    const cleanPath = parsed.pathname.replace(/\/(?:v1|v1beta|v1alpha)\/?$/i, '').replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

export function isSameAiEndpoint(saved: AiEndpoint, draft: AiEndpoint): boolean {
  if (saved.provider !== draft.provider) return false;
  try {
    return normalizeAiBaseUrl(saved.baseUrl, saved.provider) === normalizeAiBaseUrl(draft.baseUrl, draft.provider);
  } catch {
    return false;
  }
}
