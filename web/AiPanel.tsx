import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, Cpu, KeyRound, LoaderCircle, Radio, Sparkles } from 'lucide-react';
import type { AiConnectionCheck, AiProviderKind, AiSettings } from '../shared/types';

interface Props {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
  onSaved?: (settings: AiSettings) => void;
}

const GEMINI_RECOMMENDED_MODELS = ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-4-carbon'];
const OLLAMA_RECOMMENDED_MODELS = ['qwen3.6:35b-a3b-mxfp8', 'qwen3.5:4b', 'qwen3.8:27b-mlx'];

type ProviderDraft = { baseUrl: string; model: string };

const PROVIDER_META: Record<
  AiProviderKind,
  { title: string; subtitle: string; defaultUrl: string; defaultModel: string }
> = {
  ollama: {
    title: 'Ollama 本地 / NAS',
    subtitle: '本机或 Tailscale 局域网零成本私有运行',
    defaultUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3.6:35b-a3b-mxfp8'
  },
  gemini: {
    title: 'Google Gemini API',
    subtitle: '官方 Interactions API · 结构化 JSON 输出',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-4-hydrogen'
  },
  openai_compatible: {
    title: 'OpenAI 兼容 API',
    subtitle: 'OpenAI 或兼容 /v1/chat/completions 服务',
    defaultUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini'
  }
};

function formatActiveEngineSummary(s: AiSettings | null): string {
  if (!s) return '正在读取…';
  if (!s.enabled) return `未启用（当前表单预设：${PROVIDER_META[s.provider].title} · ${s.model}）`;
  const hostNote =
    s.provider === 'ollama'
      ? s.baseUrl.includes('127.0.0.1') || s.baseUrl.includes('localhost')
        ? '本机 Ollama'
        : '远程 Ollama'
      : PROVIDER_META[s.provider].title;
  return `${hostNote} · ${s.model}`;
}

