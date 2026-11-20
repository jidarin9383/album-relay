import { useState } from 'react';
import { ChevronDown, ChevronUp, EyeOff, RotateCcw } from 'lucide-react';
import { sanitizeReviewSnippets } from '../shared/review-evidence';
import type { Album, ListeningStatus } from '../shared/types';
import { AlbumAiReviewBlock, ListenPlatformBar, SourceReviewLinks } from './AlbumActions';

interface Props {
  album: Album;
  slotType?: 'preference' | 'exploration';
  reason?: string;
  aiEnabled?: boolean;
  busyKey?: string | null;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onAlbumUpdated: (album: Album) => void;
  onStatus: (album: Album, status: ListeningStatus) => void;
  onToggleExclude: (album: Album) => void;
}

const FEEDBACK_BUTTONS: { id: ListeningStatus; label: string }[] = [
  { id: 'liked', label: '喜欢' },
  { id: 'saved', label: '想听' },
  { id: 'listened', label: '已听' }
];

function AlbumCover({ album }: { album: Album }) {
  const src = album.coverUrl || `/api/albums/${encodeURIComponent(album.id)}/cover`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className="sleeve-box clean-card-cover">
      {failedSrc !== src ? (
        <img
          loading="lazy"
          referrerPolicy="no-referrer"
          className="cover-img-fill"
          src={src}
          alt={`${album.artist}《${album.title}》封面`}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <div className="bespoke-cover" style={{ padding: '10px' }}>
          <span className="bespoke-cover-title" style={{ fontSize: '0.88rem', lineHeight: 1.2 }}>
            {album.artist}
          </span>
        </div>
      )}
    </div>
  );
}

export function AlbumCard({
  album,
  slotType,
  reason,
  aiEnabled = false,
  busyKey,
  request,
  onAlbumUpdated,
  onStatus,
  onToggleExclude
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const currentStatus = album.listeningStatus ?? 'unheard';
  const isHidden = album.excluded || currentStatus === 'disliked' || currentStatus === 'skipped';
  const snippets = album.sources.flatMap((s) =>
    sanitizeReviewSnippets(s.reviewSnippets, s.source).map((r) => ({ source: s.source, ...r }))
  );

  return (
    <article className={`clean-album-card ${isHidden ? 'is-muted-card' : ''}`}>
      <div className="clean-card-head">
        <AlbumCover album={album} />
        <div className="clean-card-meta">
          <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
            {slotType === 'exploration' && <span className="badge badge-split">探索</span>}
            {album.admittedMonth && <span className="badge badge-pass mono-num">歌单 {album.admittedMonth}</span>}
            {album.decision?.status === 'disagreement' && !album.excluded && <span className="badge badge-watch">评分分歧</span>}
          </div>
          <h3 className="serif-title od-clamp-2" style={{ fontSize: '1.15rem' }}>
            {album.title}
          </h3>
          <div className="clean-card-artist">
            <span>{album.artist}</span>
            {album.releaseDate && <span className="mono-num"> · {album.releaseDate}</span>}
          </div>
          {album.genres.length > 0 && (
            <div className="od-cluster" style={{ '--od-gap': '4px' } as React.CSSProperties}>
              {album.genres.slice(0, 3).map((g) => (
                <span className="clean-genre-chip" key={g}>
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {album.decision?.status === 'disagreement' && !album.excluded && (
        <div className="disagreement-callout" role="note">
          <span className="disagreement-kicker">评分分歧</span>
          <span>{album.decision.reasons[0] || '各来源评分存在明显高低差异'}</span>
        </div>
      )}

      {album.aiReview?.shortReview ? (
        <AlbumAiReviewBlock album={album} aiEnabled={aiEnabled} mode="short" compact />
      ) : reason ? (
        <p className="clean-ai-quote od-clamp-2">{reason}</p>
      ) : null}

      <div className="clean-card-links-row">
        <SourceReviewLinks album={album} compact />
        <ListenPlatformBar album={album} compact />
      </div>

      <div className="clean-card-footer">
        <div className="listen-pills" role="group" aria-label="收听反馈">
          {FEEDBACK_BUTTONS.map((fb) => {
            const active = currentStatus === fb.id;
            return (
              <button
                key={fb.id}
                type="button"
                className={`listen-pill ${active ? 'is-active' : ''}`}
                disabled={busyKey === `status-${album.id}`}
                onClick={() => onStatus(album, active ? 'unheard' : fb.id)}
              >
                {fb.label}
              </button>
            );
          })}
          <button
            type="button"
            className="listen-pill"
            disabled={busyKey === `exclude-${album.id}` || busyKey === `status-${album.id}`}
            title={isHidden ? '恢复到推荐与新专列表' : '隐藏此专辑'}
            onClick={() => {
              if (album.excluded) {
                onToggleExclude(album);
              } else if (currentStatus === 'disliked' || currentStatus === 'skipped') {
                onStatus(album, 'unheard');
              } else {
                onToggleExclude(album);
              }
            }}
          >
            {isHidden ? (
              <span className="od-row" style={{ '--od-gap': '4px' } as React.CSSProperties}>
                <RotateCcw size={11} />
                <span>恢复</span>
              </span>
            ) : (
              <span className="od-row" style={{ '--od-gap': '4px' } as React.CSSProperties}>
                <EyeOff size={11} />
                <span>隐藏</span>
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span>{expanded ? '收起' : '乐评详情'}</span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <div className="clean-card-drawer">
          <div className="od-field" style={{ '--od-gap': '6px' } as React.CSSProperties}>
            <span className="field-hint">乐评原页与跨站跳转</span>
            <SourceReviewLinks album={album} showSearchFallback />
          </div>

          <AlbumAiReviewBlock
            album={album}
            aiEnabled={aiEnabled}
            mode="full"
            request={request}
            onAlbumUpdated={onAlbumUpdated}
          />

          {snippets.length > 0 && (
            <details className="scraped-quotes-details">
              <summary className="scraped-quotes-summary">
                <span>原网页评论摘录（{snippets.length} 条）</span>
                <span className="field-hint">展开</span>
              </summary>
              <div className="scraped-quotes-body">
                {snippets.slice(0, 6).map((sn, i) => (
                  <div className="quote-excerpt-item" key={i}>
                    <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', '--od-gap': '6px' } as React.CSSProperties}>
                      <span className="badge badge-excluded">
                        {sn.source.toUpperCase()} · {sn.kind === 'critic' ? sn.publication || '媒体' : sn.author || '听众'}
                      </span>
                      {sn.score != null && <span className="mono-num field-hint">评分 {sn.score}</span>}
                    </div>
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-primary)', lineHeight: 1.62 }}>{sn.text}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </article>
  );
}
