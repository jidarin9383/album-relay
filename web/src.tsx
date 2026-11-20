import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Disc3,
  ExternalLink,
  Library,
  ListMusic,
  LoaderCircle,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X
} from 'lucide-react';
import type { PersonalOverview } from '../shared/personal';
import type {
  AiSettings,
  Album,
  ConnectionStatus,
  ExtensionState,
  ListeningStatus,
  MonthlyAiDraft,
  Playlist,
  Run,
  Settings,
  SourceName,
  SourceStatus
} from '../shared/types';
import './style.css';
import { AlbumCard } from './AlbumCard';
import { ForYouPage, type NavPage, type SettingsTab } from './ForYouPage';
import { SettingsPage } from './SettingsPage';

const editionPalettes = [
  'linear-gradient(150deg, #181A20 0%, #2C1917 65%, #8F2515 100%)',
  'linear-gradient(150deg, #12161F 0%, #1E293B 70%, #334155 100%)',
  'linear-gradient(150deg, #161816 0%, #1F2E26 70%, #2B4738 100%)'
];

const sourceShort: Record<SourceName, string> = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'Pitchfork' };
const activeRun = (run: Run) => ['queued', 'running'].includes(run.status);
const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

function Empty({
  title,
  children,
  action
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="editorial-panel" style={{ textAlign: 'center', padding: 'var(--sp-10)' }}>
      <div className="od-stack" style={{ '--od-gap': '12px', alignItems: 'center' } as React.CSSProperties}>
        <div
          style={{
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            background: 'var(--bg-subtle)',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--ink-tertiary)'
          }}
        >
          <Disc3 size={24} />
        </div>
        <h3 className="cjk-heading" style={{ fontSize: 'var(--text-h3)' }}>
          {title}
        </h3>
        <p className="field-hint" style={{ maxWidth: '420px', fontSize: 'var(--text-sm)' }}>
          {children}
        </p>
        {action && <div style={{ marginTop: '4px' }}>{action}</div>}
      </div>
    </div>
  );
}