export function AiPanel({ request, onSaved }: Props) {
  const [savedSettings, setSavedSettings] = useState<AiSettings | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [draftsByProvider, setDraftsByProvider] = useState<Record<AiProviderKind, ProviderDraft>>({
    ollama: { baseUrl: PROVIDER_META.ollama.defaultUrl, model: PROVIDER_META.ollama.defaultModel },
    gemini: { baseUrl: PROVIDER_META.gemini.defaultUrl, model: PROVIDER_META.gemini.defaultModel },
    openai_compatible: { baseUrl: PROVIDER_META.openai_compatible.defaultUrl, model: PROVIDER_META.openai_compatible.defaultModel }
  });
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [checkResult, setCheckResult] = useState<AiConnectionCheck | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const syncSaved = useCallback((loaded: AiSettings) => {
    setSavedSettings(loaded);
    setSettings(loaded);
    setDraftsByProvider((prev) => ({
      ...prev,
      [loaded.provider]: { baseUrl: loaded.baseUrl, model: loaded.model }
    }));
  }, []);

  const load = useCallback(async () => {
    const res = await request<{ settings: AiSettings }>('/ai');
    syncSaved(res.settings);
    onSavedRef.current?.(res.settings);
  }, [request, syncSaved]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'AI 配置加载失败'));
  }, [load]);

  if (!settings || !savedSettings) return null;

  const switchProvider = (nextProvider: AiProviderKind) => {
    setDraftsByProvider((prev) => ({
      ...prev,
      [settings.provider]: { baseUrl: settings.baseUrl, model: settings.model }
    }));
    const targetDraft =
      settings.provider === nextProvider
        ? { baseUrl: settings.baseUrl, model: settings.model }
        : draftsByProvider[nextProvider] ?? {
            baseUrl: PROVIDER_META[nextProvider].defaultUrl,
            model: PROVIDER_META[nextProvider].defaultModel
          };
    setSettings({
      ...settings,
      provider: nextProvider,
      baseUrl: targetDraft.baseUrl,
      model: targetDraft.model
    });
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
          ? `已切换并保存：当前全站 AI 分析与月度歌单将使用 ${PROVIDER_META[res.settings.provider].title}（${res.settings.model}）。`
          : '配置已保存（AI 功能当前处于停用状态）。'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy('');
    }
  }

  async function testConnection() {
    if (!settings) return;
    setBusy('check');
    setError('');
    setNotice('');
    try {
      const res = await request<AiConnectionCheck>('/ai/check', {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      });
      setCheckResult(res);
      if (res.ok && res.models.length && !res.models.includes(settings.model)) {
        setSettings((cur) => (cur ? { ...cur, model: res.models[0]! } : cur));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败');
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
          ? `已加入后台生成（${res.queuedCount} 张专辑），将使用当前生效引擎「${savedSettings?.model}」。`
          : `全部 ${res.totalSelected} 张入选专辑已有最新乐评。`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量生成失败');
    } finally {
      setBusy('');
    }
  }

  const normalizedUrl = settings.baseUrl.replace(/\/+$/, '');
  const ollamaHostMode =
    normalizedUrl === 'http://ollama-host.example:11434/v1'
      ? 'nas'
      : normalizedUrl === 'http://127.0.0.1:11434/v1' || normalizedUrl === 'http://127.0.0.1:11434'
        ? 'local'
        : 'custom';

  const quickModels =
    settings.provider === 'gemini'
      ? GEMINI_RECOMMENDED_MODELS
      : settings.provider === 'ollama'
        ? OLLAMA_RECOMMENDED_MODELS
        : [];

  return (
    <section className="rules-section" aria-labelledby="ai-heading">
      <div className="section-bar">
        <div className="od-cluster" style={{ '--od-gap': '10px' } as React.CSSProperties}>
          <h2 id="ai-heading" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
            AI 策展与乐评引擎
          </h2>
          <span className={`badge ${savedSettings.enabled ? 'badge-pass' : 'badge-excluded'}`}>
            {savedSettings.enabled ? '已启用' : '未启用'}
          </span>
        </div>
        <span className="mono-num field-hint">
          {savedSettings.enabled ? formatActiveEngineSummary(savedSettings) : '规则模式（未启用 AI）'}
        </span>
      </div>

      {/* Unmistakable Current Active vs Unsaved Draft Status Banner */}
      <div className={`ai-active-banner ${savedSettings.enabled ? 'is-enabled' : 'is-off'} ${isDirty ? 'is-dirty' : ''}`}>
        <div className="od-row" style={{ '--od-gap': '8px', flexWrap: 'wrap' } as React.CSSProperties}>
          <span className={`status-dot ${savedSettings.enabled ? '' : 'is-offline'}`} aria-hidden="true" />
          <strong style={{ fontSize: 'var(--text-sm)' }}>当前正在使用的分析引擎：</strong>
          <span className="mono-num" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-primary)' }}>
            {formatActiveEngineSummary(savedSettings)}
          </span>
        </div>
        {isDirty ? (
          <span className="badge badge-watch">草稿未保存：当前编辑的是「{PROVIDER_META[settings.provider].title}」，点击下方「保存配置」后生效</span>
        ) : (
          <span className="field-hint">乐评生成、品味画像与月度歌单导语均以此引擎运行</span>
        )}
      </div>

      <div className="od-stack" style={{ '--od-gap': '16px' } as React.CSSProperties}>
        {/* Step 1: 3 Clear Engine Cards */}
        <div className="od-field" style={{ '--od-gap': '8px' } as React.CSSProperties}>
          <span className="field-label">第一步：选择 AI 模型引擎</span>
          <div className="ai-engine-cards" role="radiogroup" aria-label="选择 AI 模型引擎">
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
                  className={`ai-engine-card ${isSelected ? 'is-selected' : ''} ${isLive ? 'is-live' : ''}`}
                  onClick={() => switchProvider(kind)}
                >
                  <div className="od-row" style={{ justifyContent: 'space-between', width: '100%' }}>
                    <span className="od-row" style={{ '--od-gap': '6px', fontWeight: 600, fontSize: 'var(--text-sm)' } as React.CSSProperties}>
                      {kind === 'ollama' ? <Cpu size={15} /> : kind === 'gemini' ? <Sparkles size={15} /> : <Bot size={15} />}
                      <span>{meta.title}</span>
                    </span>
                    {isLive ? (
                      <span className="badge badge-pass">当前生效</span>
                    ) : isSelected ? (
                      <span className="badge badge-split">正在配置</span>
                    ) : null}
                  </div>
                  <p className="ai-engine-card-sub">{meta.subtitle}</p>
                </button>
              );
            })}
          </div>
        </div>

        <form onSubmit={(e) => void save(e)} className="od-stack" style={{ '--od-gap': '16px' } as React.CSSProperties}>
          {settings.provider === 'ollama' && (
            <div className="od-field" style={{ '--od-gap': '6px' } as React.CSSProperties}>
              <span className="field-hint">Ollama 连接方式：</span>
              <div className="ai-preset-bar">
                <button
                  type="button"
                  className={`ai-preset-btn ${ollamaHostMode === 'local' ? 'is-active' : ''}`}
                  onClick={() => setSettings({ ...settings, baseUrl: 'http://127.0.0.1:11434/v1' })}
                >
                  <Cpu size={13} />
                  <span>本机 Ollama (127.0.0.1:11434)</span>
                </button>
                <button
                  type="button"
                  className={`ai-preset-btn ${ollamaHostMode === 'nas' ? 'is-active' : ''}`}
                  onClick={() => setSettings({ ...settings, baseUrl: 'http://ollama-host.example:11434/v1' })}
                >
                  <Cpu size={13} />
                  <span>另一台设备（填写实际地址）</span>
                </button>
              </div>
            </div>
          )}

          <div className="ai-toggles-strip">
            <label className="toggle-wrap">
              <input
                type="checkbox"
                className="toggle-input"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
              />
              <span>启用「{PROVIDER_META[settings.provider].title}」参与策展与乐评</span>
            </label>
            <label className="toggle-wrap">
              <input
                type="checkbox"
                className="toggle-input"
                checked={settings.autoReviewSelected}
                onChange={(e) => setSettings({ ...settings, autoReviewSelected: e.target.checked })}
              />
              <span>新专辑入选后自动后台生成乐评</span>
            </label>
          </div>

          <div className="ai-config-grid">
            <label className="form-field" style={{ gridColumn: 'span 2' }}>
              <span className="field-label">
                {settings.provider === 'gemini' ? 'Gemini API 地址（默认官方无需修改）' : '接口地址 (Base URL)'}
              </span>
              <input
                required
                className="input-control mono-num"
                value={settings.baseUrl}
                onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                placeholder={PROVIDER_META[settings.provider].defaultUrl}
              />
            </label>

            <label className="form-field">
              <span className="field-label">模型名称</span>
              <input
                required
                className="input-control mono-num"
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                placeholder={PROVIDER_META[settings.provider].defaultModel}
              />
            </label>

            <div className="form-field" style={{ gridColumn: 'span 2' }}>
              <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', '--od-gap': '6px' } as React.CSSProperties}>
                <label className="field-label" htmlFor="ai-apikey-input">
                  <span className="od-row" style={{ '--od-gap': '5px' } as React.CSSProperties}>
                    <KeyRound size={12} />
                    <span>
                      {settings.provider === 'gemini'
                        ? 'Gemini API Key'
                        : settings.provider === 'ollama'
                          ? 'API Key（本地 Ollama 无需填写）'
                          : 'API Key'}
                    </span>
                  </span>
                </label>
                {settings.hasApiKey && (
                  <label className="od-row" style={{ '--od-gap': '6px', fontSize: 'var(--text-xs)', color: 'var(--ink-secondary)', cursor: 'pointer' } as React.CSSProperties}>
                    <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} />
                    <span>清除密钥</span>
                  </label>
                )}
              </div>
              <input
                id="ai-apikey-input"
                type="password"
                className="input-control mono-num"
                autoComplete="off"
                disabled={clearApiKey}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  settings.hasApiKey
                    ? '已保存密钥（留空保留）'
                    : settings.provider === 'gemini'
                      ? 'AIza...'
                      : settings.provider === 'ollama'
                        ? '留空即可'
                        : 'sk-...'
                }
              />
            </div>

            <label className="form-field">
              <span className="field-label">超时时间（毫秒）</span>
              <input
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
          </div>

          {quickModels.length > 0 && (
            <div className="od-field" style={{ '--od-gap': '6px' } as React.CSSProperties}>
              <span className="field-hint">
                {settings.provider === 'gemini' ? '推荐 Gemini 模型：' : '推荐本机 Ollama 模型（`qwen3.6` 实测综合最佳）：'}
              </span>
              <div className="model-chip-list" role="group" aria-label="推荐模型">
                {quickModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`model-chip ${settings.model === m ? 'is-active' : ''}`}
                    onClick={() => setSettings({ ...settings, model: m })}
                  >
                    {settings.provider === 'gemini' ? <Sparkles size={12} /> : <Bot size={12} />}
                    <span>{m}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {checkResult && (
            checkResult.ok ? (
              <div className="model-discovery-box" role="status">
                <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', '--od-gap': '8px' } as React.CSSProperties}>
                  <strong style={{ fontSize: 'var(--text-xs)', color: 'var(--ok-ink)' }}>连接正常</strong>
                  <span className="mono-num field-hint">
                    {checkResult.models.length ? `发现 ${checkResult.models.length} 个模型` : checkResult.message}
                  </span>
                </div>
                {checkResult.models.length > 0 && (
                  <div className="model-chip-list" role="group" aria-label="已发现模型">
                    {checkResult.models.slice(0, 16).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`model-chip ${settings.model === m ? 'is-active' : ''}`}
                        onClick={() => setSettings({ ...settings, model: m })}
                      >
                        <Bot size={12} />
                        <span>{m}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="inline-note" role="status" style={{ margin: 0 }}>
                <strong>连接失败：</strong>
                {checkResult.message}
              </div>
            )
          )}

          <div
            className="od-row"
            style={{
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              '--od-gap': '10px',
              paddingTop: '12px',
              borderTop: '1px solid var(--line-subtle)'
            } as React.CSSProperties}
          >
            <div className="od-cluster" style={{ '--od-gap': '8px' } as React.CSSProperties}>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy}>
                {busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                <span>{isDirty ? '保存并切换引擎' : '保存配置'}</span>
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void testConnection()}>
                {busy === 'check' ? <LoaderCircle size={14} className="spin" /> : <Radio size={14} />}
                <span>测试连接</span>
              </button>
            </div>
            <button
              type="button"
              className="btn btn-ink btn-sm"
              disabled={!!busy || !savedSettings.enabled}
              onClick={() => void generateSelectedReviews()}
            >
              {busy === 'batch' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
              <span>用当前引擎补全乐评</span>
            </button>
          </div>
        </form>

        {error && (
          <div className="banner error" role="alert" style={{ marginBottom: 0 }}>
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="banner success" role="status" style={{ marginBottom: 0 }}>
            <Check size={15} />
            <span>{notice}</span>
          </div>
        )}
      </div>
    </section>
  );
}
