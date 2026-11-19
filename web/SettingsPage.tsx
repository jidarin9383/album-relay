import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, Headphones, LoaderCircle, Plus, Radio, Sparkles, Upload } from 'lucide-react';
import type { ImportBatchSummary, ImportSource, PersonalOverview } from '../shared/personal';
import type { AiSettings, ConnectionStatus, Run, RunMode, Settings, SourceName } from '../shared/types';
import { AiPanel } from './AiPanel';
import { CapturePanel } from './CapturePanel';
import { ExtensionPanel } from './ExtensionPanel';
import type { SettingsTab } from './ForYouPage';

interface Props {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  settings: Settings | null;
  connection: ConnectionStatus | null;
  personal: PersonalOverview | null;
  runs: Run[];
  busy: string | null;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  onSaveSettings: (next: Settings) => Promise<void>;
  onSyncNow: () => void;
  onAiSaved: (settings: AiSettings) => void;
  onPersonalUpdated: () => Promise<void>;
  onDataUpdated: () => Promise<void>;
  setConnection: (c: ConnectionStatus) => void;
  notify: (msg: string) => void;
  reportError: (msg: string) => void;
}

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'connect', label: '连接与同步' },
  { id: 'taste', label: '口味数据' },
  { id: 'rules', label: '入选门槛' },
  { id: 'advanced', label: 'AI 与高级' }
];

const sourceNames: Record<SourceName, string> = { aoty: 'AOTY', rym: 'RYM', pitchfork: 'Pitchfork' };
const sourceOrder: SourceName[] = ['aoty', 'rym', 'pitchfork'];

const importSourceOptions: { id: ImportSource; label: string; hint: string; placeholder: string }[] = [
  {
    id: 'netease',
    label: '网易云音乐',
    hint: '支持歌单 CSV / JSON，或每行输入「艺人 - 曲目/专辑」。',
    placeholder: 'Radiohead - In Rainbows\nSlowdive - Souvlaki'
  },
  {
    id: 'spotify',
    label: 'Spotify',
    hint: '支持 Exportify / TuneMyMusic 导出的 CSV，以及 Streaming_History_Audio_*.json。',
    placeholder: '粘贴导出的 CSV 或 JSON 内容'
  },
  {
    id: 'youtube_music',
    label: 'YouTube Music',
    hint: '支持 Google Takeout 的 watch-history.json 或播放列表 CSV。',
    placeholder: '粘贴 watch-history.json 或 CSV 内容'
  },
  {
    id: 'rym_export',
    label: 'RYM / AOTY 评分表',
    hint: '支持含 Artist、Title、Rating 列的 CSV 导出文件。',
    placeholder: 'Artist,Title,Rating\nRadiohead,In Rainbows,4.5'
  },
  {
    id: 'generic',
    label: '通用 CSV / JSON',
    hint: '支持含 artist、title/album、genres 等字段的文件。',
    placeholder: 'artist,title,genres\nChat Pile,God\'s Country,Noise Rock'
  }
];

