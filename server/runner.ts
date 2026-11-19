import { randomUUID, createHash } from 'node:crypto';
import type { Album, MatchedAlbum, Playlist, Run, RunMode, Settings, SourceStatus, SyncPreview, SyncSelection } from '../shared/types.js';
import { getAiSettings, type LlmClient } from './ai/client.js';
import {
  curateMonthlyPlaylistAlbums,
  generateAiPlaylistDescription,
  saveLatestMonthlyDraft,
  type MonthlyCurationResult
} from './ai/playlist.js';
import { decide, isObservationFresh, todayInTimezone } from './policy.js';
import { planSync } from './planner.js';

export interface RunnerStore {
  settings(): Settings;
  albums(): Album[];
  saveAlbums(albums: Album[]): void;
  playlists(): Playlist[];
  savePlaylist(playlist: Playlist): void;
  runs(): Run[];
  saveRun(run: Run): void;
  acquireLock(owner: string): boolean;
  releaseLock(owner: string): void;
  sourceStatuses(): SourceStatus[];
  saveSourceStatuses(statuses: SourceStatus[]): void;
  getValue(key: string): string | null | undefined;
  setValue(key: string, value: string): void;
}

interface Sources {
  refresh(
    settings: Settings,
    existing: Album[],
    progress: (message: string) => void,
    onStatus?: (status: SourceStatus) => void
  ): Promise<{ albums: Album[]; statuses: SourceStatus[] }>;
}

interface Target {
  match(album: Album, lookbackDays?: number): Promise<MatchedAlbum | null>;
  sync(
    preview: SyncPreview,
    checkpoint: (p: Playlist) => void | Promise<void>,
    progress: (s: string) => void
  ): Promise<Playlist | null>;
}

interface SavedPreview {
  runId: string;
  createdAt: string;
  settingsHash: string;
  albumsHash: string;
  preview: SyncPreview;
  usable: boolean;
  selection?: SyncSelection;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp = () => new Date().toISOString();
const isDismissed = (album: Album) => album.listeningStatus === 'disliked' || album.listeningStatus === 'skipped';
const today = (settings: Settings) => todayInTimezone(settings.schedule.timezone);

export class Runner {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: RunnerStore,
    private readonly sources: Sources,
    private readonly netease: Target,
    private readonly aiClient?: LlmClient
  ) {}

  start(mode: RunMode, selection?: SyncSelection): Run {
    const run: Run = { id: randomUUID(), mode, status: 'queued', stage: 'queued', message: '任务已排队', startedAt: stamp(), logs: [] };
    if (!this.store.acquireLock(run.id)) throw new Error('已有任务正在运行，请等待完成');
    try {
      this.store.saveRun(run);
    } catch (e) {
      this.store.releaseLock(run.id);
      throw e;
    }
    this.pending = Promise.resolve().then(() => this.execute(run, selection));
    return structuredClone(run);
  }

  async wait(): Promise<void> {
    await this.pending;
  }

  recoverInterrupted(): void {
    for (const run of this.store.runs()) {
      if (!['queued', 'running', 'waiting_verification'].includes(run.status)) continue;
      run.status = 'failed';
      run.finishedAt = stamp();
      run.message = '服务重启中断任务，未自动重放写入；请检查歌单后重试';
      run.logs.push({ at: stamp(), level: 'warning', message: run.message });
      this.store.saveRun(run);
      this.store.releaseLock(run.id);
    }
  }

  private log(run: Run, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    run.message = message;
    run.logs.push({ at: stamp(), level, message });
    this.store.saveRun(run);
  }

