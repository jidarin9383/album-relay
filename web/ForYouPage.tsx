import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import type { PersonalOverview } from '../shared/personal';
import type { Album, ConnectionStatus, ListeningStatus, Playlist } from '../shared/types';
import { AlbumCard } from './AlbumCard';

export type NavPage = 'foryou' | 'albums' | 'playlists' | 'settings';
export type SettingsTab = 'connect' | 'taste' | 'rules' | 'advanced';

interface Props {
  albums: Album[];
  playlists: Playlist[];
  connection: ConnectionStatus | null;
  extensionPaired: boolean;
  personal: PersonalOverview | null;
  busy: string | null;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onAlbumUpdated: (album: Album) => void;
  onStatus: (album: Album, status: ListeningStatus) => void;
  onToggleExclude: (album: Album) => void;
  onPersonalUpdated: () => Promise<void>;
  go: (page: NavPage, tab?: SettingsTab) => void;
}

export function ForYouPage({
  albums,
  playlists,
  connection,
  extensionPaired,
  personal,
  busy,
  request,
  onAlbumUpdated,
  onStatus,
  onToggleExclude,
  onPersonalUpdated,
  go
}: Props) {
  const [tasteOpen, setTasteOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const autoGenAttemptedRef = useRef(false);

  const selectedAlbums = albums.filter((a) => !a.excluded && a.decision?.status === 'selected');
  const activeSelected = selectedAlbums.filter((a) => !['disliked', 'skipped'].includes(a.listeningStatus ?? 'unheard'));
  const latestSet = personal?.recommendations[0];
  const profile = personal?.profile;
  const persona = personal?.persona ?? latestSet?.persona ?? null;

  useEffect(() => {
    if (personal && (!latestSet || !latestSet.items.length) && activeSelected.length > 0 && !autoGenAttemptedRef.current) {
      autoGenAttemptedRef.current = true;
      void request('/recommendations/generate', {})
        .then(() => onPersonalUpdated())
        .catch(() => {});
    }
  }, [personal, latestSet, activeSelected.length, request, onPersonalUpdated]);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const activePlaylist = playlists.find((p) => p.month === currentMonth) ?? playlists[0] ?? null;

  const liveById = new Map(albums.map((a) => [a.id, a]));
  const weeklyItems =
    latestSet && latestSet.items.length > 0
      ? latestSet.items
          .map((item) => ({
            album: liveById.get(item.album.id) ?? item.album,
            slotType: item.slotType,
            reason: item.reasons.find((r) => !/^(?:AOTY|RYM|Pitchfork|公开口碑)/.test(r)) ?? item.reasons[0]
          }))
          .filter((x) => !x.album.excluded)
      : activeSelected.slice(0, 10).map((album) => ({
          album,
          slotType: 'preference' as const,
          reason: undefined
        }));

  const weeklyIds = new Set(weeklyItems.map((x) => x.album.id));
  const moreAlbums = activeSelected.filter((a) => !weeklyIds.has(a.id)).slice(0, 6);

  const previewTags = persona?.preferredGenres?.length
    ? persona.preferredGenres.slice(0, 4)
    : profile?.topGenres.slice(0, 4).map((g) => g.name) ?? [];
  const topArtists = profile?.topArtistsLongTerm.slice(0, 4).map((a) => a.name) ?? [];
  const hasTasteData = Boolean((profile && !profile.coldStart) || persona || topArtists.length > 0);
  const showOnboarding = !extensionPaired && selectedAlbums.length === 0;

  return (
    <>
      <div className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">为你推荐</h1>
          <p className="view-subtitle">根据跨站高分口碑与你的听歌偏好持续更新。</p>
        </div>

        <div className="od-row" style={{ '--od-gap': '10px', flexWrap: 'wrap' } as React.CSSProperties}>
          {activePlaylist ? (
            <a href={activePlaylist.url} target="_blank" rel="noreferrer" className="playlist-status-pill">
              <span className="status-dot" aria-hidden="true" />
              <span>
                歌单《{activePlaylist.name}》· {activePlaylist.albumIds.length} 张
              </span>
              <ExternalLink size={12} />
            </a>
          ) : connection?.loggedIn ? (
            <span className="playlist-status-pill">
              <span className="status-dot" aria-hidden="true" />
              <span>已连网易云 · 新专自动写入歌单</span>
            </span>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => go('settings', 'connect')}>
              <span>连接网易云自动同步歌单</span>
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      </div>

      {showOnboarding && (
        <section className="onboarding-banner" aria-label="首次使用引导">
          <div className="od-stack" style={{ '--od-gap': '6px', maxWidth: '640px' } as React.CSSProperties}>
            <h2 className="cjk-heading" style={{ fontSize: 'var(--text-h3)' }}>
              配置一次，之后自动为你挑选高分新专
            </h2>
            <p className="field-hint" style={{ fontSize: 'var(--text-sm)' }}>
              配对 Chrome 自动收录扩展、导入一次听歌记录，再扫码连接网易云，日常只需回来听歌。
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => go('settings', 'connect')}>
            <span>开始配置</span>
            <ArrowRight size={15} />
          </button>
        </section>
      )}

      {/* Collapsed-by-default Taste Summary Card (Display Only) */}
      <section className="taste-strip-card" aria-label="我的口味">
        <div className="taste-strip-bar">
          <div className="od-cluster" style={{ '--od-gap': '10px', flex: '1 1 auto' } as React.CSSProperties}>
            <span className="taste-strip-title">
              <Sparkles size={14} style={{ color: 'var(--accent)' }} />
              <span>我的口味</span>
            </span>

            {hasTasteData ? (
              <>
                {previewTags.map((tag) => (
                  <span className="clean-genre-chip" key={tag}>
                    {tag}
                  </span>
                ))}
                {topArtists.length > 0 && (
                  <span className="field-hint" style={{ fontSize: 'var(--text-xs)' }}>
                    常听 {topArtists.slice(0, 3).join('、')}
                    {topArtists.length > 3 ? ' 等' : ''}
                  </span>
                )}
              </>
            ) : (
              <span className="field-hint" style={{ fontSize: 'var(--text-xs)' }}>
                暂未导入常听记录，当前优先展示各站高分共识新专
              </span>
            )}
          </div>

          <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => go('settings', 'taste')}>
              管理偏好
            </button>
            {hasTasteData && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-expanded={tasteOpen}
                onClick={() => setTasteOpen((v) => !v)}
              >
                <span>{tasteOpen ? '收起' : '展开'}</span>
                {tasteOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            )}
          </div>
        </div>

        {tasteOpen && hasTasteData && (
          <div className="taste-strip-body">
            {persona?.summary && (
              <p style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--ink-primary)' }}>{persona.summary}</p>
            )}

            <div className="taste-strip-grid">
              {persona && persona.sonicSignatures.length > 0 && (
                <div className="taste-strip-col">
                  <span className="field-hint">声音质感</span>
                  <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
                    {persona.sonicSignatures.map((s) => (
                      <span className="sonic-chip" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {(persona?.preferredGenres.length || profile?.topGenres.length) ? (
                <div className="taste-strip-col">
                  <span className="field-hint">偏爱流派</span>
                  <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
                    {(persona?.preferredGenres.length
                      ? persona.preferredGenres
                      : profile!.topGenres.slice(0, 8).map((g) => g.name)
                    ).map((g) => (
                      <span className="badge badge-pass" key={g}>
                        {g}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {profile && profile.topArtistsLongTerm.length > 0 && (
                <div className="taste-strip-col">
                  <span className="field-hint">常听艺人</span>
                  <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
                    {profile.topArtistsLongTerm.slice(0, 8).map((a) => (
                      <span className="clean-genre-chip" key={a.key}>
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {persona && persona.explorationAngles.length > 0 && (
                <div className="taste-strip-col">
                  <span className="field-hint">探索方向</span>
                  <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
                    {persona.explorationAngles.map((ang) => (
                      <span className="badge badge-split" key={ang}>
                        {ang}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Weekly Picks */}
      <section aria-labelledby="weekly-picks-heading" style={{ marginBottom: 'var(--sp-10)' }}>
        <div className="section-bar">
          <h2 id="weekly-picks-heading" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
            本周精选
          </h2>
          {activeSelected.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={refreshing || !!busy}
              onClick={() => {
                setRefreshing(true);
                void request('/recommendations/generate', {})
                  .then(() => onPersonalUpdated())
                  .finally(() => setRefreshing(false));
              }}
            >
              <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />
              <span>{refreshing ? '更新中…' : '换一批'}</span>
            </button>
          )}
        </div>

        {weeklyItems.length > 0 ? (
          <div className="clean-card-grid">
            {weeklyItems.map(({ album, slotType, reason }) => (
              <AlbumCard
                key={album.id}
                album={album}
                slotType={slotType}
                reason={reason}
                aiEnabled={personal?.aiEnabled}
                busyKey={busy}
                request={request}
                onAlbumUpdated={onAlbumUpdated}
                onStatus={onStatus}
                onToggleExclude={onToggleExclude}
              />
            ))}
          </div>
        ) : !showOnboarding ? (
          <div className="editorial-panel" style={{ textAlign: 'center', padding: 'var(--sp-8)' }}>
            <p className="field-hint" style={{ fontSize: 'var(--text-sm)', marginBottom: '12px' }}>
              暂无新的待听高分新专，浏览或等待 Chrome 扩展每日自动巡检后会自动更新。
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => go('albums')}>
              <span>查看全部新专</span>
              <ArrowRight size={13} />
            </button>
          </div>
        ) : null}
      </section>

      {moreAlbums.length > 0 && (
        <section aria-labelledby="more-albums-heading">
          <div className="section-bar">
            <h2 id="more-albums-heading" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
              更多入选新专
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => go('albums')}>
              <span>查看全部（{selectedAlbums.length}）</span>
              <ArrowRight size={14} />
            </button>
          </div>

          <div className="clean-card-grid">
            {moreAlbums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                aiEnabled={personal?.aiEnabled}
                busyKey={busy}
                request={request}
                onAlbumUpdated={onAlbumUpdated}
                onStatus={onStatus}
                onToggleExclude={onToggleExclude}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
