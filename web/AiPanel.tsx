import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, LoaderCircle } from 'lucide-react';
import { isSameAiEndpoint } from '../shared/ai-endpoint';
import type { AiConnectionCheck, AiProviderKind, AiSettings } from '../shared/types';

interface Props {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
  onSaved?: (settings: AiSettings) => void;
}

const GEMINI_RECOMMENDED_MODELS = ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'];
const OLLAMA_RECOMMENDED_MODELS = ['qwen3.6:35b-a3b-mxfp8', 'qwen3.5:4b', 'qwen3.8:27b-mlx'];
const OPENAI_RECOMMENDED_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'deepseek-chat'];

type ProviderDraft = { baseUrl: string; model: string };

const PROVIDER_META: Record<
  AiProviderKind,
  {
    title: string;
    subtitle: string;
    defaultUrl: string;
    defaultModel: string;
    keyPlaceholder: string;
    defaultTimeoutMs: number;
  }
> = {
  ollama: {
    title: 'Ollama 本地',
    subtitle: '本机或局域网私有运行',
    defaultUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3.6:35b-a3b-mxfp8',
    keyPlaceholder: '仅在网关鉴权时填写',
    defaultTimeoutMs: 60000
  },
  gemini: {
    title: 'Google Gemini',
    subtitle: 'Google 官方模型服务',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-4-hydrogen',
    keyPlaceholder: 'AIza...',
    defaultTimeoutMs: 45000
  },
  openai_compatible: {
    title: 'OpenAI 兼容',
    subtitle: '兼容 OpenAI 格式接口',
    defaultUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyPlaceholder: 'sk-...',
    defaultTimeoutMs: 45000
  }
};

function initialProviderDrafts(saved?: AiSettings): Record<AiProviderKind, ProviderDraft> {
  const drafts = {
    ollama: { baseUrl: PROVIDER_META.ollama.defaultUrl, model: PROVIDER_META.ollama.defaultModel },
    gemini: { baseUrl: PROVIDER_META.gemini.defaultUrl, model: PROVIDER_META.gemini.defaultModel },
    openai_compatible: {
      baseUrl: PROVIDER_META.openai_compatible.defaultUrl,
      model: PROVIDER_META.openai_compatible.defaultModel
    }
  };
  if (saved) drafts[saved.provider] = { baseUrl: saved.baseUrl, model: saved.model };
  return drafts;
}

function formatHostSummary(url: string, timeoutMs: number): string {
  const trimmed = url.trim();
  let hostLabel = trimmed;
  try {
    hostLabel = new URL(trimmed).host || trimmed;
  } catch {
    hostLabel = trimmed || '未设置地址';
  }
  const secs = Math.max(1, Math.round((Number(timeoutMs) || 45000) / 1000));
  return `${hostLabel} · ${secs}s`;
}

function detectOllamaHostPreset(url: string): 'local' | 'remote' | 'custom' {
  const normalized = url.trim().replace(/\/+$/, '');
  if (normalized === 'http://ollama-host.example:11434/v1') return 'remote';
  if (
    normalized === 'http://127.0.0.1:11434/v1' ||
    normalized === 'http://127.0.0.1:11434' ||
    normalized === 'http://localhost:11434/v1' ||
    normalized === 'http://localhost:11434'
  ) {
    return 'local';
  }
  return 'custom';
}