  private async execute(run: Run, selection?: SyncSelection): Promise<void> {
    let checkpointed = false;
    let writeStarted = false;
    const writeToNetease = async (preview: SyncPreview, sourceAlbums: Album[], aiCuration?: MonthlyCurationResult | null) => {
      writeStarted = true;
      const runSettings = this.store.settings();
      let enrichedPreview = preview;
      if (
        !preview.description &&
        runSettings.playlist.aiDescription !== false &&
        this.aiClient &&
        getAiSettings(this.store as never).enabled
      ) {
        try {
          this.log(run, '由 AI 撰写连贯的本月歌单简介');
          const aiDesc = await generateAiPlaylistDescription(
            this.store,
            preview.month,
            preview.playlistName,
            preview.albums,
            preview.descriptionMaxChars ?? runSettings.playlist.descriptionMaxChars,
            this.aiClient
          );
          if (aiDesc.trim()) enrichedPreview = { ...preview, description: aiDesc };
        } catch {
          this.log(run, 'AI 生成歌单简介失败，已自动回退为规则汇总简介', 'warning');
        }
      }
      const playlist = await this.netease.sync(
        enrichedPreview,
        (p) => {
          checkpointed = true;
          this.store.savePlaylist(p);
          this.store.setValue('sync-checkpoint', JSON.stringify({ runId: run.id, playlist: p, at: stamp() }));
        },
        (message) => this.log(run, message)
      );
      if (!playlist) throw new Error('同步未返回已校验歌单，不能确认完成');
      this.store.savePlaylist(playlist);
      const admitted = new Set(playlist.albumIds);
      this.store.saveAlbums(sourceAlbums.map((a) => (admitted.has(a.id) ? { ...a, admittedMonth: a.admittedMonth ?? playlist.month } : a)));
      if (aiCuration) {
        saveLatestMonthlyDraft(this.store, {
          month: playlist.month,
          playlistName: playlist.name,
          engine: aiCuration.engine,
          ...(aiCuration.provider ? { provider: aiCuration.provider } : {}),
          ...(aiCuration.model ? { model: aiCuration.model } : {}),
          description: playlist.description ?? enrichedPreview.description ?? '',
          admitted: aiCuration.admitted,
          held: aiCuration.held,
          generatedAt: stamp()
        });
      }
      return playlist;
    };

    try {
      run.status = 'running';
      run.stage = 'starting';
      this.log(run, '任务开始');
      const settings = this.store.settings();
      const progress = (message: string) => this.log(run, message);

      if (run.mode === 'sync') {
        run.stage = 'validate';
        this.log(run, '校验最近预览、当前设置与曲目');
        let saved: SavedPreview | undefined;
        try {
          const raw = this.store.getValue('latest-preview');
          saved = raw ? (JSON.parse(raw) as SavedPreview) : undefined;
        } catch {
          throw new Error('已保存预览格式无效，请重新生成预览');
        }
        if (!saved?.usable || !saved.preview || Date.now() - Date.parse(saved.createdAt) > 30 * 60000 || !Number.isFinite(Date.parse(saved.createdAt))) {
          throw new Error('没有30分钟内的有效预览，请重新生成预览');
        }
        const stored = this.store.albums();
        if (saved.settingsHash !== hash(settings) || saved.albumsHash !== hash(stored)) {
          throw new Error('设置或专辑记录已变化，请重新生成预览');
        }
        const reevaluated = stored.map((a) => ({ ...a, decision: decide(a, settings, today(settings)) }));
        const preview = planSync(reevaluated, settings, this.store.playlists(), new Date(), saved.selection);
        if (hash(preview) !== hash(saved.preview)) {
          throw new Error('入选条件、月份或歌单已变化，请重新生成预览');
        }
        const targetIds = saved.selection?.albumIds?.length ? new Set(saved.selection.albumIds) : null;
        const fresh = preview.albums.filter((a) => !a.admittedMonth && !preview.existingPlaylist?.albumIds.includes(a.id) && (!targetIds || targetIds.has(a.id)));
        for (const album of fresh) {
          if (album.sources.some((o) => settings.sources[o.source] && o.status === 'ok' && !isObservationFresh(o))) {
            throw new Error('来源评分已过期，请重新生成预览');
          }
          if (album.decision?.status !== 'selected' || !album.match?.tracks.length) {
            throw new Error('预览含未通过核验的专辑');
          }
          const match = await this.netease.match(album, settings.lookbackDays);
          if (!match || hash(match) !== hash(album.match)) {
            throw new Error('网易云专辑或曲目已变化，请重新生成预览');
          }
        }
        run.preview = preview;
        if (!fresh.length) {
          run.status = 'succeeded';
          run.stage = 'complete';
          this.log(run, '没有新的可同步专辑，未创建空歌单');
          return;
        }
        // Consumes a preview before the first write; a retry must create a new one from persisted checkpoints.
        this.store.setValue('latest-preview', JSON.stringify({ ...saved, usable: false }));
        run.stage = 'write';
        this.log(run, '开始同步已核验专辑');
        await writeToNetease(preview, stored);
        run.status = 'succeeded';
        run.stage = 'complete';
        this.log(run, '同步与歌单回读校验完成');
      } else {
        let albums: Album[];
        let blocked = false;
        let incomplete = false;
        if (run.mode === 'library_preview' || run.mode === 'auto_sync') {
          run.stage = 'library';
          this.log(run, '评估资料库已保存的专辑与评分证据');
          const d = today(settings);
          albums = this.store.albums().map((a) => {
            const copy = structuredClone(a);
            for (const o of copy.sources) {
              if (settings.sources[o.source] && o.status === 'ok' && !isObservationFresh(o)) {
                o.status = 'error';
                o.notes = [o.notes, '评分记录已超过有效期，保留历史证据但需重新收录或采集后再参与筛选。'].filter(Boolean).join(' ');
              }
            }
            copy.decision = decide(copy, settings, d);
            return copy;
          });
          this.store.saveAlbums(albums);
        } else {
          run.stage = 'sources';
          this.log(run, '获取来源与交叉评分');
          const result = await this.sources.refresh(settings, this.store.albums(), progress, (status) => {
            this.store.saveSourceStatuses([...this.store.sourceStatuses().filter((s) => s.source !== status.source), status]);
          });
          this.store.saveSourceStatuses(result.statuses);
          albums = result.albums.map((a) => ({ ...a, decision: decide(a, settings, today(settings)) }));
          this.store.saveAlbums(albums);
          blocked = result.statuses.some((s) => s.status === 'blocked');
          incomplete = result.statuses.some((s) => ['error', 'blocked'].includes(s.status));
        }

        if (run.mode === 'preview' || run.mode === 'library_preview' || run.mode === 'auto_sync') {
          let effectiveSelection = selection;
          let aiCuration: MonthlyCurationResult | null = null;
          if (
            run.mode === 'auto_sync' &&
            !selection &&
            settings.playlist.aiCurated !== false &&
            this.aiClient &&
            getAiSettings(this.store as never).enabled
          ) {
            const existingPlaylists = this.store.playlists();
            const currentMonthStr = today(settings).slice(0, 7);
            const currentMonthPlaylist = existingPlaylists.find((p) => p.month === currentMonthStr);
            const currentIds = new Set(currentMonthPlaylist?.albumIds ?? []);
            const otherIds = new Set(existingPlaylists.filter((p) => p.month !== currentMonthStr).flatMap((p) => p.albumIds));
            const retainedCount = albums.filter((a) => currentIds.has(a.id) || a.admittedMonth === currentMonthStr).length;
            const eligibleFresh = albums.filter(
              (a) =>
                !a.excluded &&
                !isDismissed(a) &&
                a.decision?.status === 'selected' &&
                !a.admittedMonth &&
                !currentIds.has(a.id) &&
                !otherIds.has(a.id)
            );
            if (eligibleFresh.length) {
              run.stage = 'curation';
              this.log(run, '由 AI 对新增入选专辑做月度歌单把关');
              aiCuration = await curateMonthlyPlaylistAlbums(this.store, eligibleFresh, this.aiClient, {
                currentMonthCount: retainedCount,
                month: currentMonthStr
              });
              this.log(
                run,
                `月度策展（${aiCuration.engine === 'ai' ? `${aiCuration.provider}/${aiCuration.model}` : '本地规则'}）：拟入单 ${aiCuration.admittedAlbums.length} 张，暂缓 ${aiCuration.held.length} 张`
              );
              effectiveSelection = aiCuration.admittedAlbums.length
                ? { albumIds: aiCuration.admittedAlbums.map((a) => a.id) }
                : { albumIds: ['__ai_held_all__'] };
            }
          }

          run.stage = 'matching';
          this.log(run, '逐张匹配网易云完整专辑');
          const targetIds = effectiveSelection?.albumIds?.length ? new Set(effectiveSelection.albumIds) : null;
          for (const album of albums.filter(
            (a) =>
              !a.excluded &&
              a.decision?.status === 'selected' &&
              !a.admittedMonth &&
              (!targetIds || targetIds.has(a.id)) &&
              (run.mode !== 'auto_sync' || !isDismissed(a))
          )) {
            try {
              album.match = await this.netease.match(album, settings.lookbackDays);
              if (!album.match) {
                this.log(run, `${album.artist} — ${album.title}：没有唯一完整匹配，暂不写入`, 'warning');
              }
            } catch {
              album.match = null;
              incomplete = true;
              this.log(run, `${album.artist} — ${album.title}：网易云匹配失败`, 'warning');
            }
          }
          this.store.saveAlbums(albums);
          // Keep existing admissions, but never admit a dismissed album via an older catalog match.
          const planningAlbums = run.mode === 'auto_sync'
            ? albums.map((album) => isDismissed(album) ? { ...album, excluded: true } : album)
            : albums;
          const preview = planSync(planningAlbums, settings, this.store.playlists(), new Date(), effectiveSelection);
          run.preview = preview;
          if (run.mode === 'auto_sync') {
            const fresh = preview.albums.filter(
              (a) => !a.admittedMonth && !preview.existingPlaylist?.albumIds.includes(a.id) && Boolean(a.match?.tracks.length)
            );
            if (!fresh.length) {
              run.status = incomplete ? 'partial' : 'succeeded';
              run.stage = 'complete';
              this.log(run, incomplete ? '部分专辑匹配失败，暂无可自动同步的新增专辑' : '暂无新增待同步专辑', incomplete ? 'warning' : 'info');
              return;
            }
            run.stage = 'write';
            this.log(run, '自动写入当月网易云歌单');
            await writeToNetease(preview, this.store.albums(), aiCuration);
            run.status = incomplete ? 'partial' : 'succeeded';
            run.stage = 'complete';
            this.log(run, incomplete ? '部分新专已完成同步，个别曲目匹配失败' : '已自动同步至当月歌单', incomplete ? 'warning' : 'info');
            return;
          }
          this.store.setValue(
            'latest-preview',
            JSON.stringify({
              runId: run.id,
              createdAt: stamp(),
              settingsHash: hash(settings),
              albumsHash: hash(albums),
              preview,
              usable: !incomplete,
              ...(selection ? { selection } : {})
            } satisfies SavedPreview)
          );
        }

        const hasUsable = albums.some((a) => a.decision?.status === 'selected');
        run.status = blocked && !hasUsable ? 'waiting_verification' : incomplete ? 'partial' : 'succeeded';
        run.stage = run.status === 'waiting_verification' ? 'verification' : 'complete';
        this.log(
          run,
          run.status === 'succeeded'
            ? run.mode === 'library_preview'
              ? '资料库预览完成'
              : '任务完成'
            : run.status === 'waiting_verification'
              ? '来源需要人工验证，完成后请重试'
              : '部分来源或匹配尚未完成，未进行网易云写入',
          incomplete ? 'warning' : 'info'
        );
      }
    } catch (e) {
      run.status = writeStarted ? 'partial' : 'failed';
      run.stage = writeStarted ? 'partial_write' : 'error';
      const raw = e instanceof Error ? e.message : '任务失败';
      const safe = /token|cookie|private.?key|authorization|secret/i.test(raw) ? '连接请求失败，请检查配置' : raw.slice(0, 300);
      this.log(
        run,
        checkpointed ? `歌单已留下检查点，部分步骤未完成：${safe}` : writeStarted ? `写入可能已发生，请核对现有歌单后重试：${safe}` : safe,
        'error'
      );
    } finally {
      run.finishedAt = stamp();
      try {
        this.store.saveRun(run);
      } finally {
        this.store.releaseLock(run.id);
      }
    }
  }
}
