import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Album, ListeningStatus } from '../../shared/types.js';
import type { FeedbackQueueState, FeedbackReaction } from '../../shared/personal.js';
import { normalizeIdentity } from '../sources/parsers.js';

function mapLegacyStatus(status: ListeningStatus): { queueState: FeedbackQueueState; reaction: FeedbackReaction | null; weight: number } {
  switch (status) {
    case 'saved':
      return { queueState: 'saved', reaction: null, weight: 0.25 };
    case 'listened':
      return { queueState: 'listened', reaction: null, weight: 0.35 };
    case 'liked':
      return { queueState: 'listened', reaction: 'liked', weight: 2.2 };
    case 'disliked':
      // Legacy UI label is "无感" (neutral/meh), not a strong permanent veto.
      return { queueState: 'listened', reaction: 'neutral', weight: -0.4 };
    case 'skipped':
      return { queueState: 'skipped', reaction: null, weight: 0 };
    default:
      return { queueState: 'unheard', reaction: null, weight: 0 };
  }
}

/** Creates a consistent point-in-time SQLite backup safe under WAL mode. */
export function backupDatabase(db: DatabaseSync, backupPath: string): void {
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  rmSync(backupPath, { force: true });
  db.prepare('VACUUM INTO ?').run(backupPath);
}

