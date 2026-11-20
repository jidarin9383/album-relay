import type { Album } from './types.js';

/**
 * Returns true when at least one source contains captured textual or detail-page descriptor
 * evidence, ensuring AI reviews never fabricate sound impressions from chart scores alone.
 */
export function hasAlbumReviewEvidence(album: Pick<Album, 'sources' | 'descriptors'>): boolean {
  return (album.sources ?? []).some(
    (s) =>
      Boolean(s.editorialSummary?.trim()) ||
      Boolean(s.reviewSnippets?.some((r) => r.text?.trim().length)) ||
      (Boolean(s.detailCaptured) &&
        Boolean((s.descriptors?.length ?? 0) > 0 || (album.descriptors?.length ?? 0) > 0))
  );
}
