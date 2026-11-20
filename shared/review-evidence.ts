import type { Album, ReviewSnippet, SourceName } from './types.js';

const KNOWN_DOSSIER_HEADINGS = '声音质地|风格坐标|口碑拆解|适听与劝退';
const KNOWN_DOSSIER_INLINE_RE = new RegExp(
  `([^\\n])\\s*(?:(?:#{1,6}\\s*)|(?:[-*•]\\s*))?\\*{0,2}(【(?:${KNOWN_DOSSIER_HEADINGS})】)\\*{0,2}[ \\t]*[:：]?[ \\t]*`,
  'g'
);

/**
 * Normalizes and validates a captured review snippet, rejecting unpublished RYM drafts
 * and stripping leaked RYM `.review_publish_status` ("Published") suffixes.
 */
export function sanitizeReviewSnippet(snippet: ReviewSnippet, source?: SourceName): ReviewSnippet | null {
  let text = snippet.text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (/^\[?\s*(?:not\s+published|unpublished)\s*\]?(?:\s*\[Rating\d*\])?$/i.test(text)) {
    return null;
  }

  if ((source === 'rym' || source === undefined) && /Not published(?:\s*\[Rating\d*\])?$/.test(text)) {
    return null;
  }

  if (source === 'rym') {
    text = text.replace(/\s*Published(?:\s*\[Rating\d*\])?$/, '').trim();
  }

  if (!text || (source === 'rym' && text.length < 12)) {
    return null;
  }

  return { ...snippet, text };
}

/** Sanitizes and deduplicates review snippets while preserving order. */
export function sanitizeReviewSnippets(
  snippets: ReviewSnippet[] | undefined,
  source?: SourceName
): ReviewSnippet[] {
  if (!snippets?.length) return [];
  const out: ReviewSnippet[] = [];
  const seen = new Set<string>();
  for (const item of snippets) {
    const cleaned = sanitizeReviewSnippet(item, source);
    if (!cleaned) continue;
    const key = `${(cleaned.author ?? '').trim().toLowerCase()}\0${cleaned.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * Returns true when at least one source contains captured textual or detail-page descriptor
 * evidence, ensuring AI reviews never fabricate sound impressions from chart scores alone.
 */
export function hasAlbumReviewEvidence(album: Pick<Album, 'sources' | 'descriptors'>): boolean {
  return (album.sources ?? []).some(
    (s) =>
      Boolean(s.editorialSummary?.trim()) ||
      sanitizeReviewSnippets(s.reviewSnippets, s.source).length > 0 ||
      (Boolean(s.detailCaptured) &&
        Boolean((s.descriptors?.length ?? 0) > 0 || (album.descriptors?.length ?? 0) > 0))
  );
}

/** Normalizes single-block AI review fields, removing literal escaped newlines/tabs. */
export function normalizeAiInlineText(raw: string): string {
  return raw
    .replace(/\\r\\n|\\n|\\r|\\t|[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes AI longReview text so literal `\n\n` escapes, single newlines, or inline dossier
 * headings (`【声音质地】` etc.) reliably become clean `\n\n`-separated blocks.
 */
export function normalizeLongReview(raw: string): string {
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/(^|\n)(?:(?:#{1,6}\s*)|(?:[-*•]\s*))?\*{0,2}(【[^】\n]{1,12}】)\*{0,2}[ \t]*[:：]?[ \t]*(?:\n+(?!\s*【))?/g, '$1$2')
    .replace(KNOWN_DOSSIER_INLINE_RE, '$1\n\n$2')
    .replace(/\n(?!\n)(【[^】\n]{1,12}】)/g, '\n\n$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parses normalized AI `longReview` text into dossier sections or plain paragraphs. */
export function parseLongReviewBlocks(longReview: string): { label: string | null; body: string }[] {
  const normalized = normalizeLongReview(longReview);
  if (!normalized) return [];
  const blocks: { label: string | null; body: string }[] = [];
  for (const rawChunk of normalized.split(/\n{2,}/)) {
    const chunk = rawChunk.trim();
    if (!chunk) continue;
    const m = /^【([^】]{1,12})】\s*([\s\S]*)$/.exec(chunk);
    if (m) {
      const body = m[2]!.trim();
      if (!body) continue;
      blocks.push({ label: m[1]!.trim(), body });
    } else {
      blocks.push({ label: null, body: chunk });
    }
  }
  return blocks;
}
