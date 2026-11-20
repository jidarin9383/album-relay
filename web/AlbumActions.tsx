import { useState, type ReactNode } from 'react';
import { ExternalLink, LoaderCircle, MessageSquareQuote, Sparkles } from 'lucide-react';
import { hasAlbumReviewEvidence, normalizeAiInlineText, parseLongReviewBlocks } from '../shared/review-evidence';
import type { Album, AlbumAiReview, ListenLinks, PlatformLink, SourceName } from '../shared/types';

const SOURCE_ORIGINS: Record<SourceName, string> = {
  aoty: 'https://www.albumoftheyear.org',
  rym: 'https://rateyourmusic.com',
  pitchfork: 'https://pitchfork.com'
};

const SOURCE_LABELS: Record<SourceName, string> = {
  aoty: 'AOTY',
  rym: 'RYM',
  pitchfork: 'P4K'
};

const SOURCE_DETAIL_PATTERNS: Record<SourceName, RegExp> = {
  rym: /^\/release\/(?:album|ep|comp|single|mixtape|unauth|video|djmix|additional)\/[^/]+\/[^/]+\/?$/,
  aoty: /^\/album\/\d+[^/]*\.php$/,
  pitchfork: /^\/reviews\/albums\/[^/]+\/?$/
};

export function isCanonicalDetailUrl(source: SourceName, url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.origin !== SOURCE_ORIGINS[source]) return false;
    return SOURCE_DETAIL_PATTERNS[source].test(parsed.pathname);
  } catch {
    return false;
  }
}

export function buildClientSearchUrl(source: SourceName, artist: string, title: string): string {
  const q = encodeURIComponent(`${artist} ${title}`.trim());
  if (source === 'rym') {
    return `https://www.google.com/search?q=${encodeURIComponent(`site:rateyourmusic.com/release/album "${artist}" "${title}"`)}`;
  }
  if (source === 'aoty') return `${SOURCE_ORIGINS.aoty}/search/?q=${q}`;
  return `${SOURCE_ORIGINS.pitchfork}/search/?q=${q}`;
}

export function buildFallbackListenLinks(album: Album): ListenLinks {
  const q = encodeURIComponent(`${album.artist} ${album.title}`.trim());
  return {
    netease: album.match?.originalId
      ? { url: `https://music.163.com/#/album?id=${album.match.originalId}`, direct: true, source: 'matched' }
      : { url: `https://music.163.com/#/search/m/?s=${q}&type=10`, direct: false, source: 'search' },
    spotify: album.capturedLinks?.spotify
      ? { url: album.capturedLinks.spotify, direct: true, source: 'captured' }
      : { url: `https://open.spotify.com/search/${q}/albums`, direct: false, source: 'search' },
    youtubeMusic: album.capturedLinks?.youtubeMusic
      ? { url: album.capturedLinks.youtubeMusic, direct: true, source: 'captured' }
      : { url: `https://music.youtube.com/search?q=${q}`, direct: false, source: 'search' }
  };
}

