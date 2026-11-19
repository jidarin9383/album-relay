export type SourceName = 'aoty' | 'rym' | 'pitchfork';
export type SourceState = 'unknown' | 'ok' | 'missing' | 'blocked' | 'error' | 'running';
export interface ReviewSnippet {
  author?: string;
  publication?: string;
  score?: number | null;
  text: string;
  kind: 'critic' | 'user';
}
export interface Observation {
  source: SourceName; score: number | null; scale: number; votes: number | null;
  votesDisplay?: string; bestNewMusic?: boolean; url: string; observedAt: string;
  status: SourceState; notes?: string;
  votesApproximate?: boolean; collectionMethod?: 'browser-capture'; sourcePageUrl?: string;
  criticScore?: number | null;
  criticVotes?: number | null;
  descriptors?: string[];
  editorialSummary?: string;
  reviewSnippets?: ReviewSnippet[];
  detailCaptured?: boolean;
}
export interface Track { id: string; originalId: number; name: string; duration?: number }
export interface MatchedAlbum { id: string; originalId: number; name: string; artist: string; releaseDate: string; tracks: Track[] }
export type ListeningStatus = 'unheard' | 'saved' | 'listened' | 'liked' | 'disliked' | 'skipped';
export interface Decision {
  status: 'selected' | 'pending' | 'disagreement' | 'excluded' | 'too_new' | 'out_of_window' | 'format_conflict';
  qualifyingSources: SourceName[];
  negativeSources?: SourceName[];
  reasons: string[];
}
export interface PlatformLink {
  url: string;
  direct: boolean;
  source: 'matched' | 'captured' | 'odesli' | 'search';
}
export interface ListenLinks {
  netease: PlatformLink;
  spotify: PlatformLink;
  youtubeMusic: PlatformLink;
}
export interface CapturedStreamingLinks {
  spotify?: string;
  youtubeMusic?: string;
  appleMusic?: string;
  bandcamp?: string;
}
export interface AlbumAiReview {
  albumId: string;
  evidenceHash: string;
  evidenceLevel: 'full' | 'scores_only';
  shortReview: string;
  longReview: string;
  audienceSummary?: string;
  criticSummary?: string;
  model: string;
  generatedAt: string;
}
export type AiProviderKind = 'ollama' | 'gemini' | 'openai_compatible';
export interface AiSettings {
  enabled: boolean;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey?: boolean;
  autoReviewSelected: boolean;
  timeoutMs: number;
}
export interface AiConnectionCheck {
  ok: boolean;
  message: string;
  models: string[];
  checkedAt: string;
}
export interface Album {
  id: string; artist: string; title: string; releaseDate: string; format: 'LP' | 'EP' | 'Reissue' | 'Unknown';
  coverUrl?: string; genres: string[]; sources: Observation[]; excluded: boolean;
  listeningStatus?: ListeningStatus;
  decision?: Decision; match?: MatchedAlbum | null; admittedMonth?: string; rationale?: string;
  descriptors?: string[];
  capturedLinks?: CapturedStreamingLinks;
  listenLinks?: ListenLinks;
  aiReview?: AlbumAiReview | null;
}
export interface Settings {
  allowApproximateVotes?: boolean;
  allowSingleSourceAcclaim?: boolean;
  autoSyncPlaylist?: boolean;
  lookbackDays: number; minimumAgeDays: number; minSources: number;
  thresholds: { aoty: { score: number; votes: number; negative: number }; rym: { score: number; votes: number; negative: number }; pitchfork: { score: number; negative: number; allowBnm: boolean } };
  sources: Record<SourceName, boolean>;
  schedule: { enabled: boolean; weekday: number; hour: number; minute: number; timezone: string };
  playlist: {
    namePattern: string;
    descriptionMaxChars: number;
    aiCurated?: boolean;
    aiDescription?: boolean;
    maxAlbumsPerMonth?: number;
  };
  requestDelayMs: number;
}
export interface SourceStatus { source: SourceName; status: SourceState; checkedAt?: string; message: string; coverage?: string }
export interface Playlist { month: string; id: string; originalId: number; name: string; url: string; albumIds: string[]; trackCount: number; updatedAt: string; description?: string }
export type RunMode = 'refresh' | 'preview' | 'library_preview' | 'sync' | 'auto_sync';
export type RunState = 'queued' | 'running' | 'waiting_verification' | 'partial' | 'succeeded' | 'failed' | 'cancelled';
export interface RunLog { at: string; level: 'info' | 'warning' | 'error'; message: string }
export interface SyncSelection { recommendationSetId?: string; albumIds: string[] }
export interface SyncPreview { descriptionMaxChars?: number; description?: string; month: string; playlistName: string; albums: Album[]; trackCount: number; existingPlaylist: Playlist | null; warnings: string[]; selection?: SyncSelection }
export interface MonthlyAiDraftItem {
  albumId: string;
  artist: string;
  title: string;
  decision: 'admit' | 'hold' | 'retained';
  reason: string;
}
export interface MonthlyAiDraft {
  month: string;
  playlistName: string;
  engine: 'ai' | 'heuristic';
  provider?: AiProviderKind;
  model?: string;
  description: string;
  admitted: MonthlyAiDraftItem[];
  held: MonthlyAiDraftItem[];
  generatedAt: string;
}
export interface Run { id: string; mode: RunMode; status: RunState; stage: string; message: string; startedAt: string; finishedAt?: string; logs: RunLog[]; preview?: SyncPreview }
export interface ConnectionStatus { configured: boolean; loggedIn: boolean; message: string; checking?: boolean; qrCodeUrl?: string; loginState?: 'idle' | 'waiting' | 'authorized' | 'expired' | 'error' }
export interface Overview { albums: number; selected: number; pending: number; disagreements: number; playlists: Playlist[]; lastRun: Run | null; nextRun: string | null; sourceStatuses: SourceStatus[]; connection: ConnectionStatus }
export interface ChartCapture { source: SourceName; pageUrl: string; observedAt: string; albums: Album[]; warnings: string[]; conflicts?: Album[] }
export interface CaptureReceipt extends ChartCapture { id: string; added: number; updated: number }
/** Scheduled refresh performed by the user's own Chrome via the Album Relay extension. `{year}` expands to the current year. */
export interface ExtensionRefresh {
  enabled: boolean;
  hour: number;
  targets: string[];
  detailBackfill?: boolean;
  detailBatchSize?: number;
}
export interface ExtensionReport { source: SourceName; state: 'ok' | 'challenge' | 'error'; message: string; url: string; at: string }
export interface ExtensionState {
  paired: boolean;
  lastSeen?: string;
  version?: string;
  reports: ExtensionReport[];
  refresh: ExtensionRefresh;
  pendingDetailCount?: number;
}
export type ExtensionCaptureResult = { status: 'captured'; receipt: CaptureReceipt } | { status: 'skipped'; reason: 'recent' };
