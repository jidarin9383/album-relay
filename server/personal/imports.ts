import { createHash, randomUUID } from 'node:crypto';
import type { ImportBatchSummary, ImportRowOutcome, ImportSource } from '../../shared/personal.js';
import type { Store } from '../store.js';
import { normalizeIdentity } from '../sources/parsers.js';

const PARSER_VERSION = '1.1.0';
const RAW_AUDIT_LIMIT = 2000;

interface ListenCandidate {
  source: ImportSource;
  artist: string;
  artistNorm: string;
  track: string;
  trackNorm: string;
  album: string;
  albumNorm: string;
  playedAt: string;
  msPlayed: number | null;
  timestampPrecision: 'second' | 'minute' | 'hour' | 'day' | 'unknown';
  sourceEventKey: string;
}

interface SignalCandidate {
  source: ImportSource;
  entityType: 'album' | 'track' | 'artist';
  artist: string;
  artistNorm: string;
  title: string;
  titleNorm: string;
  album: string;
  albumNorm: string;
  genres: string[];
  reaction: 'liked' | 'neutral' | 'disliked';
  rating: number | null;
  weight: number;
  actionAt: string | null;
  context: string;
  sourceSignalKey: string;
}

interface ParsedRow {
  rowIndex: number;
  outcome: ImportRowOutcome;
  reason?: string;
  fingerprint?: string;
  raw: unknown;
  listen?: ListenCandidate;
  signal?: SignalCandidate;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const SPOTIFY_ARTIST_ID_RE = /^[A-Za-z0-9]{22}$/;

export function parseCsv(content: string): Record<string, string>[] {
  const clean = content.replace(/^\uFEFF/, '');
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (clean[i + 1] === '\n') i++;
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    matrix.push(row);
  }
  if (!matrix.length) return [];
  const headers = matrix[0]!.map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cols = matrix[r]!;
    if (cols.every((c) => !c.trim())) continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] || `col_${c}`;
      rec[key] = (cols[c] ?? '').trim();
    }
    out.push(rec);
  }
  return out;
}

function normalizeHeaderKey(key: string): string {
  return key.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

interface RowLookup {
  get(...keys: string[]): string;
  has(...keys: string[]): boolean;
}

function createRowLookup(row: Record<string, string>): RowLookup {
  const exact = new Map<string, string>();
  const compact = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    const lk = k.replace(/^\uFEFF/, '').trim().toLowerCase();
    const ck = normalizeHeaderKey(k);
    if (!exact.has(lk) || v) exact.set(lk, v);
    if (!compact.has(ck) || v) compact.set(ck, v);
  }
  return {
    get(...keys: string[]): string {
      for (const k of keys) {
        const exactVal = exact.get(k.trim().toLowerCase());
        if (exactVal) return exactVal;
        const compactVal = compact.get(normalizeHeaderKey(k));
        if (compactVal) return compactVal;
      }
      return '';
    },
    has(...keys: string[]): boolean {
      return keys.some((k) => exact.has(k.trim().toLowerCase()) || compact.has(normalizeHeaderKey(k)));
    }
  };
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  return createRowLookup(row).get(...keys);
}

function hasHeader(row: Record<string, string>, ...keys: string[]): boolean {
  return createRowLookup(row).has(...keys);
}

