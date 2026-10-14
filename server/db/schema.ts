/**
 * SQLite şeması. Klip motoru (server/engine) LivoBot'un PostgreSQL tablolarını
 * bekler; kolon adları ve anlamları birebir korunur, yalnız tipler SQLite'a
 * çevrilir. Zaman damgaları ISO-8601 (UTC) metin olarak tutulur.
 *
 * Şema sürümlenir: her göç bir kez çalışır ve `schema_migrations`'a yazılır.
 */

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001-temel',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('kick', 'guest')),
        kick_user_id TEXT UNIQUE,
        username TEXT NOT NULL,
        avatar_url TEXT,
        channel_slug TEXT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        last_seen_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions (user_id);

      CREATE TABLE user_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        auto_edit_clips INTEGER DEFAULT 0,
        clip_defaults TEXT DEFAULT '{}',
        clip_next_publish_at INTEGER DEFAULT 0,
        subtitle_style TEXT DEFAULT 'classic',
        brand_color TEXT DEFAULT '#f43f5e',
        accent_color TEXT DEFAULT '#f97316',
        language TEXT DEFAULT 'tr',
        zernio_profile_id TEXT,
        zernio_profile_name TEXT,
        zernio_api_key_enc TEXT,
        recording_output TEXT DEFAULT '{}',
        autopilot TEXT DEFAULT '{}'
      );

      CREATE TABLE vod_scan_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_slug TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'kick',
        source_video_id TEXT NOT NULL,
        title TEXT,
        duration_sec INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        step TEXT DEFAULT '',
        progress INTEGER DEFAULT 0,
        error TEXT,
        options TEXT,
        max_clips INTEGER DEFAULT 8,
        clips_created INTEGER DEFAULT 0,
        segments_created INTEGER DEFAULT 0,
        thumbnail_url TEXT,
        vod_path TEXT,
        vod_file_size_bytes INTEGER,
        downloaded_at TEXT,
        vod_expires_at TEXT,
        transcript_language TEXT,
        from_live INTEGER DEFAULT 0,
        created_at TEXT DEFAULT ${NOW},
        completed_at TEXT
      );
      CREATE INDEX idx_vod_scan_jobs_user ON vod_scan_jobs (user_id, id DESC);

      CREATE TABLE edited_clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT DEFAULT 'popular',
        source_clip_id TEXT,
        source_url TEXT,
        title TEXT,
        channel_slug TEXT,
        view_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'queued',
        step TEXT,
        error TEXT,
        video_url TEXT,
        thumbnail_url TEXT,
        duration INTEGER DEFAULT 0,
        layout TEXT,
        transcript TEXT,
        highlights TEXT,
        qc TEXT,
        gen_title TEXT,
        gen_description TEXT,
        gen_hashtags TEXT,
        qc_verdict TEXT,
        qc_issues TEXT,
        publish_status TEXT,
        publish_post_id TEXT,
        publish_started_at TEXT,
        scheduled_for TEXT,
        publish_timezone TEXT,
        publish_platforms TEXT,
        published_at TEXT,
        viral_score INTEGER,
        viral_reason TEXT,
        subtitles INTEGER DEFAULT 1,
        options TEXT,
        file_size_bytes INTEGER,
        vod_scan_job_id INTEGER REFERENCES vod_scan_jobs(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT ${NOW}
      );
      CREATE INDEX idx_edited_clips_user ON edited_clips (user_id, id DESC);
      CREATE INDEX idx_edited_clips_schedule ON edited_clips (user_id, scheduled_for);

      CREATE TABLE vod_highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vod_scan_job_id INTEGER NOT NULL REFERENCES vod_scan_jobs(id) ON DELETE CASCADE,
        start_sec INTEGER NOT NULL,
        end_sec INTEGER NOT NULL,
        score REAL,
        kind TEXT,
        reason TEXT,
        edited_clip_id INTEGER REFERENCES edited_clips(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT ${NOW}
      );
      CREATE INDEX idx_vod_highlights_job ON vod_highlights (vod_scan_job_id);

      CREATE TABLE vod_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vod_scan_job_id INTEGER NOT NULL REFERENCES vod_scan_jobs(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        start_sec INTEGER NOT NULL,
        end_sec INTEGER NOT NULL,
        score REAL,
        reason TEXT,
        edited_clip_id INTEGER REFERENCES edited_clips(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT ${NOW}
      );
      CREATE INDEX idx_vod_segments_job ON vod_segments (vod_scan_job_id);

      CREATE TABLE vod_manual_clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vod_scan_job_id INTEGER NOT NULL REFERENCES vod_scan_jobs(id) ON DELETE CASCADE,
        label TEXT,
        color TEXT,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        edited_clip_id INTEGER REFERENCES edited_clips(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT ${NOW}
      );
      CREATE INDEX idx_vod_manual_clips_job ON vod_manual_clips (vod_scan_job_id);

      CREATE TABLE stream_recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_slug TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'recording',
        quality TEXT,
        file_path TEXT,
        file_size INTEGER DEFAULT 0,
        duration_sec INTEGER DEFAULT 0,
        error TEXT,
        started_at TEXT DEFAULT ${NOW},
        completed_at TEXT,
        final_status TEXT,
        final_path TEXT,
        final_size INTEGER DEFAULT 0,
        final_error TEXT,
        publish_status TEXT,
        publish_post_id TEXT,
        publish_account_id TEXT,
        publish_title TEXT,
        publish_content TEXT,
        publish_visibility TEXT,
        publish_url TEXT,
        publish_error TEXT,
        published_at TEXT
      );
      CREATE INDEX idx_stream_recordings_user ON stream_recordings (user_id, id DESC);

      -- Arşiv defteri: üretilen her içeriğin kalıcı kaydı. Kaynak satır ya da
      -- dosya silinse bile burada kalır (yalnız deleted_at işaretlenir).
      CREATE TABLE archive_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('clip', 'recording', 'vod')),
        ref_id INTEGER NOT NULL,
        title TEXT,
        channel_slug TEXT,
        source TEXT,
        format TEXT,
        duration_sec REAL,
        size_bytes INTEGER,
        thumb_path TEXT,
        publish_status TEXT,
        publish_platforms TEXT,
        published_at TEXT,
        produced_at TEXT NOT NULL DEFAULT ${NOW},
        deleted_at TEXT,
        UNIQUE (user_id, kind, ref_id)
      );
      CREATE INDEX idx_archive_user_day ON archive_entries (user_id, produced_at DESC);
    `,
  },
  {
    id: '002-uygulama-ayarlari',
    sql: `
      -- Bilgisayar genelindeki ayarlar (ör. altyazı motoru anahtarı). Gizli
      -- değerler secrets.seal ile şifreli tutulur.
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT ${NOW}
      );

      -- Üst şeritteki kanal sekmeleri (JSON dizi); etkin sekme users.channel_slug.
      ALTER TABLE user_settings ADD COLUMN channel_tabs TEXT DEFAULT '[]';
    `,
  },
  {
    id: '003-disa-aktarma',
    sql: `
      -- İndirilenler klasörüne kopyalanan dosyanın yolu (bir kez kopyalanır).
      ALTER TABLE archive_entries ADD COLUMN exported_path TEXT;
    `,
  },
  {
    id: '004-kick-oturum-ve-klip-takibi',
    sql: `
      -- Kick OAuth belirteçleri (şifreli JSON) — yalnız sohbete !clip yazmak için.
      ALTER TABLE user_settings ADD COLUMN kick_tokens_enc TEXT;
      -- Kanal klip takibi ayarı: { enabled, channel, autoEdit }
      ALTER TABLE user_settings ADD COLUMN clip_harvest TEXT DEFAULT '{}';

      -- Kick'te yeni yayımlanan ve arka planda indirilen klipler.
      CREATE TABLE harvested_clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        clip_id TEXT NOT NULL,
        channel_slug TEXT NOT NULL,
        title TEXT,
        duration_sec REAL,
        thumbnail_url TEXT,
        clip_created_at TEXT,
        status TEXT NOT NULL DEFAULT 'seen',
        file_path TEXT,
        file_size INTEGER,
        error TEXT,
        job_id INTEGER,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (user_id, clip_id)
      );
      CREATE INDEX idx_harvested_user ON harvested_clips (user_id, id DESC);
    `,
  },
  {
    id: '005-kendi-kanali',
    sql: `
      -- Hesabın kendi Kick kanalı (users.channel_slug etkin sekmedir, değişir).
      ALTER TABLE users ADD COLUMN own_channel TEXT;
      UPDATE users SET own_channel = substr(kick_user_id, 7) WHERE kick_user_id LIKE 'kanal:%';
    `,
  },
  {
    id: '006-kullanici-kick-uygulamasi',
    sql: `
      -- Kullanıcının kendi Kick geliştirici uygulaması (şifreli JSON: clientId, clientSecret).
      -- Sohbete "!clip" yazabilmek için; her kullanıcı kendi anahtarını kullanır.
      ALTER TABLE user_settings ADD COLUMN kick_app_enc TEXT;
    `,
  },
  {
    id: '007-editor-projeleri',
    sql: `
      -- Editör projeleri: zaman çizelgesi, varlıklar ve ayarlar JSON (shared/project.ts).
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'Yeni proje',
        format TEXT NOT NULL DEFAULT 'horizontal',
        data TEXT NOT NULL DEFAULT '{}',
        duration_sec REAL DEFAULT 0,
        thumb_path TEXT,
        last_export_id INTEGER,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW}
      );
      CREATE INDEX idx_projects_user ON projects (user_id, updated_at DESC);
    `,
  },
  {
    id: '008-ilk-kurulum',
    sql: `
      -- İlk kurulum sihirbazı tamamlandı mı (kanal, logo, intro/outro, Zernio, genel ayarlar).
      ALTER TABLE user_settings ADD COLUMN onboarding_done INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