function detectImportSource(fileName: string, content: string): ImportSource | null {
  const name = fileName.toLowerCase();
  const head = content.slice(0, 600).toLowerCase();
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  if (/spotify|streaming_history|yourlibrary/.test(name) || /spotify\s*-\s*id|spotify id|track uri|master_metadata_track_name/.test(head)) {
    return 'spotify';
  }
  if (/watch-history|youtube/.test(name) || /"header"\s*:\s*"youtube music"/i.test(head)) {
    return 'youtube_music';
  }
  if (/\brym\b|\baoty\b/.test(name) || /first name\s*,\s*last name|rym album id/.test(firstLine)) {
    return 'rym_export';
  }
  if (/netease|163|网易/.test(name) || /"playlist"\s*:\s*\{\s*"tracks"/.test(head)) {
    return 'netease';
  }
  return null;
}

const runModeNames: Record<RunMode, string> = {
  auto_sync: '自动同步歌单',
  library_preview: '歌单匹配预览',
  sync: '写入歌单',
  refresh: '来源刷新',
  preview: '全流程预览'
};

const runStateNames: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  waiting_verification: '需要验证',
  partial: '部分完成',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const fmtTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export function SettingsPage({
  tab,
  onTabChange,
  settings,
  connection,
  personal,
  runs,
  busy,
  request,
  onSaveSettings,
  onSyncNow,
  onAiSaved,
  onPersonalUpdated,
  onDataUpdated,
  setConnection,
  notify,
  reportError
}: Props) {
  const [localBusy, setLocalBusy] = useState('');
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [playlistPattern, setPlaylistPattern] = useState(settings?.playlist.namePattern ?? '高分新专辑｜YYYY-MM');
  const [playlistMax, setPlaylistMax] = useState(settings?.playlist.maxAlbumsPerMonth ?? 12);
  const [playlistAiCurated, setPlaylistAiCurated] = useState(settings?.playlist.aiCurated ?? true);
  const [playlistAiDesc, setPlaylistAiDesc] = useState(settings?.playlist.aiDescription ?? true);

  // Rules draft
  const [rulesDraft, setRulesDraft] = useState<Settings | null>(settings);
  useEffect(() => {
    setRulesDraft(settings);
    if (settings) {
      setPlaylistPattern(settings.playlist.namePattern);
      setPlaylistMax(settings.playlist.maxAlbumsPerMonth ?? 12);
      setPlaylistAiCurated(settings.playlist.aiCurated ?? true);
      setPlaylistAiDesc(settings.playlist.aiDescription ?? true);
    }
  }, [settings]);

  // Taste favorite & import states
  const [favArtist, setFavArtist] = useState('');
  const [favGenres, setFavGenres] = useState('');
  const [importSource, setImportSource] = useState<ImportSource>('netease');
  const [accountAlias, setAccountAlias] = useState('');
  const [fileName, setFileName] = useState('netease-favorites.txt');
  const [content, setContent] = useState('');

  async function runLocal(key: string, fn: () => Promise<void>) {
    setLocalBusy(key);
    reportError('');
    try {
      await fn();
    } catch (e) {
      reportError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setLocalBusy('');
    }
  }

  const profile = personal?.profile;
  const ambiguousArtists = (personal?.artistMetadata ?? []).filter((m) => m.status === 'ambiguous');
  const activeImportMeta = importSourceOptions.find((o) => o.id === importSource) ?? importSourceOptions[0]!;

  return (
    <>
      <div className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">设置</h1>
          <p className="view-subtitle">配好连接、口味来源与规则后，日常会自动为你更新。</p>
        </div>
      </div>

      <div className="settings-subtabs" role="tablist" aria-label="设置分类">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`seg-tab ${tab === item.id ? 'is-active' : ''}`}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 1. CONNECT & AUTO SYNC */}
      {tab === 'connect' && (
        <div className="od-stack" style={{ '--od-gap': '24px' } as React.CSSProperties}>
          <section className="rules-section" aria-labelledby="conn-netease-title">
            <div className="section-bar">
              <div className="od-row" style={{ '--od-gap': '12px' } as React.CSSProperties}>
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '50%',
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    border: '1px solid var(--accent-border)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0
                  }}
                >
                  <Headphones size={20} />
                </div>
                <div className="od-cluster" style={{ '--od-gap': '10px' } as React.CSSProperties}>
                  <h2 id="conn-netease-title" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
                    网易云音乐
                  </h2>
                  <span className={`badge ${connection?.loggedIn ? 'badge-pass' : connection?.configured ? 'badge-watch' : 'badge-excluded'}`}>
                    {connection?.loggedIn ? '已连接' : connection?.configured ? '等待扫码' : '未配置'}
                  </span>
                </div>
              </div>

              <div className="od-cluster" style={{ '--od-gap': '8px' } as React.CSSProperties}>
                {connection?.loggedIn && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !!localBusy} onClick={onSyncNow}>
                    <ArrowDownToLine size={14} />
                    <span>立即同步歌单</span>
                  </button>
                )}
                {connection?.configured && !connection?.loggedIn && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!!localBusy}
                    onClick={() =>
                      void runLocal('ncm-login', async () => {
                        setConnection(await request<ConnectionStatus>('/connection/login', {}));
                      })
                    }
                  >
                    {localBusy === 'ncm-login' ? <LoaderCircle size={14} className="spin" /> : <Radio size={14} />}
                    <span>扫码登录</span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!!localBusy}
                  onClick={() =>
                    void runLocal('ncm-check', async () => {
                      setConnection(await request<ConnectionStatus>('/connection/check', {}));
                    })
                  }
                >
                  检查连接
                </button>
              </div>
            </div>

            {connection?.message && (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-secondary)', marginBottom: 'var(--sp-4)' }}>
                {connection.message}
              </p>
            )}

            {settings && (
              <div style={{ marginBottom: 'var(--sp-4)' }}>
                <label className="toggle-wrap">
                  <input
                    type="checkbox"
                    className="toggle-input"
                    checked={settings.autoSyncPlaylist ?? true}
                    disabled={!!localBusy}
                    onChange={(e) => {
                      const next = { ...settings, autoSyncPlaylist: e.target.checked };
                      void runLocal('auto-sync-toggle', async () => {
                        await onSaveSettings(next);
                        notify(e.target.checked ? '已开启自动同步歌单。' : '已暂停自动同步歌单。');
                      });
                    }}
                  />
                  <span>有新入选专辑时，自动同步写入当月网易云歌单</span>
                </label>
              </div>
            )}

            {connection?.qrCodeUrl && connection.loginState === 'waiting' && (
              <div className="rule-source-box" style={{ marginBottom: 'var(--sp-4)' }}>
                <div className="od-row" style={{ '--od-gap': '20px', flexWrap: 'wrap' } as React.CSSProperties}>
                  <img className="qr-preview-img" src={connection.qrCodeUrl} alt="网易云音乐登录二维码" />
                  <div className="od-stack" style={{ '--od-gap': '6px', flex: '1 1 220px' } as React.CSSProperties}>
                    <strong style={{ fontSize: 'var(--text-body)' }}>用网易云音乐 App 扫码授权</strong>
                    <span className="field-hint">手机确认后会自动完成连接。</span>
                    <div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          void runLocal('ncm-cancel', async () => {
                            setConnection(await request<ConnectionStatus>('/connection/cancel', {}));
                          })
                        }
                      >
                        关闭二维码
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <details
              style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-4)' }}
              open={!connection?.configured}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                歌单命名与开发者凭据
                <span className="field-hint" style={{ fontWeight: 400, marginLeft: '8px' }}>
                  {connection?.configured ? '已配置' : '首次连接网易云需填写'}
                </span>
              </summary>

              <div className="od-stack" style={{ '--od-gap': '16px', marginTop: 'var(--sp-4)' } as React.CSSProperties}>
                {settings && (
                  <form
                    className="od-stack"
                    style={{ '--od-gap': '12px' } as React.CSSProperties}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void runLocal('save-pattern', async () => {
                        await onSaveSettings({
                          ...settings,
                          playlist: {
                            ...settings.playlist,
                            namePattern: playlistPattern,
                            maxAlbumsPerMonth: playlistMax,
                            aiCurated: playlistAiCurated,
                            aiDescription: playlistAiDesc
                          }
                        });
                        notify('月度歌单命名与 AI 规则已更新。');
                      });
                    }}
                  >
                    <div className="od-row" style={{ '--od-gap': '10px', flexWrap: 'wrap', alignItems: 'flex-end' } as React.CSSProperties}>
                      <label className="form-field" style={{ flex: '1 1 240px' }}>
                        <span className="field-label">月度歌单名称模板（需包含 YYYY-MM）</span>
                        <input
                          required
                          className="input-control"
                          value={playlistPattern}
                          onChange={(e) => setPlaylistPattern(e.target.value)}
                        />
                      </label>
                      <label className="form-field" style={{ width: '130px' }}>
                        <span className="field-label">单月入单上限（张）</span>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          required
                          className="input-control mono-num"
                          value={playlistMax}
                          onChange={(e) => setPlaylistMax(Number(e.target.value))}
                        />
                      </label>
                      <button type="submit" className="btn btn-secondary btn-sm" disabled={localBusy === 'save-pattern'}>
                        保存歌单设置
                      </button>
                    </div>
                    <div className="od-cluster" style={{ '--od-gap': '16px' } as React.CSSProperties}>
                      <label className="toggle-wrap">
                        <input
                          type="checkbox"
                          className="toggle-input"
                          checked={playlistAiCurated}
                          onChange={(e) => setPlaylistAiCurated(e.target.checked)}
                        />
                        <span>由 AI 对达标新专做月度入单把关（避免强塞风格碰撞专辑）</span>
                      </label>
                      <label className="toggle-wrap">
                        <input
                          type="checkbox"
                          className="toggle-input"
                          checked={playlistAiDesc}
                          onChange={(e) => setPlaylistAiDesc(e.target.checked)}
                        />
                        <span>由 AI 撰写连贯的月度歌单导语（替代流水账罗列）</span>
                      </label>
                    </div>
                  </form>
                )}

                <form
                  style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-4)' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runLocal('configure-ncm', async () => {
                      setConnection(await request<ConnectionStatus>('/connection/configure', { appId, privateKey }));
                      setPrivateKey('');
                      setAppId('');
                      notify('开发者凭据已保存。');
                    });
                  }}
                >
                  <div className="od-grid" style={{ '--od-cols': 2, '--od-gap': '16px', marginBottom: 'var(--sp-4)' } as React.CSSProperties}>
                    <label className="form-field">
                      <span className="field-label">App ID</span>
                      <input
                        required
                        className="input-control mono-num"
                        value={appId}
                        onChange={(e) => setAppId(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label className="form-field">
                      <span className="field-label">私钥</span>
                      <textarea
                        required
                        className="textarea-control mono-num"
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="粘贴开发者私钥"
                        rows={3}
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <button type="submit" className="btn btn-secondary btn-sm" disabled={localBusy === 'configure-ncm'}>
                    保存凭据
                  </button>
                </form>
              </div>
            </details>
          </section>

          <ExtensionPanel request={request} onChanged={onDataUpdated} />
        </div>
      )}

      {/* 2. TASTE SOURCES */}
      {tab === 'taste' && (
        <div className="od-stack" style={{ '--od-gap': '24px' } as React.CSSProperties}>
          <section className="rules-section" aria-labelledby="taste-seeds-title">
            <div className="section-bar">
              <h2 id="taste-seeds-title" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
                常听艺人偏好
              </h2>
            </div>

            <form
              className="seed-form-inline"
              onSubmit={(e) => {
                e.preventDefault();
                if (!favArtist.trim()) return;
                const name = favArtist.trim();
                void runLocal('fav-add', async () => {
                  await request('/personal/favorites', {
                    artist: name,
                    genres: favGenres
                      .split(/[,，/]+/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                  });
                  setFavArtist('');
                  setFavGenres('');
                  await onPersonalUpdated();
                  notify(`已添加「${name}」，正在更新推荐。`);
                });
              }}
            >
              <label className="form-field">
                <span className="field-label">艺人名称 *</span>
                <input
                  required
                  className="input-control"
                  placeholder="如 Radiohead / 窦唯"
                  value={favArtist}
                  onChange={(e) => setFavArtist(e.target.value)}
                />
              </label>
              <label className="form-field">
                <span className="field-label">风格标签（可选）</span>
                <input
                  className="input-control"
                  placeholder="如 Art Rock, Shoegaze"
                  value={favGenres}
                  onChange={(e) => setFavGenres(e.target.value)}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={!!localBusy}>
                <Plus size={14} />
                <span>添加</span>
              </button>
            </form>

            {profile && profile.topArtistsLongTerm.length > 0 && (
              <div className="od-cluster" style={{ '--od-gap': '6px', marginTop: 'var(--sp-4)' } as React.CSSProperties}>
                {profile.topArtistsLongTerm.slice(0, 14).map((a) => (
                  <span className="clean-genre-chip" key={a.key}>
                    {a.name}
                  </span>
                ))}
              </div>
            )}
          </section>

          {ambiguousArtists.length > 0 && (
            <section className="disambig-card" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--warn-ink)' }}>
                同名艺人流派确认（{ambiguousArtists.length} 位）
              </strong>
              <div className="od-stack" style={{ '--od-gap': '10px' } as React.CSSProperties}>
                {ambiguousArtists.map((a) => (
                  <div
                    key={a.artistNorm}
                    className="od-row"
                    style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', borderTop: '1px solid var(--warn-border)', paddingTop: '10px' }}
                  >
                    <span style={{ fontSize: 'var(--text-sm)' }}>
                      <strong>{a.artistName}</strong> 请选择匹配的艺人档案：
                    </span>
                    <div className="od-cluster" style={{ '--od-gap': '6px' } as React.CSSProperties}>
                      {(a.candidates ?? []).map((cand) => (
                        <button
                          key={cand.wikidataId}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!cand.genres.length || localBusy === `manual-${a.artistNorm}`}
                          onClick={() =>
                            void runLocal(`manual-${a.artistNorm}`, async () => {
                              await request(`/personal/artists/${encodeURIComponent(a.artistNorm)}/genres`, {
                                artistName: a.artistName,
                                genres: cand.genres
                              });
                              await onPersonalUpdated();
                              notify(`已确认 ${a.artistName} 风格标签。`);
                            })
                          }
                        >
                          {cand.label}（{cand.genres.slice(0, 3).join(' / ') || '无标签'}）
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rules-section" aria-labelledby="taste-import-title">
            <div className="section-bar">
              <h2 id="taste-import-title" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
                导入听歌历史或歌单
              </h2>
            </div>

            <form
              className="od-stack"
              style={{ '--od-gap': '16px' } as React.CSSProperties}
              onSubmit={(e) => {
                e.preventDefault();
                if (!content.trim()) return;
                void runLocal('import', async () => {
                  const res = await request<{ batch: ImportBatchSummary }>('/personal/imports', {
                    source: importSource,
                    accountAlias: accountAlias.trim() || 'default',
                    fileName: fileName.trim() || `${importSource}-import`,
                    content
                  });
                  setContent('');
                  await onPersonalUpdated();
                  notify(
                    res.batch.idempotentReplay
                      ? '该文件已导入过。'
                      : `已导入 ${res.batch.acceptedCount} 条记录，正在后台更新推荐。`
                  );
                });
              }}
            >
              <div className="od-grid" style={{ '--od-cols': 2, '--od-gap': '16px' } as React.CSSProperties}>
                <label className="form-field">
                  <span className="field-label">来源格式</span>
                  <select
                    className="select-control"
                    value={importSource}
                    onChange={(e) => {
                      const s = e.target.value as ImportSource;
                      setImportSource(s);
                      if (!content.trim() || /-import$|-favorites\.txt$/.test(fileName)) {
                        setFileName(`${s}-import`);
                      }
                    }}
                  >
                    {importSourceOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <small className="field-hint">{activeImportMeta.hint}</small>
                </label>

                <div className="dropzone-box">
                  <strong>选择本地导出文件</strong>
                  <span className="field-hint">支持 .json / .csv / .txt，自动去重且仅存本机</span>
                  <div style={{ marginTop: '6px' }}>
                    <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                      <Upload size={14} />
                      <span>{content && fileName ? `已选：${fileName}` : '选择文件'}</span>
                      <input
                        type="file"
                        accept=".json,.csv,.txt"
                        hidden
                        onChange={async (e) => {
                          const inputEl = e.currentTarget;
                          const file = inputEl.files?.[0];
                          if (!file) return;
                          const fileText = await file.text();
                          setFileName(file.name);
                          setContent(fileText);
                          const detected = detectImportSource(file.name, fileText);
                          if (detected) setImportSource(detected);
                          inputEl.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>

              <details open={Boolean(content)}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-secondary)' }}>
                  或直接粘贴导出文本 / 歌单列表
                </summary>
                <div className="od-stack" style={{ '--od-gap': '12px', marginTop: 'var(--sp-3)' } as React.CSSProperties}>
                  <textarea
                    rows={4}
                    className="textarea-control mono-num"
                    style={{ fontSize: 'var(--text-xs)' }}
                    placeholder={activeImportMeta.placeholder}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                  />
                  <label className="form-field" style={{ maxWidth: '280px' }}>
                    <span className="field-label">账号别名（多账号去重时填写，可留空）</span>
                    <input
                      className="input-control"
                      placeholder="default"
                      value={accountAlias}
                      onChange={(e) => setAccountAlias(e.target.value)}
                    />
                  </label>
                </div>
              </details>

              <div className="od-row" style={{ justifyContent: 'flex-end' }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={!!localBusy || !content.trim()}>
                  <Upload size={14} />
                  <span>导入记录</span>
                </button>
              </div>
            </form>

            {(personal?.batches.length ?? 0) > 0 && (
              <details style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-secondary)' }}>
                  已导入批次（{personal!.batches.length} 批）
                </summary>
                <div className="od-stack" style={{ '--od-gap': '8px', marginTop: 'var(--sp-3)' } as React.CSSProperties}>
                  {personal!.batches.map((b) => (
                    <div
                      key={b.id}
                      className="od-row"
                      style={{ justifyContent: 'space-between', flexWrap: 'wrap', padding: '8px 12px', background: 'var(--bg-canvas)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line-subtle)', fontSize: 'var(--text-xs)' }}
                    >
                      <span className="mono-num">
                        {b.fileName} · {fmtTime(b.createdAt)}
                      </span>
                      <span className="field-hint">新增 {b.acceptedCount} 条</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>
        </div>
      )}

      {/* 3. THRESHOLDS & RULES */}
      {tab === 'rules' && rulesDraft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runLocal('save-rules', async () => {
              await onSaveSettings(rulesDraft);
              notify('入选门槛已保存，列表已重算。');
            });
          }}
        >
          <section className="rules-section" aria-labelledby="rules-heading">
            <div className="section-bar">
              <h2 id="rules-heading" className="cjk-heading" style={{ fontSize: 'var(--text-h2)' }}>
                筛选门槛
              </h2>
            </div>

            <div style={{ marginBottom: 'var(--sp-5)' }}>
              <label className="toggle-wrap">
                <input
                  type="checkbox"
                  className="toggle-input"
                  checked={rulesDraft.allowSingleSourceAcclaim ?? true}
                  onChange={(e) => setRulesDraft({ ...rulesDraft, allowSingleSourceAcclaim: e.target.checked })}
                />
                <span>单站高口碑直接入选（Pitchfork BNM / ≥ 8.3，RYM ≥ 3.7，AOTY ≥ 82）</span>
              </label>
            </div>

            <div className="rule-source-grid">
              {sourceOrder.map((source) => {
                const t = rulesDraft.thresholds[source];
                const updateThreshold = (key: string, val: number | boolean) =>
                  setRulesDraft({
                    ...rulesDraft,
                    thresholds: { ...rulesDraft.thresholds, [source]: { ...rulesDraft.thresholds[source], [key]: val } }
                  });
                return (
                  <div className="rule-source-box" key={source}>
                    <div className="od-row" style={{ justifyContent: 'space-between' }}>
                      <strong>{sourceNames[source]}</strong>
                      <label className="toggle-wrap">
                        <input
                          type="checkbox"
                          className="toggle-input"
                          checked={rulesDraft.sources[source]}
                          onChange={(e) =>
                            setRulesDraft({
                              ...rulesDraft,
                              sources: { ...rulesDraft.sources, [source]: e.target.checked }
                            })
                          }
                        />
                        <span>启用</span>
                      </label>
                    </div>

                    <label className="form-field">
                      <span className="field-label">入选分数 ≥</span>
                      <input
                        type="number"
                        className="input-control mono-num"
                        required
                        min={0}
                        max={source === 'aoty' ? 100 : source === 'rym' ? 5 : 10}
                        step={source === 'aoty' ? 1 : 0.1}
                        value={t.score}
                        onChange={(e) => updateThreshold('score', Number(e.target.value))}
                      />
                    </label>

                    {source !== 'pitchfork' ? (
                      <label className="form-field">
                        <span className="field-label">最低票数</span>
                        <input
                          type="number"
                          className="input-control mono-num"
                          required
                          min={0}
                          value={rulesDraft.thresholds[source].votes}
                          onChange={(e) => updateThreshold('votes', Number(e.target.value))}
                        />
                      </label>
                    ) : (
                      <label className="toggle-wrap" style={{ paddingBlock: '6px' }}>
                        <input
                          type="checkbox"
                          className="toggle-input"
                          checked={rulesDraft.thresholds.pitchfork.allowBnm}
                          onChange={(e) => updateThreshold('allowBnm', e.target.checked)}
                        />
                        <span>直接入选 Best New Music</span>
                      </label>
                    )}

                    <label className="form-field">
                      <span className="field-label">评分分歧警告线 &lt;</span>
                      <input
                        type="number"
                        className="input-control mono-num"
                        required
                        min={0}
                        max={source === 'aoty' ? 100 : source === 'rym' ? 5 : 10}
                        step={source === 'aoty' ? 1 : 0.1}
                        value={t.negative}
                        onChange={(e) => updateThreshold('negative', Number(e.target.value))}
                      />
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="od-grid" style={{ '--od-cols': 2, '--od-gap': '16px', marginBottom: 'var(--sp-4)' } as React.CSSProperties}>
              <label className="form-field">
                <span className="field-label">收录时间范围（仅看最近多少天内发行）</span>
                <input
                  type="number"
                  className="input-control mono-num"
                  min={1}
                  max={365}
                  required
                  value={rulesDraft.lookbackDays}
                  onChange={(e) => setRulesDraft({ ...rulesDraft, lookbackDays: Number(e.target.value) })}
                />
              </label>
            </div>

            <details style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-secondary)' }}>
                更多细项参数
              </summary>
              <div className="od-stack" style={{ '--od-gap': '14px', marginTop: 'var(--sp-4)' } as React.CSSProperties}>
                <label className="toggle-wrap">
                  <input
                    type="checkbox"
                    className="toggle-input"
                    checked={rulesDraft.allowApproximateVotes ?? true}
                    onChange={(e) => setRulesDraft({ ...rulesDraft, allowApproximateVotes: e.target.checked })}
                  />
                  <span>计入估算票数（如 RYM 榜单中的 6k 票）</span>
                </label>
                <div className="od-grid" style={{ '--od-cols': 3, '--od-gap': '16px' } as React.CSSProperties}>
                  <label className="form-field">
                    <span className="field-label">跨站共识最少达标数</span>
                    <input
                      type="number"
                      className="input-control mono-num"
                      min={1}
                      max={3}
                      required
                      value={rulesDraft.minSources}
                      onChange={(e) => setRulesDraft({ ...rulesDraft, minSources: Number(e.target.value) })}
                    />
                  </label>
                  <label className="form-field">
                    <span className="field-label">发行沉淀天数</span>
                    <input
                      type="number"
                      className="input-control mono-num"
                      min={0}
                      max={365}
                      required
                      value={rulesDraft.minimumAgeDays}
                      onChange={(e) => setRulesDraft({ ...rulesDraft, minimumAgeDays: Number(e.target.value) })}
                    />
                  </label>
                  <label className="form-field">
                    <span className="field-label">抓取限流间隔（毫秒）</span>
                    <input
                      type="number"
                      className="input-control mono-num"
                      min={6000}
                      step={100}
                      required
                      value={rulesDraft.requestDelayMs}
                      onChange={(e) => setRulesDraft({ ...rulesDraft, requestDelayMs: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </div>
            </details>

            <div className="od-row" style={{ justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={localBusy === 'save-rules'}>
                {localBusy === 'save-rules' ? <SpinnerTiny /> : <Check size={15} />}
                <span>保存设置</span>
              </button>
            </div>
          </section>
        </form>
      )}

      {/* 4. AI & ADVANCED TROUBLESHOOTING */}
      {tab === 'advanced' && (
        <div className="od-stack" style={{ '--od-gap': '24px' } as React.CSSProperties}>
          <AiPanel request={request} onSaved={onAiSaved} />

          <section className="rules-section">
            <details>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--text-body)' }}>
                手动来源入口与后台记录
              </summary>
              <div className="od-stack" style={{ '--od-gap': '20px', marginTop: 'var(--sp-5)' } as React.CSSProperties}>
                <CapturePanel request={request} onCaptured={onDataUpdated} />

                <div style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 'var(--sp-4)' }}>
                  <div className="od-row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>最近自动同步与任务记录</strong>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={localBusy === 'trigger-auto'}
                      onClick={() =>
                        void runLocal('trigger-auto', async () => {
                          await request('/automation/run', {});
                          notify('已触发后台流水线更新，稍后可查看结果。');
                        })
                      }
                    >
                      <Sparkles size={12} />
                      <span>立即检查并更新全部结果</span>
                    </button>
                  </div>

                  {runs.length > 0 ? (
                    <div className="od-stack" style={{ '--od-gap': '8px' } as React.CSSProperties}>
                      {runs.slice(0, 8).map((r) => (
                        <details
                          key={r.id}
                          style={{ background: 'var(--bg-canvas)', border: '1px solid var(--line-subtle)', borderRadius: 'var(--radius-sm)', padding: '10px 14px' }}
                        >
                          <summary className="od-row" style={{ justifyContent: 'space-between', cursor: 'pointer', fontSize: 'var(--text-xs)' }}>
                            <span>
                              <strong>{runModeNames[r.mode]}</strong> · {runStateNames[r.status] ?? r.status}
                              {r.message ? ` — ${r.message}` : ''}
                            </span>
                            <span className="mono-num field-hint">{fmtTime(r.startedAt)}</span>
                          </summary>
                          <div className="log-console" style={{ marginTop: '8px', maxHeight: '180px' }}>
                            {r.logs.map((log, i) => (
                              <div className="log-line" key={i}>
                                <span className="log-ts">{new Date(log.at).toLocaleTimeString('zh-CN')}</span>
                                <span>{log.message}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <p className="field-hint">暂无后台同步记录。</p>
                  )}
                </div>
              </div>
            </details>
          </section>
        </div>
      )}
    </>
  );
}

function SpinnerTiny() {
  return <LoaderCircle size={14} className="spin" aria-hidden="true" />;
}
