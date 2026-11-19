import { Fragment, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, LoaderCircle, Puzzle, Unplug } from 'lucide-react';
import type { ExtensionState, SourceName } from '../shared/types';

interface Props {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
  onChanged(): Promise<void>;
}

const label: Record<SourceName, string> = { rym: 'RYM', aoty: 'AOTY', pitchfork: 'Pitchfork' };
const stateLabel = { ok: '正常', challenge: '需要验证', error: '失败' } as const;
const time = (at?: string) =>
  at ? new Date(at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '从未';
const ONLINE_MS = 65 * 60 * 1000;
const RECOMMENDED_REFRESH_TARGETS = [
  'https://rateyourmusic.com/charts/top/album/{year}/1/',
  'https://rateyourmusic.com/charts/popular/album/{year}/1/',
  'https://rateyourmusic.com/charts/top/album/{year}/2/',
  'https://www.albumoftheyear.org/ratings/user-highest-rated/lp/{year}/',
  'https://www.albumoftheyear.org/ratings/user-highest-rated/lp/{year}/?p=2',
  'https://pitchfork.com/reviews/albums/'
];

export function ExtensionPanel({ request, onChanged }: Props) {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState('');
  const [draft, setDraft] = useState<{
    enabled: boolean;
    hour: number;
    targets: string;
    detailBackfill: boolean;
    detailBatchSize: number;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const s = await request<ExtensionState>('/extension');
    setState(s);
    setDraft(
      (d) =>
        d ?? {
          enabled: s.refresh.enabled,
          hour: s.refresh.hour,
          targets: s.refresh.targets.join('\n'),
          detailBackfill: s.refresh.detailBackfill ?? true,
          detailBatchSize: s.refresh.detailBatchSize ?? 4
        }
    );
  }, [request]);

  useEffect(() => {
    void load().catch(() => setError('扩展状态加载失败'));
    const t = window.setInterval(() => void load().catch(() => {}), 15000);
    return () => window.clearInterval(t);
  }, [load]);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy('');
    }
  }

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(''), 1500);
    } catch {
      setError('无法写入剪贴板，请手动复制');
    }
  }

  const online = Boolean(state?.lastSeen && Date.now() - new Date(state.lastSeen).getTime() < ONLINE_MS);
  const challenges = state?.reports.filter((r) => r.state === 'challenge') ?? [];

  return (
    <section className="rules-section" aria-labelledby="extension-heading">
      <div className="section-bar">
        <div className="od-cluster" style={{ '--od-gap': '10px' } as React.CSSProperties}>
          <h2 id="extension-heading" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
            Chrome 自动收录扩展
          </h2>
          <span className={`badge ${!state ? 'badge-excluded' : !state.paired ? 'badge-excluded' : online ? 'badge-pass' : 'badge-watch'}`}>
            {!state ? '检查中…' : !state.paired ? '未配对' : online ? '在线' : '已配对'}
          </span>
        </div>

        <div className="od-cluster" style={{ '--od-gap': '8px' } as React.CSSProperties}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!!busy}
            onClick={() =>
              void act('token', async () => {
                const r = await request<{ token: string }>('/extension/token', {});
                setToken(r.token);
                await load();
              })
            }
          >
            {busy === 'token' ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}
            <span>{state?.paired ? '重置配对令牌' : '生成配对令牌'}</span>
          </button>
          {state?.paired && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--danger-ink)' }}
              disabled={!!busy}
              onClick={() =>
                void act('revoke', async () => {
                  setToken('');
                  setState(await request<ExtensionState>('/extension/token', undefined, 'DELETE'));
                })
              }
            >
              <Unplug size={14} />
              <span>解除配对</span>
            </button>
          )}
        </div>
      </div>

      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-secondary)', marginBottom: 'var(--sp-4)' }}>
        配对后每天自动从你打开的 Chrome 后台采集 RYM / AOTY / Pitchfork 榜单；若站点弹出人机验证，需你在 Chrome 手动点开通过。
      </p>

      {challenges.map((r) => (
        <div className="disambig-card" role="alert" key={r.source}>
          <div className="od-row-top" style={{ '--od-gap': '10px' } as React.CSSProperties}>
            <AlertTriangle size={18} style={{ color: 'var(--warn-ink)', flexShrink: 0, marginTop: '2px' }} />
            <div className="od-field" style={{ '--od-gap': '2px' } as React.CSSProperties}>
              <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--warn-ink)' }}>
                {label[r.source]} 需要完成一次验证
              </strong>
              <span className="field-hint" style={{ color: 'var(--ink-secondary)' }}>
                请在 Chrome 打开{' '}
                <a href={r.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', fontWeight: 600 }}>
                  这个页面
                </a>{' '}
                通过验证后，系统会自动继续收录。
              </span>
            </div>
          </div>
        </div>
      ))}

      {state?.paired && state.reports.length > 0 && (
        <div className="rule-source-box" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span className="field-hint">最近在线</span>
            <strong className="mono-num" style={{ fontSize: 'var(--text-xs)' }}>
              {time(state.lastSeen)}
            </strong>
          </div>
          {state.reports.map((r) => (
            <Fragment key={r.source}>
              <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', borderTop: '1px solid var(--line-subtle)', paddingTop: '8px' }}>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{label[r.source]}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-secondary)' }}>
                  {stateLabel[r.state]} · <span className="mono-num">{time(r.at)}</span>
                </span>
              </div>
            </Fragment>
          ))}
        </div>
      )}

      {token && (
        <div className="token-code-box" role="status" style={{ marginBottom: 'var(--sp-5)' }}>
          <strong style={{ color: '#FFFFFF', fontSize: 'var(--text-sm)' }}>
            一次性令牌（关闭后不再显示）— 复制填入扩展设置页并点击「保存并连接」：
          </strong>
          <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
            <span style={{ wordBreak: 'break-all' }}>
              服务器地址：<strong>{location.origin}</strong>
            </span>
            <button type="button" className="ticker-link-btn" onClick={() => void copy('origin', location.origin)}>
              {copied === 'origin' ? <Check size={12} /> : <Copy size={12} />} {copied === 'origin' ? '已复制' : '复制地址'}
            </button>
          </div>
          <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
            <span style={{ wordBreak: 'break-all' }}>
              配对令牌：<strong>{token}</strong>
            </span>
            <button type="button" className="ticker-link-btn" onClick={() => void copy('token', token)}>
              {copied === 'token' ? <Check size={12} /> : <Copy size={12} />} {copied === 'token' ? '已复制' : '复制令牌'}
            </button>
          </div>
        </div>
      )}

      {draft && (
        <form
          style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-4)' }}
          className="od-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act('refresh', async () => {
              const targets = draft.targets
                .split('\n')
                .map((t) => t.trim())
                .filter(Boolean);
              const s = await request<ExtensionState>(
                '/extension/refresh',
                {
                  enabled: draft.enabled,
                  hour: draft.hour,
                  targets,
                  detailBackfill: draft.detailBackfill,
                  detailBatchSize: draft.detailBatchSize
                },
                'PUT'
              );
              setState(s);
              setNotice('扩展设置已保存。');
              await onChanged();
            });
          }}
        >
          <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', '--od-gap': '12px' } as React.CSSProperties}>
            <label className="toggle-wrap">
              <input
                type="checkbox"
                className="toggle-input"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              <span>每日自动巡检榜单（Chrome 开启时后台运行）</span>
            </label>

            {draft.enabled && (
              <label className="od-row" style={{ '--od-gap': '8px' } as React.CSSProperties}>
                <span className="field-hint">每日运行时间（点）</span>
                <input
                  type="number"
                  className="input-control mono-num"
                  style={{ width: '82px', padding: '5px 10px' }}
                  min={0}
                  max={23}
                  required
                  value={draft.hour}
                  onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}
                />
              </label>
            )}
          </div>

          <label className="toggle-wrap">
            <input
              type="checkbox"
              className="toggle-input"
              checked={draft.detailBackfill}
              onChange={(e) => setDraft({ ...draft, detailBackfill: e.target.checked })}
            />
            <span>自动补抓入选专辑详情页评论（为 AI 乐评补充素材）</span>
          </label>

          <details style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-3)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-secondary)' }}>
              自定义巡检榜单地址（默认已配置 RYM / AOTY / Pitchfork 当年榜单）
            </summary>
            <div className="od-stack" style={{ '--od-gap': '10px', marginTop: 'var(--sp-3)' } as React.CSSProperties}>
              <label className="form-field">
                <span className="field-label">巡检页面（每行一个，最多 6 个）</span>
                <textarea
                  rows={4}
                  className="textarea-control mono-num"
                  style={{ fontSize: 'var(--text-xs)' }}
                  value={draft.targets}
                  onChange={(e) => setDraft({ ...draft, targets: e.target.value })}
                />
                <small className="field-hint">{'{year}'} 自动替换为当年年份。</small>
              </label>
              <div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!!busy}
                  onClick={() => setDraft({ ...draft, targets: RECOMMENDED_REFRESH_TARGETS.join('\n') })}
                >
                  恢复推荐榜单（6 页）
                </button>
              </div>
            </div>
          </details>

          <div className="od-row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy}>
              {busy === 'refresh' ? <LoaderCircle size={14} className="spin" /> : <Puzzle size={14} />}
              <span>保存扩展设置</span>
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="inline-note" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <div className="banner success" role="status" style={{ marginTop: 'var(--sp-3)', marginBottom: 0 }}>
          <Check size={15} />
          <span>{notice}</span>
        </div>
      )}
    </section>
  );
}