export function AiPanel({ request, onSaved }: Props) {
  const [savedSettings, setSavedSettings] = useState<AiSettings | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [draftsByProvider, setDraftsByProvider] = useState(initialProviderDrafts);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customOllamaSelected, setCustomOllamaSelected] = useState(false);
  const [checkResult, setCheckResult] = useState<AiConnectionCheck | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const baseUrlInputRef = useRef<HTMLInputElement>(null);
  const checkRevision = useRef(0);

  const syncSaved = useCallback((loaded: AiSettings) => {
    setSavedSettings(loaded);
    setSettings(loaded);
    setDraftsByProvider((prev) => ({
      ...prev,
      [loaded.provider]: { baseUrl: loaded.baseUrl, model: loaded.model }
    }));
    if (loaded.provider === 'ollama' && detectOllamaHostPreset(loaded.baseUrl) === 'custom') {
      setCustomOllamaSelected(true);
      setAdvancedOpen(true);
    }
  }, []);

  const load = useCallback(async () => {
    const res = await request<{ settings: AiSettings }>('/ai');
    syncSaved(res.settings);
    onSavedRef.current?.(res.settings);
  }, [request, syncSaved]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'AI 配置加载失败'));
  }, [load]);

  useEffect(() => {
    checkRevision.current++;
    setCheckResult(null);
  }, [settings?.provider, settings?.baseUrl, settings?.model, apiKey, clearApiKey]);

  if (!settings || !savedSettings) return null;

  const switchProvider = (nextProvider: AiProviderKind) => {
    if (nextProvider === settings.provider) return;
    setDraftsByProvider((prev) => ({
      ...prev,
      [settings.provider]: { baseUrl: settings.baseUrl, model: settings.model }
    }));
    const targetDraft = draftsByProvider[nextProvider];
    const nextIsCustomOllama = nextProvider === 'ollama' && detectOllamaHostPreset(targetDraft.baseUrl) === 'custom';
    setCustomOllamaSelected(nextIsCustomOllama);
    if (nextIsCustomOllama) setAdvancedOpen(true);

    setSettings({
      ...settings,
      provider: nextProvider,
      baseUrl: targetDraft.baseUrl,
      model: targetDraft.model
    });
    setApiKey('');
    setClearApiKey(false);
    setCheckResult(null);
    setNotice('');
    setError('');
  };

  const isDirty =
    savedSettings.enabled !== settings.enabled ||
    savedSettings.provider !== settings.provider ||
    savedSettings.baseUrl.replace(/\/+$/, '') !== settings.baseUrl.replace(/\/+$/, '') ||
    savedSettings.model.trim() !== settings.model.trim() ||
    savedSettings.autoReviewSelected !== settings.autoReviewSelected ||
    savedSettings.timeoutMs !== settings.timeoutMs ||
    Boolean(apiKey.trim()) ||
    clearApiKey;

  const discardDraft = () => {
    setSettings(savedSettings);
    setDraftsByProvider(initialProviderDrafts(savedSettings));
    setCustomOllamaSelected(
      savedSettings.provider === 'ollama' && detectOllamaHostPreset(savedSettings.baseUrl) === 'custom'
    );
    setApiKey('');
    setClearApiKey(false);
    setCheckResult(null);
    setError('');
    setNotice('已恢复为当前运行的已保存配置。');
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const res = await request<{ settings: AiSettings }>(
        '/ai',
        {
          enabled: settings.enabled,
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          autoReviewSelected: settings.autoReviewSelected,
          timeoutMs: settings.timeoutMs,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(clearApiKey ? { clearApiKey: true } : {})
        },
        'PUT'
      );
      syncSaved(res.settings);
      setApiKey('');
      setClearApiKey(false);
      onSaved?.(res.settings);
      setNotice(
        res.settings.enabled
          ? `已保存配置：${PROVIDER_META[res.settings.provider].title} · ${res.settings.model}。`
          : '已保存 · AI 策展与乐评当前处于停用状态。'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy('');
    }
  }

  async function testConnection() {
    if (!settings) return;
    const revision = checkRevision.current;
    setBusy('check');
    setCheckResult(null);
    setError('');
    setNotice('');
    try {
      const res = await request<AiConnectionCheck>('/ai/check', {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {})
      });
      if (revision === checkRevision.current) setCheckResult(res);
    } catch (err) {
      if (revision === checkRevision.current) setError(err instanceof Error ? err.message : '连接测试失败');
    } finally {
      setBusy('');
    }
  }

  async function generateSelectedReviews() {
    setBusy('batch');
    setError('');
    setNotice('');
    try {
      const res = await request<{ queuedCount: number; totalSelected: number }>('/ai/reviews/generate-selected', {});
      setNotice(
        res.queuedCount
          ? `已加入后台补全队列（${res.queuedCount} 张专辑），当前引擎「${savedSettings?.model}」。`
          : `全部 ${res.totalSelected} 张入选专辑已有最新乐评。`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量补全失败');
    } finally {
      setBusy('');
    }
  }

  const detectedOllamaHost = detectOllamaHostPreset(settings.baseUrl);
  const ollamaHostMode = customOllamaSelected ? 'custom' : detectedOllamaHost;

  const quickModels =
    settings.provider === 'gemini'
      ? GEMINI_RECOMMENDED_MODELS
      : settings.provider === 'ollama'
        ? OLLAMA_RECOMMENDED_MODELS
        : OPENAI_RECOMMENDED_MODELS;

  const isOllama = settings.provider === 'ollama';
  const liveMeta = PROVIDER_META[savedSettings.provider];
  const draftMeta = PROVIDER_META[settings.provider];
  const switchingProvider = settings.enabled && savedSettings.enabled && settings.provider !== savedSettings.provider;
  const sameEndpoint = isSameAiEndpoint(savedSettings, settings);
  const keyAppliesToDraft = sameEndpoint && savedSettings.hasApiKey;
  const showClearButton = Boolean(apiKey.trim()) || keyAppliesToDraft || clearApiKey;

  const handleClearKeyToggle = () => {
    if (apiKey.trim()) {
      setApiKey('');
      return;
    }
    if (keyAppliesToDraft || clearApiKey) {
      setClearApiKey((cur) => !cur);
    }
  };

  let dirtyText = '';
  if (isDirty) {
    if (!savedSettings.enabled && settings.enabled) {
      dirtyText = `有未保存更改 · 当前 AI 乐评未启用，保存后将启用「${draftMeta.title}」`;
    } else if (savedSettings.enabled && !settings.enabled) {
      dirtyText = `有未保存更改 · 当前仍以「${liveMeta.title}」运行，保存后停用`;
    } else if (settings.provider !== savedSettings.provider) {
      dirtyText = `有未保存更改 · 当前仍以「${liveMeta.title}」运行，保存后切换`;
    } else {
      dirtyText = `有未保存更改 · 当前仍以「${liveMeta.title} · ${savedSettings.model}」运行，保存后生效`;
    }
    if (!sameEndpoint && savedSettings.hasApiKey) {
      dirtyText += '。保存新服务地址后会移除旧密钥。';
    }
  }

  let keyHint = '尚未保存密钥，请输入有效的服务密钥';
  if (clearApiKey) {
    keyHint = '已标记清除旧密钥，保存后生效';
  } else if (apiKey.trim()) {
    keyHint = '保存后将更新为新填写的密钥';
  } else if (keyAppliesToDraft) {
    keyHint = '已保存于本机，留空将继续沿用现有密钥';
  }

  return (
    <section
      className={`rules-section ai-settings-card ${!settings.enabled ? 'is-disabled' : ''}`}
      aria-labelledby="ai-heading"
    >
      {/* Single Calm Header Bar */}
      <div className="section-bar ai-card-header">
        <div className="ai-header-left">
          <h2 id="ai-heading" className="ai-card-title cjk-heading">
            AI 策展与乐评
          </h2>
          <span className="ai-live-indicator" aria-live="polite">
            <span className={`ai-live-dot ${savedSettings.enabled ? '' : 'is-off'}`} aria-hidden="true" />
            {savedSettings.enabled ? (
              <span className="ai-live-text">
                <span>运行中 · {liveMeta.title}</span>
                <span aria-hidden="true">·</span>
                <span className="ai-live-model mono-num">{savedSettings.model}</span>
              </span>
            ) : (
              <span className="ai-live-text">未启用</span>
            )}
          </span>
        </div>

        <label className="toggle-wrap ai-master-toggle" htmlFor="ai-enabled-toggle">
          <span>{settings.enabled ? '已启用' : '已关闭'}</span>
          <input
            id="ai-enabled-toggle"
            type="checkbox"
            className="toggle-input"
            checked={settings.enabled}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />
        </label>
      </div>

      {/* Dirty-Only Restrained Amber/Paper Notice */}
      {isDirty && (
        <div className="ai-dirty-notice" role="status" aria-live="polite">
          <div className="ai-dirty-notice-main">
            <span className="ai-dirty-dot" aria-hidden="true" />
            <span>{dirtyText}</span>
          </div>
          <button type="button" className="ai-discard-btn" onClick={discardDraft}>
            放弃更改
          </button>
        </div>
      )}

      <form onSubmit={(e) => void save(e)} className="ai-config-body">
        {/* 3-Engine Selector Cards */}
        <div className="ai-provider-grid" role="radiogroup" aria-label="选择 AI 分析引擎">
          {(['ollama', 'gemini', 'openai_compatible'] as AiProviderKind[]).map((kind) => {
            const meta = PROVIDER_META[kind];
            const isSelected = settings.provider === kind;
            const isLive = savedSettings.enabled && savedSettings.provider === kind;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`ai-provider-card ${isSelected ? 'is-selected' : ''}`}
                onClick={() => switchProvider(kind)}
              >
                <div className="ai-provider-card-head">
                  <span className="ai-provider-name">{meta.title}</span>
                  {isLive && (
                    <span className="ai-running-micro">
                      <span className="ai-running-micro-dot" aria-hidden="true" />
                      <span>运行中</span>
                    </span>
                  )}
                </div>
                <span className="ai-provider-sub">{meta.subtitle}</span>
              </button>
            );
          })}
        </div>

        {/* Ollama Segmented Host Presets */}
        {isOllama && (
          <div className="ai-host-preset-row">
            <span className="ai-host-preset-label">服务节点预设</span>
            <div className="segmented-tabs" role="group" aria-label="Ollama 服务地址预设">
              <button
                type="button"
                className={`seg-tab ${ollamaHostMode === 'local' ? 'is-active' : ''}`}
                onClick={() => {
                  setCustomOllamaSelected(false);
                  setSettings({ ...settings, baseUrl: 'http://127.0.0.1:11434/v1' });
                }}
              >
                本机 127.0.0.1
              </button>
              <button
                type="button"
                className={`seg-tab ${ollamaHostMode === 'remote' ? 'is-active' : ''}`}
                onClick={() => {
                  setCustomOllamaSelected(false);
                  setSettings({ ...settings, baseUrl: 'http://ollama-host.example:11434/v1' });
                }}
              >
                另一台设备（填写实际地址）
              </button>
              <button
                type="button"
                className={`seg-tab ${ollamaHostMode === 'custom' ? 'is-active' : ''}`}
                onClick={() => {
                  setCustomOllamaSelected(true);
                  setAdvancedOpen(true);
                  window.setTimeout(() => {
                    baseUrlInputRef.current?.focus();
                    baseUrlInputRef.current?.select();
                  }, 20);
                }}
              >
                自定义
              </button>
            </div>
          </div>
        )}

        {/* Primary 2-Column Form Row: Model (+ Paired Quick Chips) | API Key */}
        <div className={`ai-primary-grid ${isOllama ? 'is-single-col' : ''}`}>
          <div className="form-field">
            <div className="ai-label-row">
              <label className="field-label" htmlFor="ai-model-input">
                模型名称
              </label>
            </div>
            <input
              id="ai-model-input"
              required
              className="input-control mono-num"
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder={draftMeta.defaultModel}
              autoComplete="off"
              spellCheck={false}
            />
            {quickModels.length > 0 && (
              <div className="ai-quick-chips" role="group" aria-label="常用模型快捷切换">
                {quickModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={settings.model === m}
                    className={`ai-quick-chip ${settings.model === m ? 'is-active' : ''}`}
                    onClick={() => setSettings({ ...settings, model: m })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!isOllama && (
            <div className="form-field">
              <div className="ai-label-row">
                <label className="field-label" htmlFor="ai-apikey-input">
                  API Key
                </label>
                {showClearButton && (
                  <button
                    type="button"
                    className={`ai-inline-action-btn ${clearApiKey ? 'is-clearing' : ''}`}
                    onClick={handleClearKeyToggle}
                  >
                    {clearApiKey ? '撤销清除' : '清除'}
                  </button>
                )}
              </div>
              <input
                id="ai-apikey-input"
                type="password"
                className="input-control mono-num"
                autoComplete="new-password"
                disabled={clearApiKey}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (e.target.value.trim()) setClearApiKey(false);
                }}
                placeholder={keyAppliesToDraft && !clearApiKey ? '已保存密钥（留空保留）' : draftMeta.keyPlaceholder}
              />
              <span className="field-hint">{keyHint}</span>
            </div>
          )}
        </div>

        {/* Automation Preference Row */}
        <label className="ai-auto-row" htmlFor="ai-auto-review-toggle">
          <span className="ai-auto-copy">
            <span className="ai-auto-title">新专辑入选后自动生成乐评</span>
            <span className="ai-auto-desc">每轮新碟入选后自动补充唱片档案短评</span>
          </span>
          <input
            id="ai-auto-review-toggle"
            type="checkbox"
            className="toggle-input"
            checked={settings.autoReviewSelected}
            onChange={(e) => setSettings({ ...settings, autoReviewSelected: e.target.checked })}
          />
        </label>

        {/* Collapsible Advanced Parameters */}
        <details
          className="ai-advanced-disclosure"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary className="ai-advanced-summary">
            <span className="ai-advanced-summary-left">
              <ChevronRight size={14} className="ai-disclosure-chevron" aria-hidden="true" />
              <span>高级参数（接口地址与超时）</span>
            </span>
            <span className="ai-advanced-hint">{formatHostSummary(settings.baseUrl, settings.timeoutMs)}</span>
          </summary>

          <div className="ai-advanced-body">
            <label className="form-field" htmlFor="ai-baseurl-input">
              <span className="field-label">接口地址 (Base URL)</span>
              <input
                id="ai-baseurl-input"
                ref={baseUrlInputRef}
                required
                className="input-control mono-num"
                value={settings.baseUrl}
                onChange={(e) => {
                  setCustomOllamaSelected(false);
                  setSettings({ ...settings, baseUrl: e.target.value });
                }}
                placeholder={draftMeta.defaultUrl}
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <label className="form-field" htmlFor="ai-timeout-input">
              <span className="field-label">超时时间（毫秒）</span>
              <input
                id="ai-timeout-input"
                type="number"
                className="input-control mono-num"
                min={5000}
                max={180000}
                step={1000}
                required
                value={settings.timeoutMs}
                onChange={(e) => setSettings({ ...settings, timeoutMs: Number(e.target.value) })}
              />
            </label>

            {isOllama && (
              <div className="form-field ai-ollama-key-field">
                <div className="ai-label-row">
                  <label className="field-label" htmlFor="ai-ollama-key-input">
                    API Key（可选）
                  </label>
                  {showClearButton && (
                    <button
                      type="button"
                      className={`ai-inline-action-btn ${clearApiKey ? 'is-clearing' : ''}`}
                      onClick={handleClearKeyToggle}
                    >
                      {clearApiKey ? '撤销清除' : '清除'}
                    </button>
                  )}
                </div>
                <input
                  id="ai-ollama-key-input"
                  type="password"
                  className="input-control mono-num"
                  autoComplete="new-password"
                  disabled={clearApiKey}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    if (e.target.value.trim()) setClearApiKey(false);
                  }}
                  placeholder={keyAppliesToDraft && !clearApiKey ? '已保存密钥（留空保留）' : draftMeta.keyPlaceholder}
                />
              </div>
            )}
          </div>
        </details>

        {/* Inline Connection Test Feedback */}
        {checkResult && (
          <div className={`ai-test-feedback ${checkResult.ok ? 'is-ok' : 'is-error'}`} role="status" aria-live="polite">
            <div className="ai-test-feedback-head">
              <span className="ai-test-status-line">
                <span className="ai-test-dot" aria-hidden="true" />
                <span>
                  {checkResult.message}
                </span>
              </span>
              <button type="button" className="ai-test-dismiss" onClick={() => setCheckResult(null)}>
                收起
              </button>
            </div>
            {checkResult.models.length > 0 && (
              <div className="ai-quick-chips" role="group" aria-label="已发现模型">
                {checkResult.models.slice(0, 16).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`ai-quick-chip ${settings.model === m ? 'is-active' : ''}`}
                    onClick={() => setSettings({ ...settings, model: m })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer Action Bar */}
        <div className="ai-card-footer">
          <div className="ai-footer-primary-cluster">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy}>
              {busy === 'save' && <LoaderCircle size={14} className="spin" />}
              <span>{switchingProvider ? '保存并切换' : '保存配置'}</span>
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void testConnection()}>
              {busy === 'check' && <LoaderCircle size={14} className="spin" />}
              <span>{busy === 'check' ? '测试中…' : '测试连接'}</span>
            </button>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm ai-utility-btn"
            disabled={!!busy || !savedSettings.enabled}
            onClick={() => void generateSelectedReviews()}
          >
            {busy === 'batch' && <LoaderCircle size={14} className="spin" />}
            <span>{busy === 'batch' ? '排队补全中…' : '补全入选专辑乐评'}</span>
          </button>
        </div>
      </form>

      {error && (
        <div className="banner error" role="alert" style={{ marginTop: '14px', marginBottom: 0 }}>
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="banner success" role="status" style={{ marginTop: '14px', marginBottom: 0 }}>
          <Check size={15} />
          <span>{notice}</span>
        </div>
      )}
    </section>
  );
}
