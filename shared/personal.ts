import type { Album, SourceName } from './types.js';

export type ImportSource = 'netease' | 'spotify' | 'youtube_music' | 'rym_export' | 'generic';
export type ImportRowOutcome = 'accepted' | 'duplicate' | 'unsupported' | 'rejected';
export type FeedbackQueueState = 'unheard' | 'saved' | 'listened' | 'skipped';
export type FeedbackReaction = 'liked' | 'neutral' | 'disliked';

export interface ImportBatchSummary {
  id: string;
  source: ImportSource;
  accountAlias: string;
  fileName: string;
  fileSha256: string;
  parserVersion: string;
  status: 'committed' | 'failed';
  totalRows: number;
  acceptedCount: number;
  duplicateCount: number;
  unsupportedCount: number;
  rejectedCount: number;
  listensAdded: number;
  signalsAdded: number;
  notes: string[];
  createdAt: string;
  completedAt: string | null;
  idempotentReplay?: boolean;
}

export interface AffinityEntry {
  key: string;
  name: string;
  score: number;
  listenCount: number;
  recentListenCount: number;
  signalCount: number;
}

export interface MetadataCoverage {
  totalCandidates: number;
  eligibleCandidates: number;
  candidatesWithGenres: number;
  genreCoverageRatio: number;
  listeningEventsCount: number;
  preferenceSignalsCount: number;
  importBatchesCount: number;
  personalArtistsTotal: number;
  personalArtistsWithGenres: number;
  ambiguousArtistsCount: number;
}

export interface ArtistGenreCandidate {
  wikidataId: string;
  mbid?: string;
  label: string;
  genres: string[];
}

export interface ArtistGenreSummary {
  artistNorm: string;
  artistName: string;
  genres: string[];
  source: string;
  status: 'resolved' | 'manual' | 'ambiguous' | 'not_found' | 'pending';
  confidence: 'high' | 'medium' | 'low';
  candidates?: ArtistGenreCandidate[];
  updatedAt: string;
}

export interface EnrichmentResult {
  scannedArtists: number;
  resolvedCount: number;
  ambiguousCount: number;
  notFoundCount: number;
  remainingPendingCount: number;
  profile: TasteProfile;
}

export interface CorroborationItem {
  album: Album;
  qualifyingSources: SourceName[];
  missingSources: SourceName[];
  personalScore: number;
  matchedArtists: string[];
  matchedGenres: string[];
  searchLinks: { source: SourceName; url: string }[];
}

export interface TasteProfile {
  revision: string;
  generatedAt: string;
  coldStart: boolean;
  topArtistsLongTerm: AffinityEntry[];
  topArtistsRecent: AffinityEntry[];
  topGenres: AffinityEntry[];
  likedCount: number;
  dislikedCount: number;
  savedCount: number;
  coverage: MetadataCoverage;
}

export interface RecommendationBreakdown {
  artistAffinity: number;
  genreOverlap: number;
  referenceBoost: number;
  explorationBonus: number;
  totalScore: number;
  matchedArtists: string[];
  matchedGenres: string[];
}

export interface RecommendationItem {
  rank: number;
  album: Album;
  slotType: 'preference' | 'exploration';
  matchIndex: number;
  confidence: 'high' | 'medium' | 'low';
  qualifyingSources: SourceName[];
  reasons: string[];
  breakdown: RecommendationBreakdown;
}

export interface TastePersona {
  profileRevision: string;
  summary: string;
  sonicSignatures: string[];
  preferredGenres: string[];
  avoidances: string[];
  explorationAngles: string[];
  model: string;
  generatedAt: string;
}

export interface RecommendationSet {
  id: string;
  createdAt: string;
  profileRevision: string;
  coldStart: boolean;
  preferenceSlots: number;
  explorationSlots: number;
  eligibleCount: number;
  coverage: MetadataCoverage;
  notes: string[];
  items: RecommendationItem[];
  engine?: 'ai' | 'heuristic';
  model?: string;
  persona?: TastePersona | null;
}

export interface PersonalOverview {
  profile: TasteProfile;
  batches: ImportBatchSummary[];
  recommendations: RecommendationSet[];
  artistMetadata: ArtistGenreSummary[];
  corroborationQueue: CorroborationItem[];
  persona?: TastePersona | null;
  aiEnabled?: boolean;
}

export interface CorroborationRunResult {
  mergedDuplicates: number;
  datesOrFormatsFilled: number;
  pitchforkMatched: number;
  newlySelectedCount: number;
  archivedOutOfWindowCount: number;
  directUrlsResolved: number;
  overview: PersonalOverview;
}
