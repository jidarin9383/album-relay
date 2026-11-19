import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Search } from 'lucide-react';
import type { CaptureReceipt, SourceName } from '../shared/types';

interface Props {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
  onCaptured(): Promise<void>;
}

const sourceList = ['rym', 'aoty', 'pitchfork'] as const;
const label = (source: string) => (source === 'rym' ? 'RYM' : source === 'aoty' ? 'AOTY' : 'Pitchfork');
const names: Record<SourceName, string> = { rym: 'Rate Your Music', aoty: 'Album of the Year', pitchfork: 'Pitchfork' };
const time = (at: string) => new Date(at).toLocaleString('zh-CN');
const chartUrl = (source: SourceName, year = new Date().getFullYear()) =>
  source === 'rym'
    ? `https://rateyourmusic.com/charts/top/album/${year}/1/`
    : source === 'aoty'
      ? `https://www.albumoftheyear.org/ratings/user-highest-rated/lp/${year}/`
      : 'https://pitchfork.com/reviews/albums/';
const searchUrl = (source: SourceName, query: string) => {
  const q = encodeURIComponent(query);
  return source === 'aoty'
    ? `https://www.albumoftheyear.org/search/?q=${q}`
    : source === 'rym'
      ? `https://www.google.com/search?q=${encodeURIComponent(`site:rateyourmusic.com/release/album ${query}`)}`
      : `https://pitchfork.com/search/?q=${q}`;
};

export function CapturePanel({ request, onCaptured }: Props) {
  const [history, setHistory] = useState<CaptureReceipt[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(() => request<CaptureReceipt[]>('/captures').then(setHistory), [request]);

  useEffect(() => {
    void load().catch(() => setError('收录记录加载失败'));
  }, [load]);

  async function merge(captureId: string, url: string) {
    setBusy('merge-' + url);
    setError('');
    try {
      await request<CaptureReceipt>(`/captures/${encodeURIComponent(captureId)}/merge`, { url });
      await load();
      await onCaptured();
    } catch (e) {
      setError(e instanceof Error ? e.message : '合并失败');
    } finally {
      setBusy('');
    }
  }

  const conflicts = history.flatMap((item) =>
    (item.conflicts ?? []).map((c) => ({ captureId: item.id, conflict: c, url: c.sources[0]?.url ?? '' }))
  );
  const trimmedQuery = query.trim();

  return (
    <div className="od-stack" style={{ '--od-gap': '14px' } as React.CSSProperties}>
      <form
        className="od-row"
        style={{ '--od-gap': '8px', flexWrap: 'wrap' } as React.CSSProperties}
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmedQuery) window.open(searchUrl('rym', trimmedQuery), '_blank', 'noopener');
        }}
      >
        <input
          type="search"
          className="input-control"
          style={{ flex: '1 1 240px' }}
          aria-label="在外部评分站搜索"
          placeholder="输入艺人或专辑名，在外部评分站打开…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
          {sourceList.map((source) => (
            <a
              key={source}
              className={`btn btn-secondary btn-sm ${trimmedQuery ? '' : 'button-disabled-link'}`}
              aria-disabled={!trimmedQuery}
              href={trimmedQuery ? searchUrl(source, trimmedQuery) : undefined}
              target="_blank"
              rel="noreferrer"
            >
              <Search size={13} />
              <span>搜 {label(source)}</span>
            </a>
          ))}
        </div>
      </form>

      <div className="od-cluster" style={{ '--od-gap': '8px' } as React.CSSProperties}>
        {sourceList.map((source) => (
          <a key={source} className="btn btn-secondary btn-sm" href={chartUrl(source)} target="_blank" rel="noreferrer">
            <span>打开 {names[source]} 榜单</span>
            <ExternalLink size={12} />
          </a>
        ))}
        <a className="btn btn-secondary btn-sm" href="https://pitchfork.com/reviews/best/albums/" target="_blank" rel="noreferrer">
          <span>Pitchfork Best New</span>
          <ExternalLink size={12} />
        </a>
      </div>

      {error && (
        <p className="inline-note" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}

      {conflicts.length > 0 && (
        <div className="od-stack" style={{ '--od-gap': '6px' } as React.CSSProperties}>
          <span className="field-hint">待确认合并的版本差异（{conflicts.length} 条）</span>
          {conflicts.map(({ captureId, conflict, url }) => (
            <div
              key={`${captureId}-${url}`}
              className="od-row"
              style={{
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                background: 'var(--warn-bg)',
                border: '1px solid var(--warn-border)',
                padding: '8px 10px',
                borderRadius: 'var(--radius-xs)',
                fontSize: 'var(--text-xs)'
              }}
            >
              <span style={{ color: 'var(--warn-ink)' }}>
                {conflict.artist} — {conflict.title}
                {conflict.releaseDate ? `（${conflict.releaseDate}）` : ''}
              </span>
              <button type="button" className="btn btn-ink btn-sm" disabled={!!busy} onClick={() => void merge(captureId, url)}>
                确认合并
              </button>
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="od-stack" style={{ '--od-gap': '6px' } as React.CSSProperties}>
          <span className="field-hint">最近收录记录</span>
          {history.slice(0, 6).map((item) => (
            <div
              key={item.id}
              className="od-row"
              style={{
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                padding: '8px 12px',
                background: 'var(--bg-canvas)',
                border: '1px solid var(--line-subtle)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--text-xs)'
              }}
            >
              <span className="mono-num">
                <strong>{label(item.source)}</strong> · {time(item.observedAt)}
              </span>
              <span className="field-hint">
                新增 {item.added} · 更新 {item.updated}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