export function SourceReviewLinks({
  album,
  compact = false,
  showSearchFallback = false
}: {
  album: Album;
  compact?: boolean;
  showSearchFallback?: boolean;
}) {
  const sources: SourceName[] = ['aoty', 'rym', 'pitchfork'];
  const isDisagreement = album.decision?.status === 'disagreement';
  const highSet = new Set(isDisagreement ? album.decision?.qualifyingSources ?? [] : []);
  const lowSet = new Set(isDisagreement ? album.decision?.negativeSources ?? [] : []);

  const items = sources
    .map((source) => {
      const obs = album.sources.find((s) => s.source === source);
      const hasCanonical = Boolean(obs && isCanonicalDetailUrl(source, obs.url));
      const stanceClass = lowSet.has(source) ? 'is-low' : highSet.has(source) ? 'is-high' : '';
      const stanceMark = lowSet.has(source) ? ' ↓' : highSet.has(source) ? ' ↑' : '';
      if (obs && obs.score !== null && hasCanonical) {
        const criticPart = !compact && source === 'aoty' && obs.criticScore != null ? ` · 媒 ${obs.criticScore}` : '';
        const bnmPart = obs.bestNewMusic ? ' BNM' : '';
        return (
          <a
            key={source}
            className={`source-review-pill is-direct ${obs.status === 'error' ? 'is-stale' : ''} ${stanceClass}`.trim()}
            href={obs.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`打开 ${SOURCE_LABELS[source]} 乐评原页`}
          >
            <span>
              {SOURCE_LABELS[source]} {obs.score}
              {criticPart}
              {bnmPart}
              {stanceMark}
            </span>
            <ExternalLink size={10} />
          </a>
        );
      }
      if (obs && obs.score !== null) {
        return (
          <a
            key={source}
            className={`source-review-pill is-direct ${stanceClass}`.trim()}
            href={buildClientSearchUrl(source, album.artist, album.title)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`在 ${SOURCE_LABELS[source]} 查看《${album.title}》`}
          >
            <span>
              {SOURCE_LABELS[source]} {obs.score}
              {obs.bestNewMusic ? ' BNM' : ''}
              {stanceMark}
            </span>
            <ExternalLink size={10} />
          </a>
        );
      }
      if (!compact && showSearchFallback) {
        return (
          <a
            key={source}
            className="source-review-pill is-fallback"
            href={buildClientSearchUrl(source, album.artist, album.title)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`在 ${SOURCE_LABELS[source]} 搜索《${album.title}》`}
          >
            <span>搜 {SOURCE_LABELS[source]}</span>
            <ExternalLink size={10} />
          </a>
        );
      }
      return null;
    })
    .filter(Boolean);

  if (!items.length) return null;
  return (
    <div className={`source-review-bar ${compact ? 'is-compact' : ''}`} aria-label="来源评分">
      {items}
    </div>
  );
}

function NeteaseBrandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="platform-brand-svg" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#E60026" />
      <path
        d="M14.6 7.4c-1.8-.4-3.7.7-4.3 2.5-.5 1.4.2 3.1 1.5 3.6 1 .4 2.1-.1 2.4-1.1.3-.8-.2-1.7-1-1.9-.6-.2-1.2.2-1.4.8"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M13.3 6.2c3.2.5 5.3 3.5 4.7 6.8-.6 3.1-3.5 5.2-6.7 4.7-3.3-.5-5.5-3.6-4.9-6.9.4-2 1.7-3.7 3.5-4.4"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpotifyBrandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="platform-brand-svg" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#1DB954" />
      <path
        d="M7.2 9.6c3.2-.9 6.8-.6 9.7.9M8 12.6c2.6-.7 5.5-.5 7.9.8M8.8 15.4c2-.5 4.2-.3 6.1.6"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function YouTubeMusicBrandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="platform-brand-svg" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#FF0033" />
      <circle cx="12" cy="12" r="6.4" fill="none" stroke="#FFFFFF" strokeWidth="1.4" />
      <polygon points="10.2,9 15.6,12 10.2,15" fill="#FFFFFF" />
    </svg>
  );
}

