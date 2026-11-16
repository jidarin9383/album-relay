export type SourceName = 'aoty' | 'rym' | 'pitchfork';
export type SourceState = 'unknown' | 'ok' | 'missing' | 'blocked' | 'error' | 'running';
export interface Observation {
  source: SourceName; score: number | null; scale: number; votes: number | null;
  votesDisplay?: string; bestNewMusic?: boolean; url: string; observedAt: string;
  status: SourceState; notes?: string;
  votesApproximate?: boolean; collectionMethod?: 'browser-capture'; sourcePageUrl?: string;
}
export interface Track { id: string; originalId: number; name: string; duration?: number }
export interface MatchedAlbum { id: string; originalId: number; name: string; artist: string; releaseDate: string; tracks: Track[] }
export type ListeningStatus = 'unheard' | 'saved' | 'listened' | 'liked' | 'disliked' | 'skipped';
export interface Decision { status: 'selected' | 'pending' | 'disagreement' | 'excluded' | 'too_new' | 'out_of_window' | 'format_conflict'; qualifyingSources: SourceName[]; reasons: string[] }
export interface Album {
  id: string; artist: string; title: string; releaseDate: string; format: 'LP' | 'EP' | 'Reissue' | 'Unknown';
  coverUrl?: string; genres: string[]; sources: Observation[]; excluded: boolean;
  listeningStatus?: ListeningStatus;
  decision?: Decision; match?: MatchedAlbum | null; admittedMonth?: string; rationale?: string;
}
export interface Settings {
  allowApproximateVotes?: boolean;
  lookbackDays: number; minimumAgeDays: number; minSources: number;
  thresholds: { aoty: { score: number; votes: number; negative: number }; rym: { score: number; votes: number; negative: number }; pitchfork: { score: number; negative: number; allowBnm: boolean } };
  sources: Record<SourceName, boolean>;
  schedule: { enabled: boolean; weekday: number; hour: number; minute: number; timezone: string };
  playlist: { namePattern: string; descriptionMaxChars: number };
  requestDelayMs: number;
}
export interface SourceStatus { source: SourceName; status: SourceState; checkedAt?: string; message: string; coverage?: string }
export interface Playlist { month: string; id: string; originalId: number; name: string; url: string; albumIds: string[]; trackCount: number; updatedAt: string }
export type RunMode = 'refresh' | 'preview' | 'library_preview' | 'sync';
export type RunState = 'queued' | 'running' | 'waiting_verification' | 'partial' | 'succeeded' | 'failed' | 'cancelled';
export interface RunLog { at: string; level: 'info' | 'warning' | 'error'; message: string }
export interface SyncPreview { descriptionMaxChars?: number; month: string; playlistName: string; albums: Album[]; trackCount: number; existingPlaylist: Playlist | null; warnings: string[] }
export interface Run { id: string; mode: RunMode; status: RunState; stage: string; message: string; startedAt: string; finishedAt?: string; logs: RunLog[]; preview?: SyncPreview }
export interface ConnectionStatus { configured: boolean; loggedIn: boolean; message: string; checking?: boolean; qrCodeUrl?: string; loginState?: 'idle' | 'waiting' | 'authorized' | 'expired' | 'error' }
export interface Overview { albums: number; selected: number; pending: number; disagreements: number; playlists: Playlist[]; lastRun: Run | null; nextRun: string | null; sourceStatuses: SourceStatus[]; connection: ConnectionStatus }
export interface ChartCapture { source: SourceName; pageUrl: string; observedAt: string; albums: Album[]; warnings: string[]; conflicts?: Album[] }
export interface CaptureReceipt extends ChartCapture { id: string; added: number; updated: number }
/** Scheduled refresh performed by the user's own Chrome via the Album Relay extension. `{year}` expands to the current year. */
export interface ExtensionRefresh { enabled: boolean; hour: number; targets: string[] }
export interface ExtensionReport { source: SourceName; state: 'ok' | 'challenge' | 'error'; message: string; url: string; at: string }
export interface ExtensionState { paired: boolean; lastSeen?: string; version?: string; reports: ExtensionReport[]; refresh: ExtensionRefresh }
export type ExtensionCaptureResult = { status: 'captured'; receipt: CaptureReceipt } | { status: 'skipped'; reason: 'recent' };