export function runMigrations(db: DatabaseSync, dataDir: string, legacyAlbums: Album[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const hasMigration = (id: string) => Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id));

  if (!hasMigration('001_personal_taste')) {
    const existingConfig = db.prepare('SELECT COUNT(*) AS count FROM config').get() as { count: number } | undefined;
    if ((existingConfig?.count ?? 0) > 0) {
      backupDatabase(db, join(dataDir, 'backups', 'pre-001_personal_taste.sqlite'));
    }

    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS import_batches (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          account_alias TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_sha256 TEXT NOT NULL,
          parser_version TEXT NOT NULL,
          status TEXT NOT NULL,
          total_rows INTEGER NOT NULL,
          accepted_count INTEGER NOT NULL,
          duplicate_count INTEGER NOT NULL,
          unsupported_count INTEGER NOT NULL,
          rejected_count INTEGER NOT NULL,
          listens_added INTEGER NOT NULL,
          signals_added INTEGER NOT NULL,
          notes_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_import_batches_idem
          ON import_batches(source, account_alias, file_sha256)
          WHERE status = 'committed';

        CREATE TABLE IF NOT EXISTS raw_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          row_index INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          fingerprint TEXT,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_raw_records_batch ON raw_records(batch_id);

        CREATE TABLE IF NOT EXISTS listening_events (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          source TEXT NOT NULL,
          account_alias TEXT NOT NULL,
          artist TEXT NOT NULL,
          artist_norm TEXT NOT NULL,
          track TEXT NOT NULL,
          track_norm TEXT NOT NULL,
          album TEXT NOT NULL,
          album_norm TEXT NOT NULL,
          played_at TEXT NOT NULL,
          ms_played INTEGER,
          timestamp_precision TEXT NOT NULL,
          source_event_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_listening_events_artist ON listening_events(artist_norm);
        CREATE INDEX IF NOT EXISTS idx_listening_events_played ON listening_events(played_at);

        CREATE TABLE IF NOT EXISTS preference_signals (
          id TEXT PRIMARY KEY,
          batch_id TEXT,
          source TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          artist TEXT NOT NULL,
          artist_norm TEXT NOT NULL,
          title TEXT NOT NULL,
          title_norm TEXT NOT NULL,
          album TEXT NOT NULL,
          album_norm TEXT NOT NULL,
          genres_json TEXT NOT NULL DEFAULT '[]',
          candidate_id TEXT,
          queue_state TEXT,
          reaction TEXT,
          rating REAL,
          weight REAL NOT NULL,
          action_at TEXT,
          observed_at TEXT NOT NULL,
          context TEXT,
          source_signal_key TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_preference_signals_artist ON preference_signals(artist_norm);
        CREATE INDEX IF NOT EXISTS idx_preference_signals_cand ON preference_signals(candidate_id);

        CREATE TABLE IF NOT EXISTS recommendation_sets (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          profile_revision TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
      `);

      const insertSignal = db.prepare(`
        INSERT OR IGNORE INTO preference_signals(
          id, batch_id, source, entity_type, artist, artist_norm, title, title_norm,
          album, album_norm, genres_json, candidate_id, queue_state, reaction, rating,
          weight, action_at, observed_at, context, source_signal_key
        ) VALUES (?, NULL, 'legacy-migration', 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
      `);

      for (const album of legacyAlbums) {
        if (!album.listeningStatus || album.listeningStatus === 'unheard') continue;
        const mapped = mapLegacyStatus(album.listeningStatus);
        const artistNorm = normalizeIdentity(album.artist);
        const titleNorm = normalizeIdentity(album.title);
        insertSignal.run(
          randomUUID(),
          album.artist,
          artistNorm,
          album.title,
          titleNorm,
          album.title,
          titleNorm,
          JSON.stringify(album.genres ?? []),
          album.id,
          mapped.queueState,
          mapped.reaction,
          mapped.weight,
          now,
          `legacyStatus:${album.listeningStatus}`,
          `legacy:${album.id}`
        );
      }

      db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('001_personal_taste', now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  if (!hasMigration('002_artist_metadata')) {
    const existingConfig = db.prepare('SELECT COUNT(*) AS count FROM config').get() as { count: number } | undefined;
    if ((existingConfig?.count ?? 0) > 0) {
      backupDatabase(db, join(dataDir, 'backups', 'pre-002_artist_metadata.sqlite'));
    }

    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artist_metadata (
          artist_norm TEXT PRIMARY KEY,
          artist_name TEXT NOT NULL,
          spotify_id TEXT,
          mbid TEXT,
          wikidata_id TEXT,
          genres_json TEXT NOT NULL DEFAULT '[]',
          manual_genres_json TEXT,
          source TEXT NOT NULL DEFAULT 'pending',
          status TEXT NOT NULL DEFAULT 'pending',
          confidence TEXT NOT NULL DEFAULT 'low',
          candidates_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artist_metadata_status ON artist_metadata(status);
      `);
      db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('002_artist_metadata', now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  if (!hasMigration('003_catalog_cache')) {
    const existingConfig = db.prepare('SELECT COUNT(*) AS count FROM config').get() as { count: number } | undefined;
    if ((existingConfig?.count ?? 0) > 0) {
      backupDatabase(db, join(dataDir, 'backups', 'pre-003_catalog_cache.sqlite'));
    }

    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_cache (
          cache_key TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('003_catalog_cache', now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  if (!hasMigration('004_ai_curation_and_links')) {
    const existingConfig = db.prepare('SELECT COUNT(*) AS count FROM config').get() as { count: number } | undefined;
    if ((existingConfig?.count ?? 0) > 0) {
      backupDatabase(db, join(dataDir, 'backups', 'pre-004_ai_curation_and_links.sqlite'));
    }

    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS listen_links_cache (
          album_id TEXT PRIMARY KEY,
          spotify_url TEXT,
          youtube_music_url TEXT,
          apple_music_url TEXT,
          source TEXT NOT NULL,
          checked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS album_reviews_ai (
          album_id TEXT PRIMARY KEY,
          evidence_hash TEXT NOT NULL,
          evidence_level TEXT NOT NULL,
          short_review TEXT NOT NULL,
          long_review TEXT NOT NULL,
          audience_summary TEXT,
          critic_summary TEXT,
          model TEXT NOT NULL,
          generated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_taste_personas (
          profile_revision TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          model TEXT NOT NULL,
          generated_at TEXT NOT NULL
        );
      `);

      const albumsRow = db.prepare('SELECT value FROM config WHERE key = ?').get('albums') as { value: string } | undefined;
      if (albumsRow?.value) {
        try {
          const parsedAlbums = JSON.parse(albumsRow.value) as Album[];
          let changed = false;
          for (const album of parsedAlbums) {
            for (const obs of album.sources ?? []) {
              if (typeof obs.url === 'string' && /^https:\/\/pitchfork\.com\/search\/\?query=/i.test(obs.url)) {
                obs.url = obs.url.replace(/^https:\/\/pitchfork\.com\/search\/\?query=/i, 'https://pitchfork.com/search/?q=');
                changed = true;
              }
            }
          }
          if (changed) {
            db.prepare('INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
              'albums',
              JSON.stringify(parsedAlbums)
            );
          }
        } catch {
          // Ignore malformed legacy config payload
        }
      }

      db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)').run('004_ai_curation_and_links', now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