function parseFlexibleTimestamp(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return NaN;
  const normalized = trimmed.includes('T')
    ? trimmed
    : /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}:00Z`
      : /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(trimmed)
        ? `${trimmed.replace(' ', 'T')}Z`
        : trimmed;
  return Date.parse(normalized);
}

const ARTIST_HEADER_KEYS = ['Artist name', 'Artist Name(s)', 'Artist Names', 'Artist', 'Artists', 'Channel Name', '歌手', '艺人', '歌手名'];
const TRACK_HEADER_KEYS = ['Track name', 'Song Title', 'Video Title', 'Title', 'Track', 'Song', 'Name', '歌曲标题', '歌名', '歌曲', '标题'];
const ALBUM_HEADER_KEYS = ['Album', 'Album Name', 'Album Title', 'Release', '专辑', '专辑名'];

function acceptSignal(rowIndex: number, raw: unknown, signal: SignalCandidate): ParsedRow {
  return { rowIndex, outcome: 'accepted', fingerprint: signal.sourceSignalKey, raw, signal };
}

function parseStructuredRow(
  r: Record<string, string>,
  rowIndex: number,
  source: ImportSource,
  alias: string,
  occMap: Map<string, number>
): ParsedRow {
  const cols = createRowLookup(r);
  const rawArtist = cols.get(...ARTIST_HEADER_KEYS);
  const artistCol = rawArtist.includes(';')
    ? rawArtist.split(';').map((s) => s.trim()).filter(Boolean).join(' / ')
    : rawArtist;
  const titleCol = cols.get(...TRACK_HEADER_KEYS);
  const albumCol = cols.get(...ALBUM_HEADER_KEYS);
  const playlistCol = cols.get('Playlist name', 'Playlist', '歌单', '播放列表');
  const typeCol = cols.get('Type', 'Kind', '类型').toLowerCase();
  const platformId = cols.get('Spotify - id', 'Spotify ID', 'Track URI', 'Track ID', 'Video ID', 'ISRC', 'id');
  const genres = splitGenres(cols.get('Genres', 'Genre', '流派', '风格'));
  const playedAtRaw = cols.get('playedAt', 'played_at', 'ts', 'endTime', 'watchedAt', 'watched_at');
  const actionAt = cols.get('Added At', 'addedAt', 'actionAt', 'Liked At', 'Date', 'Playlist Video Creation Timestamp', '时间', '收藏时间') || null;

  // 1. Empty metadata platform row (e.g. deleted/unavailable Spotify track keeping only ID/playlist)
  if (!artistCol && !titleCol && !albumCol) {
    return platformId || playlistCol || typeCol
      ? { rowIndex, outcome: 'unsupported', reason: '曲目与艺人元数据为空（可能已在原平台下架）', raw: r }
      : { rowIndex, outcome: 'rejected', reason: '缺少艺人或曲目名称', raw: r };
  }

  // 2. Listening history event row
  if (typeCol === 'listen' || (!typeCol && Boolean(playedAtRaw))) {
    const track = titleCol || albumCol;
    const artistNorm = normalizeIdentity(artistCol);
    const trackNorm = normalizeIdentity(track);
    const albumNorm = normalizeIdentity(albumCol);
    const tsMs = parseFlexibleTimestamp(playedAtRaw);
    if (!artistNorm || !trackNorm || !Number.isFinite(tsMs)) {
      return { rowIndex, outcome: 'rejected', reason: 'listen 行缺少艺人、曲目或有效 playedAt 时间戳', raw: r };
    }
    const msRaw = cols.get('msPlayed', 'ms_played');
    const msPlayed = msRaw && Number.isFinite(Number(msRaw)) ? Number(msRaw) : null;
    if (msPlayed !== null && msPlayed < 15_000) {
      return { rowIndex, outcome: 'unsupported', reason: '播放不足 15 秒，不计入偏好', raw: r };
    }
    const playedAt = new Date(tsMs).toISOString();
    const occBase = `${artistNorm}|${trackNorm}|${playedAt}|${msPlayed ?? 0}`;
    const occ = (occMap.get(occBase) ?? 0) + 1;
    occMap.set(occBase, occ);
    const sourceEventKey = `${source}:${alias}:listen:${artistNorm}:${trackNorm}:${playedAt}:${msPlayed ?? 0}:occ:${occ}`;
    return {
      rowIndex,
      outcome: 'accepted',
      fingerprint: sourceEventKey,
      raw: r,
      listen: {
        source,
        artist: artistCol,
        artistNorm,
        track,
        trackNorm,
        album: albumCol,
        albumNorm,
        playedAt,
        msPlayed,
        timestampPrecision: 'second',
        sourceEventKey
      }
    };
  }

  const ratingStr = cols.get('Rating', 'Score', 'User Rating', '评分');
  const scaleStr = cols.get('Scale', '满分');
  const ratingNum = ratingStr ? Number.parseFloat(ratingStr) : NaN;
  const hasRating = Number.isFinite(ratingNum) && (ratingNum > 0 || source === 'generic');
  const r10 = hasRating ? normalizeRating10(ratingNum, scaleStr ? Number.parseFloat(scaleStr) : undefined) : null;
  const reaction: 'liked' | 'neutral' | 'disliked' =
    r10 === null ? 'liked' : r10 >= 7.5 ? 'liked' : r10 <= 4.0 ? 'disliked' : 'neutral';
  const ratingWeight = r10 !== null ? Number(((r10 - 6.0) * 0.8).toFixed(2)) : null;

  // 3. Artist favorite row (TuneMyMusic / Soundiiz puts Artist name inside Track name when Type=Artist)
  if (
    typeCol === 'artist' ||
    typeCol === 'favorite_artist' ||
    (!artistCol && Boolean(titleCol) && /^(?:favorite|followed)\s+artists?$|关注歌手|收藏歌手|关注的艺人/i.test(playlistCol.trim()))
  ) {
    const actualArtist = artistCol || titleCol;
    const artistNorm = normalizeIdentity(actualArtist);
    if (!artistNorm) return { rowIndex, outcome: 'rejected', reason: '缺少艺人名称', raw: r };
    return acceptSignal(rowIndex, r, {
      source,
      entityType: 'artist',
      artist: actualArtist,
      artistNorm,
      title: actualArtist,
      titleNorm: artistNorm,
      album: '',
      albumNorm: '',
      genres,
      reaction,
      rating: r10,
      weight: ratingWeight ?? 1.8,
      actionAt,
      context: `${source}-csv-artist`,
      sourceSignalKey: `${source}:${alias}:artist:${artistNorm}`
    });
  }

  // 4. Album favorite / rated album row
  const hasTrackHeader = cols.has('Track name', 'Song Title', 'Video Title', 'track', 'song');
  if (
    typeCol === 'album' ||
    typeCol === 'favorite_album' ||
    (typeCol === 'rating' && !hasTrackHeader) ||
    /^(?:favorite|saved)\s+albums?$|收藏专辑/i.test(playlistCol.trim()) ||
    (!titleCol && Boolean(albumCol)) ||
    (source === 'generic' && !typeCol && !hasTrackHeader)
  ) {
    const actualAlbum = albumCol || titleCol;
    const artistNorm = normalizeIdentity(artistCol);
    const albumNorm = normalizeIdentity(actualAlbum);
    if (!artistNorm || !albumNorm) return { rowIndex, outcome: 'rejected', reason: '缺少艺人或专辑名称', raw: r };
    return acceptSignal(rowIndex, r, {
      source,
      entityType: 'album',
      artist: artistCol,
      artistNorm,
      title: actualAlbum,
      titleNorm: albumNorm,
      album: actualAlbum,
      albumNorm,
      genres,
      reaction,
      rating: r10,
      weight: ratingWeight ?? 1.6,
      actionAt,
      context: `${source}-csv-album`,
      sourceSignalKey: `${source}:${alias}:album:${artistNorm}:${albumNorm}`
    });
  }

  // 5. Track favorite / playlist row (default)
  let resolvedArtist = artistCol;
  let resolvedTitle = titleCol;
  if (!resolvedArtist && source === 'youtube_music' && resolvedTitle.includes(' - ')) {
    const sepIdx = resolvedTitle.indexOf(' - ');
    resolvedArtist = resolvedTitle.slice(0, sepIdx).trim();
    resolvedTitle = resolvedTitle.slice(sepIdx + 3).trim();
  }
  const album = albumCol || resolvedTitle;
  const artistNorm = normalizeIdentity(resolvedArtist);
  const titleNorm = normalizeIdentity(resolvedTitle);
  const albumNorm = normalizeIdentity(album);
  if (!artistNorm || !titleNorm) {
    return { rowIndex, outcome: 'rejected', reason: '缺少艺人或曲目名称', raw: r };
  }
  return acceptSignal(rowIndex, r, {
    source,
    entityType: 'track',
    artist: resolvedArtist,
    artistNorm,
    title: resolvedTitle,
    titleNorm,
    album,
    albumNorm,
    genres,
    reaction,
    rating: r10,
    weight: ratingWeight ?? 1.0,
    actionAt,
    context: `${source}-csv-track`,
    sourceSignalKey: `${source}:${alias}:track:${artistNorm}:${titleNorm}:${albumNorm}`
  });
}

function parseStructuredRecordList(list: Record<string, string>[], source: ImportSource, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const occMap = new Map<string, number>();
  return { rows: list.map((r, idx) => parseStructuredRow(r, idx, source, alias, occMap)), notes: [] };
}

function parseStructuredMusicCsv(content: string, source: ImportSource, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const csvRows = parseCsv(content);
  if (!csvRows.length) throw new Error('CSV 文件中未找到可解析的数据行');
  return parseStructuredRecordList(csvRows, source, alias);
}

function splitGenres(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((g) => text(g)).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    return [...new Set(raw.split(/[,;/|]+/).map((s) => s.trim()).filter(Boolean))];
  }
  return [];
}

function normalizeRating10(ratingVal: number, scaleVal?: number): number {
  const scale = scaleVal && scaleVal > 0 ? scaleVal : ratingVal <= 5 ? 5 : ratingVal > 10 ? 100 : 10;
  return Number(Math.max(0, Math.min(10, (ratingVal / scale) * 10)).toFixed(2));
}

function parseNeteaseRows(content: string, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  const rows: ParsedRow[] = [];
  const notes: string[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('网易云 JSON 内容无法解析，请确认复制或导出了完整 JSON');
    }
    const root = obj(parsed);
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(obj(root.playlist).tracks)
        ? (obj(root.playlist).tracks as unknown[])
        : Array.isArray(root.tracks)
          ? (root.tracks as unknown[])
          : Array.isArray(obj(root.data).records)
            ? (obj(root.data).records as unknown[])
            : Array.isArray(root.data)
              ? (root.data as unknown[])
              : [];
    if (!list.length) throw new Error('JSON 中未找到网易云歌曲列表（tracks / records）');
    list.forEach((raw, idx) => {
      const r = obj(raw);
      const artistsList = Array.isArray(r.artists) ? r.artists : Array.isArray(r.ar) ? r.ar : null;
      const artist = artistsList
        ? artistsList.map((a) => (typeof a === 'string' ? a : text(obj(a).name))).filter(Boolean).join(' / ')
        : text(r.artist) || text(r.artistName);
      const title = text(r.name) || text(r.title) || text(r.songName);
      const albumObj = obj(r.album ?? r.al);
      const album = text(albumObj.name) || (typeof r.album === 'string' ? text(r.album) : '') || text(r.albumName) || title;
      const artistNorm = normalizeIdentity(artist), titleNorm = normalizeIdentity(title), albumNorm = normalizeIdentity(album);
      if (!artistNorm || !titleNorm) {
        rows.push({ rowIndex: idx, outcome: 'rejected', reason: '缺少艺人或曲目名称', raw });
        return;
      }
      const key = `netease:${alias}:track:${artistNorm}:${titleNorm}:${albumNorm}`;
      rows.push({
        rowIndex: idx,
        outcome: 'accepted',
        fingerprint: key,
        raw,
        signal: {
          source: 'netease',
          entityType: 'track',
          artist,
          artistNorm,
          title,
          titleNorm,
          album,
          albumNorm,
          genres: splitGenres(r.genres ?? r.genre),
          reaction: 'liked',
          rating: null,
          weight: 1.0,
          actionAt: text(r.addedAt) || text(r.likedAt) || null,
          context: 'netease-json',
          sourceSignalKey: key
        }
      });
    });
    return { rows, notes };
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  const firstLine = lines[0]?.toLowerCase() ?? '';
  if (firstLine.includes(',') && /(artist|歌手|艺人|title|track|song|歌名|歌曲|album|专辑)/.test(firstLine)) {
    return parseStructuredMusicCsv(trimmed, 'netease', alias);
  }

  lines.forEach((line, idx) => {
    const match = /^(.+?)\s*(?:-|—|–)\s*(.+)$/.exec(line.trim());
    if (!match) {
      rows.push({ rowIndex: idx, outcome: 'rejected', reason: '请使用「艺人 - 曲目或专辑」格式，或导入 JSON / CSV', raw: line });
      return;
    }
    const artist = match[1]!.trim(), title = match[2]!.trim();
    const artistNorm = normalizeIdentity(artist), titleNorm = normalizeIdentity(title);
    if (!artistNorm || !titleNorm) {
      rows.push({ rowIndex: idx, outcome: 'rejected', reason: '艺人或名称为空', raw: line });
      return;
    }
    const key = `netease:${alias}:text:${artistNorm}:${titleNorm}`;
    rows.push({
      rowIndex: idx,
      outcome: 'accepted',
      fingerprint: key,
      raw: line,
      signal: {
        source: 'netease',
        entityType: 'track',
        artist,
        artistNorm,
        title,
        titleNorm,
        album: title,
        albumNorm: titleNorm,
        genres: [],
        reaction: 'liked',
        rating: null,
        weight: 1.2,
        actionAt: null,
        context: 'netease-text',
        sourceSignalKey: key
      }
    });
  });
  return { rows, notes };
}

function parseSpotifyRows(content: string, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    if (trimmed.includes(',')) return parseStructuredMusicCsv(trimmed, 'spotify', alias);
    throw new Error('Spotify 文件无法识别，请上传 Streaming_History_Audio_*.json / YourLibrary.json 或 TuneMyMusic / Exportify 导出的 CSV');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Spotify JSON 内容无法解析，请确认上传了完整的 Streaming_History_Audio_*.json 或 YourLibrary.json');
  }
  const rows: ParsedRow[] = [];
  const notes: string[] = [];

  if (!Array.isArray(parsed)) {
    const lib = obj(parsed);
    const tracks = Array.isArray(lib.tracks) ? lib.tracks : [];
    const albums = Array.isArray(lib.albums) ? lib.albums : [];
    const artists = Array.isArray(lib.artists) ? lib.artists : [];
    if (!tracks.length && !albums.length && !artists.length) {
      throw new Error('未在 Spotify JSON 中找到数组记录或 YourLibrary tracks/albums/artists 字段');
    }
    let idx = 0;
    for (const raw of tracks) {
      const r = obj(raw);
      const artist = text(r.artist), title = text(r.track), album = text(r.album) || title;
      const artistNorm = normalizeIdentity(artist), titleNorm = normalizeIdentity(title), albumNorm = normalizeIdentity(album);
      if (!artistNorm || !titleNorm) {
        rows.push({ rowIndex: idx++, outcome: 'rejected', reason: '缺少艺人或曲目名称', raw });
        continue;
      }
      const key = `spotify:${alias}:lib-track:${artistNorm}:${titleNorm}:${albumNorm}`;
      rows.push({
        rowIndex: idx++,
        outcome: 'accepted',
        fingerprint: key,
        raw,
        signal: {
          source: 'spotify',
          entityType: 'track',
          artist,
          artistNorm,
          title,
          titleNorm,
          album,
          albumNorm,
          genres: [],
          reaction: 'liked',
          rating: null,
          weight: 1.0,
          actionAt: null,
          context: 'spotify-library-track',
          sourceSignalKey: key
        }
      });
    }
    for (const raw of albums) {
      const r = obj(raw);
      const artist = text(r.artist), album = text(r.album);
      const artistNorm = normalizeIdentity(artist), albumNorm = normalizeIdentity(album);
      if (!artistNorm || !albumNorm) {
        rows.push({ rowIndex: idx++, outcome: 'rejected', reason: '缺少艺人或专辑名称', raw });
        continue;
      }
      const key = `spotify:${alias}:lib-album:${artistNorm}:${albumNorm}`;
      rows.push({
        rowIndex: idx++,
        outcome: 'accepted',
        fingerprint: key,
        raw,
        signal: {
          source: 'spotify',
          entityType: 'album',
          artist,
          artistNorm,
          title: album,
          titleNorm: albumNorm,
          album,
          albumNorm,
          genres: [],
          reaction: 'liked',
          rating: null,
          weight: 1.6,
          actionAt: null,
          context: 'spotify-library-album',
          sourceSignalKey: key
        }
      });
    }
    for (const raw of artists) {
      const r = obj(raw);
      const artist = typeof raw === 'string' ? raw.trim() : text(r.name) || text(r.artist);
      const artistNorm = normalizeIdentity(artist);
      if (!artistNorm) {
        rows.push({ rowIndex: idx++, outcome: 'rejected', reason: '缺少艺人名称', raw });
        continue;
      }
      const key = `spotify:${alias}:lib-artist:${artistNorm}`;
      rows.push({
        rowIndex: idx++,
        outcome: 'accepted',
        fingerprint: key,
        raw,
        signal: {
          source: 'spotify',
          entityType: 'artist',
          artist,
          artistNorm,
          title: artist,
          titleNorm: artistNorm,
          album: '',
          albumNorm: '',
          genres: [],
          reaction: 'liked',
          rating: null,
          weight: 1.8,
          actionAt: null,
          context: 'spotify-library-artist',
          sourceSignalKey: key
        }
      });
    }
    return { rows, notes };
  }

  const occMap = new Map<string, number>();
  parsed.forEach((raw, idx) => {
    const r = obj(raw);
    const track = text(r.master_metadata_track_name) || text(r.trackName);
    const artist = text(r.master_metadata_album_artist_name) || text(r.artistName);
    const album = text(r.master_metadata_album_album_name) || text(r.albumName);
    const nonMusic = Boolean(r.episode_name || r.episode_show_name || r.audiobook_title || r.audiobook_chapter_title);
    if (nonMusic && !track) {
      rows.push({ rowIndex: idx, outcome: 'unsupported', reason: '播客或有声书内容不计入音乐品味', raw });
      return;
    }
    const tsRaw = text(r.ts) || text(r.endTime);
    const tsMs = Date.parse(tsRaw.includes('T') ? tsRaw : tsRaw ? `${tsRaw.replace(' ', 'T')}:00Z` : '');
    const artistNorm = normalizeIdentity(artist), trackNorm = normalizeIdentity(track), albumNorm = normalizeIdentity(album);
    if (!artistNorm || !trackNorm || !Number.isFinite(tsMs)) {
      rows.push({ rowIndex: idx, outcome: 'rejected', reason: '缺少艺人、曲目或有效时间戳', raw });
      return;
    }
    const msPlayed = typeof r.ms_played === 'number' ? r.ms_played : typeof r.msPlayed === 'number' ? r.msPlayed : null;
    if (msPlayed !== null && msPlayed < 15_000) {
      rows.push({ rowIndex: idx, outcome: 'unsupported', reason: '播放不足 15 秒跳过，不计入偏好', raw });
      return;
    }
    const playedAt = new Date(tsMs).toISOString();
    const occBase = `${artistNorm}|${trackNorm}|${playedAt}|${msPlayed ?? 0}`;
    const occ = (occMap.get(occBase) ?? 0) + 1;
    occMap.set(occBase, occ);
    const sourceEventKey = `spotify:${alias}:${artistNorm}:${trackNorm}:${playedAt}:${msPlayed ?? 0}:occ:${occ}`;
    rows.push({
      rowIndex: idx,
      outcome: 'accepted',
      fingerprint: sourceEventKey,
      raw,
      listen: {
        source: 'spotify',
        artist,
        artistNorm,
        track,
        trackNorm,
        album,
        albumNorm,
        playedAt,
        msPlayed,
        timestampPrecision: r.ts ? 'second' : 'minute',
        sourceEventKey
      }
    });
  });
  return { rows, notes };
}

function parseYoutubeMusicRows(content: string, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  const rows: ParsedRow[] = [];
  const notes: string[] = [];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('YouTube Music JSON 无法解析，请确认上传完整的 Google Takeout watch-history.json');
    }
    if (!Array.isArray(parsed)) throw new Error('watch-history.json 顶层应为 JSON 数组');
    const occMap = new Map<string, number>();
    parsed.forEach((raw, idx) => {
      const r = obj(raw);
      const header = text(r.header);
      if (header && !/youtube music/i.test(header)) {
        rows.push({ rowIndex: idx, outcome: 'unsupported', reason: '非 YouTube Music 播放记录', raw });
        return;
      }
      const rawTitle = text(r.title).replace(/^(?:Watched |Played |收看了 |播放了 )/i, '').trim();
      const subs = Array.isArray(r.subtitles) ? r.subtitles : [];
      let artist = text(obj(subs[0]).name).replace(/\s*-\s*Topic$/i, '').trim();
      let track = rawTitle;
      if (!artist && rawTitle.includes(' - ')) {
        const parts = rawTitle.split(' - ');
        artist = parts[0]!.trim();
        track = parts.slice(1).join(' - ').trim();
      }
      const timeRaw = text(r.time);
      const tsMs = Date.parse(timeRaw);
      const artistNorm = normalizeIdentity(artist), trackNorm = normalizeIdentity(track);
      if (!artistNorm || !trackNorm || !Number.isFinite(tsMs)) {
        rows.push({ rowIndex: idx, outcome: 'rejected', reason: '缺少艺人、歌曲标题或有效播放时间', raw });
        return;
      }
      const playedAt = new Date(tsMs).toISOString();
      const occBase = `${artistNorm}|${trackNorm}|${playedAt}`;
      const occ = (occMap.get(occBase) ?? 0) + 1;
      occMap.set(occBase, occ);
      const key = `ytm:${alias}:${artistNorm}:${trackNorm}:${playedAt}:occ:${occ}`;
      rows.push({
        rowIndex: idx,
        outcome: 'accepted',
        fingerprint: key,
        raw,
        listen: {
          source: 'youtube_music',
          artist,
          artistNorm,
          track,
          trackNorm,
          album: '',
          albumNorm: '',
          playedAt,
          msPlayed: null,
          timestampPrecision: 'second',
          sourceEventKey: key
        }
      });
    });
    return { rows, notes };
  }

  return parseStructuredMusicCsv(trimmed, 'youtube_music', alias);
}

function parseRymExportRows(content: string, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const csvRows = parseCsv(content);
  if (!csvRows.length) throw new Error('未在 RYM / AOTY CSV 中找到可解析的评分行');
  const firstRow = csvRows[0]!;
  if (
    hasHeader(firstRow, 'Playlist name', 'Playlist') ||
    (hasHeader(firstRow, 'Track name') && !hasHeader(firstRow, 'Rating', 'Score', 'First Name', 'RYM Album ID'))
  ) {
    return parseStructuredMusicCsv(content, 'rym_export', alias);
  }
  const rows: ParsedRow[] = [];
  csvRows.forEach((r, idx) => {
    const first = pick(r, 'First Name', 'First_Name');
    const last = pick(r, 'Last Name', 'Last_Name', 'Last Name localized');
    const artist = pick(r, 'Artist', 'Artist Name') || [first, last].filter(Boolean).join(' ').trim();
    const title = pick(r, 'Title', 'Album', 'Release');
    const ratingStr = pick(r, 'Rating', 'Score', 'User Rating');
    const scaleStr = pick(r, 'Scale');
    const artistNorm = normalizeIdentity(artist), titleNorm = normalizeIdentity(title);
    if (!artistNorm || !titleNorm) {
      rows.push({ rowIndex: idx, outcome: 'rejected', reason: '缺少艺人或专辑标题', raw: r });
      return;
    }
    const ratingNum = ratingStr ? Number.parseFloat(ratingStr) : NaN;
    const hasRating = Number.isFinite(ratingNum) && ratingNum > 0;
    const r10 = hasRating ? normalizeRating10(ratingNum, scaleStr ? Number.parseFloat(scaleStr) : undefined) : null;
    const reaction: 'liked' | 'neutral' | 'disliked' = r10 === null ? 'liked' : r10 >= 7.5 ? 'liked' : r10 <= 4.0 ? 'disliked' : 'neutral';
    const weight = r10 === null ? 0.6 : Number(((r10 - 6.0) * 0.8).toFixed(2));
    const key = `rym_export:${alias}:${artistNorm}:${titleNorm}`;
    rows.push({
      rowIndex: idx,
      outcome: 'accepted',
      fingerprint: key,
      raw: r,
      signal: {
        source: 'rym_export',
        entityType: 'album',
        artist,
        artistNorm,
        title,
        titleNorm,
        album: title,
        albumNorm: titleNorm,
        genres: splitGenres(pick(r, 'Genres', 'Genre')),
        reaction,
        rating: r10,
        weight,
        actionAt: pick(r, 'Release_Date', 'Date', 'Rated At') || null,
        context: 'rym-aoty-csv',
        sourceSignalKey: key
      }
    });
  });
  return { rows, notes: [] };
}

function parseGenericRows(content: string, alias: string): { rows: ParsedRow[]; notes: string[] } {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  const list: Record<string, string>[] = [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('通用 JSON 无法解析，请提供对象数组');
    }
    if (!Array.isArray(parsed)) throw new Error('通用 JSON 顶层应为数组');
    for (const item of parsed) {
      const o = obj(item);
      const rec: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        rec[k] = Array.isArray(v) ? v.join(',') : v === null || v === undefined ? '' : String(v);
      }
      list.push(rec);
    }
  } else {
    list.push(...parseCsv(trimmed));
  }
  if (!list.length) throw new Error('未在通用导入文件中识别到任何记录行');
  return parseStructuredRecordList(list, 'generic', alias);
}

function rowToBatch(row: Record<string, unknown>, idempotentReplay = false): ImportBatchSummary {
  let notes: string[] = [];
  try {
    notes = JSON.parse(String(row.notes_json ?? '[]')) as string[];
  } catch {
    notes = [];
  }
  return {
    id: String(row.id),
    source: row.source as ImportSource,
    accountAlias: String(row.account_alias),
    fileName: String(row.file_name),
    fileSha256: String(row.file_sha256),
    parserVersion: String(row.parser_version),
    status: row.status as 'committed' | 'failed',
    totalRows: Number(row.total_rows),
    acceptedCount: Number(row.accepted_count),
    duplicateCount: Number(row.duplicate_count),
    unsupportedCount: Number(row.unsupported_count),
    rejectedCount: Number(row.rejected_count),
    listensAdded: Number(row.listens_added),
    signalsAdded: Number(row.signals_added),
    notes,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    ...(idempotentReplay ? { idempotentReplay: true } : {})
  };
}

export function listImportBatches(store: Store, limit = 50): ImportBatchSummary[] {
  const rows = store.database
    .prepare('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => rowToBatch(r));
}

export function importPersonalData(
  store: Store,
  input: { source: ImportSource; accountAlias?: string; fileName: string; content: string }
): ImportBatchSummary {
  const content = input.content ?? '';
  if (!content.trim()) throw new Error('导入内容不能为空');
  const accountAlias = (input.accountAlias?.trim() || 'default').slice(0, 64);
  const fileName = (input.fileName?.trim() || `${input.source}-import`).slice(0, 200);
  const fileSha256 = createHash('sha256').update(content).digest('hex');

  const existing = store.database
    .prepare("SELECT * FROM import_batches WHERE source = ? AND account_alias = ? AND file_sha256 = ? AND status = 'committed'")
    .get(input.source, accountAlias, fileSha256) as Record<string, unknown> | undefined;
  if (existing) return rowToBatch(existing, true);

  let parsed: { rows: ParsedRow[]; notes: string[] };
  switch (input.source) {
    case 'netease':
      parsed = parseNeteaseRows(content, accountAlias);
      break;
    case 'spotify':
      parsed = parseSpotifyRows(content, accountAlias);
      break;
    case 'youtube_music':
      parsed = parseYoutubeMusicRows(content, accountAlias);
      break;
    case 'rym_export':
      parsed = parseRymExportRows(content, accountAlias);
      break;
    case 'generic':
      parsed = parseGenericRows(content, accountAlias);
      break;
  }

  return store.transaction(() => {
    const insideExisting = store.database
      .prepare("SELECT * FROM import_batches WHERE source = ? AND account_alias = ? AND file_sha256 = ? AND status = 'committed'")
      .get(input.source, accountAlias, fileSha256) as Record<string, unknown> | undefined;
    if (insideExisting) return rowToBatch(insideExisting, true);

    const batchId = randomUUID();
    const now = new Date().toISOString();
    const notes = [...parsed.notes];
    if (parsed.rows.length > RAW_AUDIT_LIMIT) {
      notes.push(`原始行数量超过 ${RAW_AUDIT_LIMIT} 条，审计明细仅保留前 ${RAW_AUDIT_LIMIT} 条以控制体积`);
    }

    const insertListen = store.database.prepare(`
      INSERT OR IGNORE INTO listening_events(
        id, batch_id, source, account_alias, artist, artist_norm, track, track_norm,
        album, album_norm, played_at, ms_played, timestamp_precision, source_event_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSignal = store.database.prepare(`
      INSERT OR IGNORE INTO preference_signals(
        id, batch_id, source, entity_type, artist, artist_norm, title, title_norm,
        album, album_norm, genres_json, candidate_id, queue_state, reaction, rating,
        weight, action_at, observed_at, context, source_signal_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRaw = store.database.prepare(`
      INSERT INTO raw_records(batch_id, row_index, outcome, reason, fingerprint, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const upsertPendingArtist = store.database.prepare(`
      INSERT INTO artist_metadata(
        artist_norm, artist_name, spotify_id, mbid, wikidata_id,
        genres_json, source, status, confidence, candidates_json, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, '[]', 'pending', 'pending', 'low', '[]', ?)
      ON CONFLICT(artist_norm) DO UPDATE SET
        spotify_id = COALESCE(artist_metadata.spotify_id, excluded.spotify_id)
    `);

    let acceptedCount = 0;
    let duplicateCount = 0;
    let unsupportedCount = 0;
    let rejectedCount = 0;
    let listensAdded = 0;
    let signalsAdded = 0;

    for (const row of parsed.rows) {
      let outcome = row.outcome;
      let reason = row.reason;

      if (outcome === 'accepted' && row.listen) {
        const l = row.listen;
        const res = insertListen.run(
          randomUUID(),
          batchId,
          l.source,
          accountAlias,
          l.artist,
          l.artistNorm,
          l.track,
          l.trackNorm,
          l.album,
          l.albumNorm,
          l.playedAt,
          l.msPlayed,
          l.timestampPrecision,
          l.sourceEventKey,
          now
        );
        if (Number(res.changes) > 0) listensAdded++;
        else {
          outcome = 'duplicate';
          reason = '与已导入记录重复（同时间戳与账号作用域去重）';
        }
      } else if (outcome === 'accepted' && row.signal) {
        const s = row.signal;
        const res = insertSignal.run(
          randomUUID(),
          batchId,
          s.source,
          s.entityType,
          s.artist,
          s.artistNorm,
          s.title,
          s.titleNorm,
          s.album,
          s.albumNorm,
          JSON.stringify(s.genres),
          s.reaction,
          s.rating,
          s.weight,
          s.actionAt,
          now,
          s.context,
          s.sourceSignalKey
        );
        if (Number(res.changes) > 0) {
          signalsAdded++;
          if (s.entityType === 'artist') {
            const rawRec = obj(row.raw);
            const rawSid = text(rawRec['Spotify - id']) || text(rawRec['Spotify ID']);
            if (SPOTIFY_ARTIST_ID_RE.test(rawSid)) {
              upsertPendingArtist.run(s.artistNorm, s.artist, rawSid, now);
            }
          }
        } else {
          outcome = 'duplicate';
          reason = '相同偏好记录已存在';
        }
      }

      if (outcome === 'accepted') acceptedCount++;
      else if (outcome === 'duplicate') duplicateCount++;
      else if (outcome === 'unsupported') unsupportedCount++;
      else rejectedCount++;

      if (row.rowIndex < RAW_AUDIT_LIMIT) {
        insertRaw.run(batchId, row.rowIndex, outcome, reason ?? null, row.fingerprint ?? null, JSON.stringify(row.raw).slice(0, 2000));
      }
    }

    const totalRows = parsed.rows.length;
    if (totalRows === 0 || (acceptedCount === 0 && duplicateCount === 0)) {
      throw new Error(
        `未识别到有效音乐记录（共 ${totalRows} 行：忽略 ${unsupportedCount}，拒绝 ${rejectedCount}），请检查文件格式与表头字段`
      );
    }

    store.database.prepare(`
      INSERT INTO import_batches(
        id, source, account_alias, file_name, file_sha256, parser_version, status,
        total_rows, accepted_count, duplicate_count, unsupported_count, rejected_count,
        listens_added, signals_added, notes_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      input.source,
      accountAlias,
      fileName,
      fileSha256,
      PARSER_VERSION,
      totalRows,
      acceptedCount,
      duplicateCount,
      unsupportedCount,
      rejectedCount,
      listensAdded,
      signalsAdded,
      JSON.stringify(notes),
      now,
      now
    );

    const saved = store.database.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) as Record<string, unknown>;
    return rowToBatch(saved);
  });
}