export function ListenPlatformBar({
  album,
  compact = true
}: {
  album: Album;
  compact?: boolean;
}) {
  const links = album.listenLinks ?? buildFallbackListenLinks(album);

  // Strict platform priority order: 网易云音乐 -> Spotify -> YouTube Music
  const platforms: { key: keyof ListenLinks; label: string; link: PlatformLink; icon: ReactNode }[] = [
    { key: 'netease', label: '网易云音乐', link: links.netease, icon: <NeteaseBrandIcon /> },
    { key: 'spotify', label: 'Spotify', link: links.spotify, icon: <SpotifyBrandIcon /> },
    { key: 'youtubeMusic', label: 'YouTube Music', link: links.youtubeMusic, icon: <YouTubeMusicBrandIcon /> }
  ];

  return (
    <div
      className={`listen-platform-bar ${compact ? 'listen-platform-bar--compact' : ''}`}
      role="group"
      aria-label="在音乐平台收听"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="listen-platform-group">
        {platforms.map(({ key, label, link, icon }) => {
          const actionText = link.direct ? `在 ${label} 直接打开专辑` : `在 ${label} 搜索《${album.title}》`;
          return (
            <a
              key={key}
              className={`listen-icon-btn ${link.direct ? 'is-direct' : 'is-search'} is-${key}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={actionText}
              aria-label={actionText}
            >
              {icon}
              {link.direct && <span className="listen-direct-badge" aria-hidden="true" />}
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function AlbumAiReviewBlock({
  album,
  aiEnabled = false,
  mode,
  compact = false,
  request,
  onAlbumUpdated
}: {
  album: Album;
  aiEnabled?: boolean;
  mode: 'short' | 'full';
  compact?: boolean;
  request?: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onAlbumUpdated?: (album: Album) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const review = album.aiReview?.evidenceLevel === 'full' ? album.aiReview : null;
  const hasEvidence = hasAlbumReviewEvidence(album);
  const shortText = review?.shortReview ? normalizeAiInlineText(review.shortReview) : '';
  const audienceSummary = review?.audienceSummary ? normalizeAiInlineText(review.audienceSummary) : '';
  const criticSummary = review?.criticSummary ? normalizeAiInlineText(review.criticSummary) : '';

  if (mode === 'short') {
    if (!shortText) return null;
    return <p className={`clean-ai-quote ${compact ? 'od-clamp-2' : ''}`}>{shortText}</p>;
  }

  const generate = (force: boolean) => {
    if (!request || !hasEvidence) return;
    setBusy(true);
    setError('');
    void request<{ review: AlbumAiReview; album: Album }>(`/albums/${encodeURIComponent(album.id)}/review`, { force })
      .then((res) => onAlbumUpdated?.(res.album))
      .catch((e) => setError(e instanceof Error ? e.message : '生成乐评失败'))
      .finally(() => setBusy(false));
  };

  const blocks = review ? parseLongReviewBlocks(review.longReview) : [];
  const hasDossier = blocks.some((b) => b.label !== null);

  return (
    <div className="ai-critique-panel">
      <div className="ai-critique-header">
        <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
          <h4 className="od-row" style={{ '--od-gap': '6px', fontSize: 'var(--text-sm)' } as React.CSSProperties}>
            <MessageSquareQuote size={14} />
            <span>AI 乐评</span>
          </h4>
          {review && (
            <>
              <span className="model-pill">{review.model}</span>
              <span className="model-pill">基于原页乐评</span>
            </>
          )}
        </div>

        {request && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !hasEvidence || (!aiEnabled && !review)}
            title={!hasEvidence ? '待 Chrome 扩展补抓原页乐评或描述词后方可生成' : undefined}
            onClick={() => generate(Boolean(review))}
          >
            {busy ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
            <span>{busy ? '生成中…' : review ? '重新生成' : '生成乐评'}</span>
          </button>
        )}
      </div>

      {error && (
        <p className="inline-note" style={{ margin: 0 }}>
          {error}
        </p>
      )}

      {!review ? (
        <p className="field-hint" style={{ fontSize: 'var(--text-xs)' }}>
          {!hasEvidence
            ? '待补抓原页乐评：为避免模型编造，需等 Chrome 扩展补抓该专辑的 RYM / AOTY / Pitchfork 详情页后自动提炼。'
            : aiEnabled
              ? '已采集原页乐评素材，点击「生成乐评」基于原页内容提炼唱片档案卡。'
              : '在「设置 → AI 与高级」启用模型后，可基于原页乐评素材生成中文档案卡。'}
        </p>
      ) : (
        <>
          <div className="ai-thesis-box">{shortText}</div>
          {(audienceSummary || criticSummary) && (
            <div className="dual-perspective-grid">
              {audienceSummary && (
                <div className="perspective-card">
                  <div className="perspective-kicker">
                    <span>大众风评</span>
                    <span className="mono-num field-hint">RYM / AOTY</span>
                  </div>
                  <p className="perspective-body">{audienceSummary}</p>
                </div>
              )}
              {criticSummary && (
                <div className="perspective-card">
                  <div className="perspective-kicker">
                    <span>媒体风评</span>
                    <span className="mono-num field-hint">Pitchfork / Press</span>
                  </div>
                  <p className="perspective-body">{criticSummary}</p>
                </div>
              )}
            </div>
          )}
          {hasDossier ? (
            <div className="ai-dossier-list">
              {blocks.map((block, i) => (
                <div className="ai-dossier-item" key={i}>
                  {block.label && <span className="ai-dossier-label">{block.label}</span>}
                  <p className="ai-dossier-body">{block.body}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="ai-long-review">
              {blocks.map((block, i) => (
                <p key={i}>{block.body}</p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