function BrandEmblem() {
  return (
    <svg className="brand-emblem" width="36" height="36" viewBox="0 0 36 36" fill="none" role="img" aria-label="听点好的标志">
      <rect width="36" height="36" rx="7" fill="#121316" />
      <circle cx="18" cy="18" r="12.5" stroke="#F5F5F3" strokeOpacity="0.26" strokeWidth="1" />
      <circle cx="18" cy="18" r="9.5" stroke="#F5F5F3" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="3 2" />
      <circle cx="18" cy="18" r="5.2" fill="#D6361F" />
      <circle cx="18" cy="18" r="1.7" fill="#F6F6F4" />
      <path d="M27.5 8.5L23 16" stroke="#F5F5F3" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function App() {
  const [session, setSession] = useState<{ authenticated: boolean; setupRequired: boolean } | null>(null);
  const [page, setPage] = useState<NavPage>('foryou');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connect');

  const [albums, setAlbums] = useState<Album[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[]>([]);
  const [extensionState, setExtensionState] = useState<ExtensionState | null>(null);
  const [personal, setPersonal] = useState<PersonalOverview | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [monthlyDraft, setMonthlyDraft] = useState<MonthlyAiDraft | null>(null);

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const navigate = useCallback((nextPage: NavPage, nextTab?: SettingsTab) => {
    setPage(nextPage);
    if (nextTab) setSettingsTab(nextTab);
    setMobileMenu(false);
  }, []);

  const loadPersonal = useCallback(async () => {
    const p = await api<PersonalOverview>('/personal/overview');
    setPersonal(p);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, s, r, p, c, ss, ext, pers, aiRes, draftRes] = await Promise.all([
        api<Album[]>('/albums'),
        api<Settings>('/settings'),
        api<Run[]>('/runs'),
        api<Playlist[]>('/playlists'),
        api<ConnectionStatus>('/connection'),
        api<SourceStatus[]>('/sources'),
        api<ExtensionState>('/extension'),
        api<PersonalOverview>('/personal/overview'),
        api<{ settings: AiSettings }>('/ai'),
        api<{ draft: MonthlyAiDraft | null }>('/playlists/draft')
      ]);
      setAlbums(a);
      setSettings(s);
      setRuns(r);
      setPlaylists(p);
      setConnection(c);
      setSourceStatuses(ss);
      setExtensionState(ext);
      setPersonal(pers);
      setAiSettings(aiRes.settings);
      setMonthlyDraft(draftRes.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateAlbumInState = useCallback((updated: Album) => {
    setAlbums((current) => current.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  useEffect(() => {
    api<{ authenticated: boolean; setupRequired: boolean }>('/session')
      .then(setSession)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [session?.authenticated, load]);

  const running = runs.find(activeRun);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api<Run>(`/runs/${running.id}`);
        setRuns((current) => current.map((r) => (r.id === next.id ? next : r)));
        if (!activeRun(next)) {
          void load();
          if (next.mode === 'auto_sync' && next.status === 'succeeded') {
            setNotice(next.message || '当月歌单已同步。');
          }
        }
      } catch (e) {
        setError((e as Error).message);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [running?.id, load]);

  useEffect(() => {
    if (connection?.loginState !== 'waiting') return;
    const timer = window.setInterval(() => {
      api<ConnectionStatus>('/connection/check', {})
        .then(setConnection)
        .catch((e) => setError((e as Error).message));
    }, 3000);
    return () => clearInterval(timer);
  }, [connection?.loginState]);

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleStatus = (album: Album, listeningStatus: ListeningStatus) => {
    void runAction(`status-${album.id}`, async () => {
      const updated = await api<Album>(`/albums/${encodeURIComponent(album.id)}/status`, { listeningStatus });
      updateAlbumInState(updated);
      void loadPersonal();
    });
  };

  const handleToggleExclude = (album: Album) => {
    void runAction(`exclude-${album.id}`, async () => {
      const updated = await api<Album>(`/albums/${encodeURIComponent(album.id)}/exclude`, {
        excluded: !album.excluded
      });
      updateAlbumInState(updated);
      void loadPersonal();
    });
  };

  const handleSyncNow = () => {
    void runAction('auto_sync', async () => {
      const run = await api<Run>('/runs', { mode: 'auto_sync' });
      setRuns((current) => [run, ...current.filter((r) => r.id !== run.id)]);
      setNotice('已开始同步当月网易云歌单，请稍候…');
      if (!activeRun(run)) await load();
    });
  };

  const handlePreviewMonthlyAi = () => {
    void runAction('preview-monthly-ai', async () => {
      const res = await api<{ draft: MonthlyAiDraft }>('/playlists/preview-ai', {});
      setMonthlyDraft(res.draft);
      setNotice('已生成本月 AI 选单把关与连贯简介预览（尚未写入网易云）。');
    });
  };

  const selectedCount = albums.filter((a) => !a.excluded && a.decision?.status === 'selected').length;
  const blockedSources = sourceStatuses.filter((s) => s.status === 'blocked');
  const blockedChallenges = extensionState?.reports.filter((r) => r.state === 'challenge') ?? [];

  const mainNav = [
    { id: 'foryou', label: '为你推荐', icon: Sparkles, count: undefined },
    { id: 'albums', label: '全部新专', icon: Library, count: selectedCount || undefined },
    { id: 'playlists', label: '月度歌单', icon: ListMusic, count: playlists.length || undefined }
  ] as const;

  const pageLabels: Record<NavPage, string> = {
    foryou: '为你推荐',
    albums: '全部新专',
    playlists: '月度歌单',
    settings: '设置'
  };

  if (!session || !session.authenticated) {
    return (
      <Auth
        session={session}
        error={error}
        onSuccess={() => {
          setError('');
          void api<{ authenticated: boolean; setupRequired: boolean }>('/session').then(setSession);
        }}
      />
    );
  }

  return (
    <div className={`app-shell ${railCollapsed ? 'is-rail-collapsed' : ''}`}>
      <a href="#main-workspace" className="skip-link">
        跳至主内容
      </a>

      {mobileMenu && <div className="mobile-scrim" aria-hidden="true" onClick={() => setMobileMenu(false)} />}

      <aside className={`nav-rail ${mobileMenu ? 'is-mobile-open' : ''}`} aria-label="主导航">
        <div className="rail-brand">
          <a
            className="brand-lockup"
            href="#foryou"
            onClick={(e) => {
              e.preventDefault();
              navigate('foryou');
            }}
          >
            <BrandEmblem />
            <div className="brand-titles">
              <strong className="brand-cn">听点好的</strong>
              <span className="brand-en">LISTEN BETTER</span>
            </div>
          </a>
          <button
            type="button"
            className="rail-collapse-btn"
            aria-label={railCollapsed ? '展开导航' : '收起导航'}
            title={railCollapsed ? '展开导航' : '收起导航'}
            onClick={() => setRailCollapsed((v) => !v)}
          >
            {railCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <ul className="nav-list">
          {mainNav.map((item) => {
            const isSelected = page === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`nav-btn ${isSelected ? 'is-active' : ''}`}
                  aria-current={isSelected ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                >
                  <span className="nav-btn-main">
                    <item.icon size={17} />
                    <span className="nav-btn-label">{item.label}</span>
                  </span>
                  {item.count !== undefined && <span className="nav-count">{item.count}</span>}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="rail-footer">
          <button
            type="button"
            className={`nav-btn ${page === 'settings' ? 'is-active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => navigate('settings')}
          >
            <span className="nav-btn-main">
              <SlidersHorizontal size={17} />
              <span className="nav-btn-label">设置</span>
            </span>
          </button>

          <div className="rail-status-stack" aria-label="系统连接状态">
            <button
              type="button"
              className={`rail-status-pill ${connection?.loggedIn ? '' : 'is-muted-pill'}`}
              title={connection?.loggedIn ? '网易云音乐已连接 · 点击管理同步设置' : '网易云音乐未连接 · 点击前往「连接与同步」'}
              onClick={() => navigate('settings', 'connect')}
            >
              <span className={`status-dot ${connection?.loggedIn ? '' : 'is-offline'}`} aria-hidden="true" />
              <span className="rail-status-copy">
                <span className="rail-status-primary">{connection?.loggedIn ? '网易云已连接' : '网易云未连接'}</span>
              </span>
            </button>

            <button
              type="button"
              className={`rail-status-pill ${aiSettings?.enabled ? 'is-current-surface' : 'is-muted-pill'}`}
              title={
                aiSettings?.enabled
                  ? `AI 引擎运行中：${aiSettings.provider === 'gemini' ? 'Google Gemini' : aiSettings.provider === 'ollama' ? 'Ollama 本地' : 'OpenAI 兼容'} · ${aiSettings.model}`
                  : 'AI 策展与乐评当前未启用 · 点击前往配置'
              }
              onClick={() => navigate('settings', 'advanced')}
            >
              <span className={`status-dot ${aiSettings?.enabled ? '' : 'is-idle'}`} aria-hidden="true" />
              <span className="rail-status-copy">
                {aiSettings?.enabled ? (
                  <>
                    <span className="rail-status-primary">
                      {aiSettings.provider === 'gemini' ? 'Gemini' : aiSettings.provider === 'ollama' ? 'Ollama' : 'OpenAI'}
                    </span>
                    <span className="rail-status-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="rail-status-model">{aiSettings.model}</span>
                  </>
                ) : (
                  <span className="rail-status-primary">AI 乐评未启用</span>
                )}
              </span>
            </button>
          </div>

          <button
            type="button"
            className="rail-logout-btn"
            onClick={() =>
              void runAction('logout', async () => {
                await api('/logout', {});
                setSession({ authenticated: false, setupRequired: false });
              })
            }
          >
            <LogOut size={15} />
            <span className="logout-label">退出登录</span>
          </button>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="mobile-top-bar">
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label="打开导航"
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            <Menu size={18} />
          </button>
          <span className="breadcrumb-current">{pageLabels[page]}</span>
        </header>

        <main id="main-workspace" className="page-content" tabIndex={-1}>
          {(blockedSources.length > 0 || blockedChallenges.length > 0) && (
            <div className="challenge-strip" role="alert">
              <AlertTriangle size={16} style={{ flexShrink: 0 }} />
              <span style={{ flex: '1 1 auto' }}>
                {(blockedChallenges.length > 0 ? blockedChallenges : blockedSources)
                  .map((s) => `${sourceShort[s.source]} 需要完成一次验证`)
                  .join(' · ')}
              </span>
              {blockedChallenges[0]?.url ? (
                <a className="btn btn-secondary btn-sm" href={blockedChallenges[0].url} target="_blank" rel="noreferrer">
                  前往验证 <ExternalLink size={12} />
                </a>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('settings', 'connect')}>
                  查看详情
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button type="button" className="banner-close" aria-label="关闭提示" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}

          {notice && (
            <div className="banner success" role="status">
              <Check size={16} />
              <span>{notice}</span>
              <button type="button" className="banner-close" aria-label="关闭提示" onClick={() => setNotice('')}>
                <X size={16} />
              </button>
            </div>
          )}

          {loading && !albums.length && !personal ? (
            <div className="page-loading">
              <Spinner />
              <span>正在加载…</span>
            </div>
          ) : (
            <>
              {page === 'foryou' && (
                <ForYouPage
                  albums={albums}
                  playlists={playlists}
                  connection={connection}
                  extensionPaired={Boolean(extensionState?.paired)}
                  personal={personal}
                  busy={busy}
                  request={api}
                  onAlbumUpdated={updateAlbumInState}
                  onStatus={handleStatus}
                  onToggleExclude={handleToggleExclude}
                  onPersonalUpdated={loadPersonal}
                  go={navigate}
                />
              )}

              {page === 'albums' && (
                <AlbumsPage
                  albums={albums}
                  aiEnabled={Boolean(personal?.aiEnabled)}
                  busy={busy}
                  request={api}
                  onAlbumUpdated={updateAlbumInState}
                  onStatus={handleStatus}
                  onToggleExclude={handleToggleExclude}
                />
              )}

              {page === 'playlists' && (
                <PlaylistsPage
                  playlists={playlists}
                  settings={settings}
                  aiSettings={aiSettings}
                  draft={monthlyDraft}
                  loggedIn={Boolean(connection?.loggedIn)}
                  busy={busy === 'auto_sync' || Boolean(running)}
                  previewBusy={busy === 'preview-monthly-ai'}
                  onPreviewAi={handlePreviewMonthlyAi}
                  onSyncNow={handleSyncNow}
                  goSettings={(tab) => navigate('settings', tab)}
                />
              )}

              {page === 'settings' && (
                <SettingsPage
                  tab={settingsTab}
                  onTabChange={setSettingsTab}
                  settings={settings}
                  connection={connection}
                  personal={personal}
                  runs={runs}
                  busy={busy}
                  request={api}
                  onSaveSettings={async (next) => {
                    const saved = await api<Settings>('/settings', next, 'PUT');
                    setSettings(saved);
                    await load();
                  }}
                  onSyncNow={handleSyncNow}
                  onAiSaved={(nextAi) => {
                    setAiSettings(nextAi);
                    setPersonal((cur) => (cur ? { ...cur, aiEnabled: nextAi.enabled } : cur));
                  }}
                  onPersonalUpdated={loadPersonal}
                  onDataUpdated={load}
                  setConnection={setConnection}
                  notify={(msg) => {
                    setError('');
                    setNotice(msg);
                  }}
                  reportError={setError}
                />
              )}
            </>
          )}

          <footer className="page-footer">
            <span>听点好的 · Listen Better</span>
            <span>不迎合热歌榜，给挑剔耳朵的严肃新专策展。</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Auth({
  session,
  error: initialError,
  onSuccess
}: {
  session: { authenticated: boolean; setupRequired: boolean } | null;
  error: string;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isSetup = Boolean(session?.setupRequired);

  return (
    <section className="auth-split-screen" aria-label="登录与初始化">
      <div className="auth-hero-pane">
        <div className="od-field" style={{ '--od-gap': '4px' } as React.CSSProperties}>
          <span className="eyebrow" style={{ color: 'var(--ink-on-dark-muted)' }}>
            听点好的 · LISTEN BETTER
          </span>
        </div>

        <div className="auth-turntable-wrap">
          <div className="hero-vinyl-platter" role="img" aria-label="黑胶唱片视觉">
            <div className="hero-vinyl-label">
              <span className="vinyl-label-rpm">33⅓ RPM · STEREO</span>
              <strong style={{ fontFamily: 'var(--font-serif)', fontSize: '0.95rem', letterSpacing: '0.03em', lineHeight: 1.1 }}>
                LISTEN
                <br />
                BETTER
              </strong>
            </div>
          </div>
        </div>

        <div className="od-stack" style={{ '--od-gap': '10px' } as React.CSSProperties}>
          <h1 className="auth-tagline-cn">不迎合热歌，只听点好的</h1>
          <p style={{ color: 'var(--ink-on-dark-muted)', fontSize: 'var(--text-body)' }}>
            聚合 AOTY、RYM 与 Pitchfork 严肃乐评，结合 AI 与你的个人品味筛选独立新专，自动同步网易云月度歌单。
          </p>
        </div>
      </div>

      <div className="auth-form-pane">
        <div />
        <div className="auth-card">
          <form
            className="od-stack"
            style={{ '--od-gap': '18px' } as React.CSSProperties}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api(isSetup ? '/setup' : '/login', { password });
                onSuccess();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="od-stack" style={{ '--od-gap': '8px' } as React.CSSProperties}>
              <h2 className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
                {isSetup ? '初始化「听点好的」' : '欢迎回到「听点好的」'}
              </h2>
              <p className="field-hint" style={{ fontSize: 'var(--text-sm)' }}>
                {isSetup ? '设置至少 12 位管理员密码，开始自动收录与精选。' : '输入管理员密码，查看你的最新高分推荐。'}
              </p>
            </div>

            {(error || initialError) && (
              <div className="banner error" role="alert" style={{ marginBottom: 0 }}>
                <span>{error || initialError}</span>
              </div>
            )}

            <label className="form-field" htmlFor="password">
              <span className="field-label">{isSetup ? '管理员密码' : '密码'}</span>
              <input
                id="password"
                type="password"
                className="input-control"
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                minLength={isSetup ? 12 : 1}
                placeholder={isSetup ? '至少 12 个字符' : '输入密码'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !session}>
              {busy && <Spinner size={15} />}
              <span>{isSetup ? '完成初始化' : '进入「听点好的」'}</span>
              <ArrowRight size={16} />
            </button>

            <div
              style={{
                paddingTop: '14px',
                borderTop: '1px solid var(--line-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--ink-tertiary)',
                fontSize: 'var(--text-xs)'
              }}
            >
              <ShieldCheck size={15} />
              <span>自托管 · 本地存储 · 数据归你</span>
            </div>
          </form>
        </div>

        <div className="od-row" style={{ justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--ink-tertiary)' }}>
          <span>听点好的 · Listen Better</span>
        </div>
      </div>
    </section>
  );
}

function AlbumsPage({
  albums,
  aiEnabled,
  busy,
  request,
  onAlbumUpdated,
  onStatus,
  onToggleExclude
}: {
  albums: Album[];
  aiEnabled: boolean;
  busy: string | null;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onAlbumUpdated: (a: Album) => void;
  onStatus: (a: Album, s: ListeningStatus) => void;
  onToggleExclude: (a: Album) => void;
}) {
  const [filter, setFilter] = useState<'selected' | 'saved_liked' | 'disagreement' | 'hidden'>('selected');
  const [query, setQuery] = useState('');

  const isHidden = (a: Album) => a.excluded || a.listeningStatus === 'disliked' || a.listeningStatus === 'skipped';

  const visible = albums.filter((a) => {
    const q = query.trim().toLowerCase();
    if (
      q &&
      !`${a.artist} ${a.title} ${a.genres.join(' ')} ${a.aiReview?.shortReview ?? ''}`
        .toLowerCase()
        .includes(q)
    ) {
      return false;
    }
    if (filter === 'hidden') return isHidden(a);
    if (isHidden(a)) return false;
    if (filter === 'saved_liked') return a.listeningStatus === 'saved' || a.listeningStatus === 'liked';
    if (filter === 'disagreement') return a.decision?.status === 'disagreement';
    return a.decision?.status === 'selected';
  });

  const tabs = [
    ['selected', '入选新专'],
    ['saved_liked', '想听与喜欢'],
    ['disagreement', '评分分歧'],
    ['hidden', '已隐藏']
  ] as const;

  return (
    <>
      <div className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">全部新专</h1>
          <p className="view-subtitle">已达口碑门槛的新专辑，直接收听或标记喜好。</p>
        </div>
      </div>

      <div className="filter-toolbar">
        <div className="segmented-tabs" role="group" aria-label="专辑筛选" style={{ flexWrap: 'wrap' }}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`seg-tab ${filter === id ? 'is-active' : ''}`}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="od-row" style={{ '--od-gap': '8px' } as React.CSSProperties}>
          <Search size={14} style={{ color: 'var(--ink-tertiary)' }} />
          <input
            id="lib-search-input"
            type="search"
            className="input-control"
            style={{ width: '210px', padding: '6px 10px', fontSize: 'var(--text-sm)' }}
            aria-label="搜索专辑、艺人或流派"
            placeholder="搜索专辑、艺人或流派…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQuery('')}>
              清空
            </button>
          )}
        </div>
      </div>

      {visible.length > 0 ? (
        <div className="clean-card-grid">
          {visible.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              aiEnabled={aiEnabled}
              busyKey={busy}
              request={request}
              onAlbumUpdated={onAlbumUpdated}
              onStatus={onStatus}
              onToggleExclude={onToggleExclude}
            />
          ))}
        </div>
      ) : (
        <Empty
          title={query ? '没有匹配的专辑' : '当前分类暂无专辑'}
          action={
            query || filter !== 'selected' ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setQuery('');
                  setFilter('selected');
                }}
              >
                返回入选新专
              </button>
            ) : undefined
          }
        >
          {query
            ? '试试更换关键词。'
            : '在 Chrome 打开 RYM、AOTY 或 Pitchfork 页面，或等待每日自动巡检后新专会自动出现在这里。'}
        </Empty>
      )}
    </>
  );
}

function formatEngineBadge(aiSettings: AiSettings | null, draft?: MonthlyAiDraft | null): string {
  if (draft?.engine === 'ai' && draft.model) {
    const label = draft.provider === 'gemini' ? 'Google Gemini' : draft.provider === 'ollama' ? 'Ollama' : 'OpenAI 兼容';
    return `${label} · ${draft.model}`;
  }
  if (aiSettings?.enabled) {
    const label = aiSettings.provider === 'gemini' ? 'Google Gemini' : aiSettings.provider === 'ollama' ? 'Ollama' : 'OpenAI 兼容';
    return `${label} · ${aiSettings.model}`;
  }
  return '本地口碑规则（未启用 AI）';
}

function PlaylistsPage({
  playlists,
  settings,
  aiSettings,
  draft,
  loggedIn,
  busy,
  previewBusy,
  onPreviewAi,
  onSyncNow,
  goSettings
}: {
  playlists: Playlist[];
  settings: Settings | null;
  aiSettings: AiSettings | null;
  draft: MonthlyAiDraft | null;
  loggedIn: boolean;
  busy: boolean;
  previewBusy: boolean;
  onPreviewAi: () => void;
  onSyncNow: () => void;
  goSettings: (tab: SettingsTab) => void;
}) {
  const maxAlbums = settings?.playlist.maxAlbumsPerMonth ?? 12;
  const aiCurated = (settings?.playlist.aiCurated ?? true) && Boolean(aiSettings?.enabled);
  const aiDesc = (settings?.playlist.aiDescription ?? true) && Boolean(aiSettings?.enabled);

  return (
    <>
      <div className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">月度歌单</h1>
          <p className="view-subtitle">硬口碑初筛后由 AI 二次把关入单，并撰写连贯的月度歌单导语。</p>
        </div>

        <div className="od-cluster" style={{ '--od-gap': '8px' } as React.CSSProperties}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={previewBusy || busy} onClick={onPreviewAi}>
            {previewBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
            <span>{previewBusy ? '生成预览中…' : '预览本月 AI 选单与导语'}</span>
          </button>
          {loggedIn ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onSyncNow}>
              <ArrowDownToLine size={14} />
              <span>{busy ? '同步中…' : '立即同步一次'}</span>
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => goSettings('connect')}>
              <span>连接网易云</span>
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Explicit Monthly Playlist Rule Breakdown */}
      <section className="monthly-rules-strip" aria-label="月度歌单生成规则">
        <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', '--od-gap': '8px' } as React.CSSProperties}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>当月入单与简介规则</strong>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => goSettings('advanced')}>
            当前引擎：{formatEngineBadge(aiSettings)}
          </button>
        </div>
        <div className="monthly-rules-grid">
          <div className="monthly-rule-step">
            <span className="monthly-rule-num">01 · 口碑初筛</span>
            <p className="monthly-rule-desc">从 AOTY / RYM / P4K 挑选近 {settings?.lookbackDays ?? 90} 天内高口碑且无评分分歧的专辑。</p>
          </div>
          <div className="monthly-rule-step">
            <span className="monthly-rule-num">02 · AI 入单把关</span>
            <p className="monthly-rule-desc">
              {aiCurated
                ? `已开启 AI 把关：结合品味画像淘汰风格碰撞专辑，单月最多精选 ${maxAlbums} 张。`
                : `当前按评分权重排入前 ${maxAlbums} 张（可在「设置 → 连接与同步」开启 AI 把关）。`}
            </p>
          </div>
          <div className="monthly-rule-step">
            <span className="monthly-rule-num">03 · 完整匹配与去重</span>
            <p className="monthly-rule-desc">仅写入网易云唯一匹配完整专辑，自动跳过已隐藏/不喜欢与往月已收录专辑。</p>
          </div>
          <div className="monthly-rule-step">
            <span className="monthly-rule-num">04 · 连贯简介生成</span>
            <p className="monthly-rule-desc">
              {aiDesc
                ? '同步前由 AI 梳理本月音乐主题与代表脉络撰写连贯短文，不再机械罗列分数清单。'
                : '当前使用客观评分摘要简介（启用 AI 引擎后可写连贯月度导语）。'}
            </p>
          </div>
        </div>
      </section>

      {draft && (
        <section className="monthly-draft-card" aria-label="本月 AI 歌单方案预览">
          <div className="od-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', '--od-gap': '8px' } as React.CSSProperties}>
            <div className="od-cluster" style={{ '--od-gap': '8px' } as React.CSSProperties}>
              <strong style={{ fontSize: 'var(--text-body)' }}>本月方案预览：《{draft.playlistName}》</strong>
              <span className={`badge ${draft.engine === 'ai' ? 'badge-pass' : 'badge-split'}`}>
                {formatEngineBadge(aiSettings, draft)}
              </span>
            </div>
            <span className="mono-num field-hint">生成于 {formatDate(draft.generatedAt)}</span>
          </div>

          <div className="monthly-prose-box">
            {draft.description
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean)
              .map((para, idx) => (
                <p key={idx}>{para}</p>
              ))}
          </div>

          <div className="monthly-decisions-grid">
            <div className="monthly-decision-col">
              <span className="field-label">拟入单专辑（{draft.admitted.length} 张）</span>
              {draft.admitted.length ? (
                <ul className="monthly-decision-list">
                  {draft.admitted.map((item) => (
                    <li key={item.albumId}>
                      <div className="od-row" style={{ '--od-gap': '6px', flexWrap: 'wrap' } as React.CSSProperties}>
                        <span className={`badge ${item.decision === 'retained' ? 'badge-excluded' : 'badge-pass'}`}>
                          {item.decision === 'retained' ? '已保留' : '拟新增'}
                        </span>
                        <strong>{item.artist} — {item.title}</strong>
                      </div>
                      <span className="field-hint">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-hint">当前暂无达到门槛的新专辑。</p>
              )}
            </div>

            {draft.held.length > 0 && (
              <div className="monthly-decision-col">
                <span className="field-label">AI 建议暂缓（{draft.held.length} 张）</span>
                <ul className="monthly-decision-list">
                  {draft.held.map((item) => (
                    <li key={item.albumId}>
                      <div className="od-row" style={{ '--od-gap': '6px', flexWrap: 'wrap' } as React.CSSProperties}>
                        <span className="badge badge-watch">暂缓</span>
                        <strong>{item.artist} — {item.title}</strong>
                      </div>
                      <span className="field-hint">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {!playlists.length ? (
        <Empty title="尚无已同步的月度歌单">
          {loggedIn
            ? '当有新的高分专辑通过 AI 把关且在网易云匹配到完整曲目时，系统会自动建单并同步；你也可先点击上方「预览本月 AI 选单与导语」查看效果。'
            : '连接网易云音乐后，新入选的高分专辑会自动整理到当月歌单；当前也可先预览本月 AI 选单与导语。'}
        </Empty>
      ) : (
        <div className="editions-grid">
          {playlists.map((p, i) => (
            <article className="edition-card" key={p.id}>
              <div className="edition-sleeve-art" style={{ background: editionPalettes[i % editionPalettes.length] }}>
                <div className="od-row" style={{ justifyContent: 'space-between', position: 'relative', zIndex: 2 }}>
                  <span className="bespoke-cover-kicker">EDITION {String(i + 1).padStart(2, '0')}</span>
                  <span className="badge-format" style={{ background: 'rgba(255,255,255,0.16)' }}>
                    33⅓ RPM
                  </span>
                </div>
                <div className="od-stack" style={{ '--od-gap': '6px', position: 'relative', zIndex: 2 } as React.CSSProperties}>
                  <span className="latin-display" style={{ fontSize: '2.5rem', color: '#FFFFFF' }}>
                    {p.month}
                  </span>
                  <h2 className="cjk-heading" style={{ fontSize: '1.25rem', color: '#FFFFFF' }}>
                    {p.name}
                  </h2>
                </div>
              </div>

              <div className="od-stack" style={{ '--od-gap': '10px' } as React.CSSProperties}>
                <div
                  className="od-row"
                  style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line-subtle)', paddingBottom: '8px' }}
                >
                  <span className="field-hint">收录规模</span>
                  <strong className="mono-num" style={{ fontSize: 'var(--text-sm)' }}>
                    {p.albumIds.length} 张专辑 · {p.trackCount} 首曲目
                  </strong>
                </div>
                {p.description && (
                  <p className="edition-desc-excerpt">{p.description}</p>
                )}
                <div className="od-row" style={{ justifyContent: 'space-between' }}>
                  <span className="field-hint">最近更新</span>
                  <span className="mono-num field-hint">{formatDate(p.updatedAt)}</span>
                </div>
                <div className="od-row" style={{ justifyContent: 'flex-end', paddingTop: '6px' }}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
                    <span>打开网易云</span>
                    <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
