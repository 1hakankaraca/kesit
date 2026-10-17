import type { AutopilotStatus } from '../../shared/autopilot.ts';

export type { AutopilotConfig, AutopilotStatus } from '../../shared/autopilot.ts';

export type JobStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** Üretilen klip/kesit (edited_clips satırı). */
export interface Job {
  id: number;
  source: string;
  source_clip_id: string | null;
  title: string | null;
  channel_slug: string | null;
  view_count: number;
  status: JobStatus;
  step: string | null;
  error: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  duration: number;
  layout: string | null;
  gen_title: string | null;
  gen_description: string | null;
  gen_hashtags: string | null;
  qc_verdict: string | null;
  qc_issues: string | null;
  publish_status: string | null;
  scheduled_for: string | null;
  publish_platforms: string | null;
  published_at: string | null;
  viral_score: number | null;
  viral_reason: string | null;
  options: string | null;
  file_size_bytes: number | null;
  vod_scan_job_id: number | null;
  created_at: string;
  /** Ham kaynak saklanmışsa indirme adresi (yeniden üretim de mümkündür). */
  raw_url?: string | null;
}

export interface QueueStatus {
  running: number;
  waiting: number;
  capacity: number;
}

export interface KickClip {
  id: string;
  type?: 'kick' | 'kickbot';
  title: string;
  viewCount: number;
  duration: number;
  thumbnailUrl: string | null;
  /** Oynatma adresi (Kick: HLS, KickBot: MP4). */
  videoUrl?: string;
  createdAt: string;
  processed: boolean;
  jobId: number | null;
  jobStatus: JobStatus | null;
}

export interface VodVideo {
  id: number | string;
  title: string;
  startedAt: string;
  durationSec: number;
  viewCount: number;
  thumbnailUrl: string | null;
  isLive?: boolean;
}

export interface VodJob {
  id: number;
  channel_slug: string;
  source_video_id: string;
  title: string | null;
  duration_sec: number;
  status: 'queued' | 'processing' | 'paused' | 'downloaded' | 'failed' | 'cancelled' | 'expired';
  step: string;
  progress: number;
  error: string | null;
  clips_created: number;
  thumbnail_url: string | null;
  vod_file_size_bytes: number | null;
  vod_expires_at: string | null;
  from_live: boolean;
  /** Yalnız bir aralık indirildiyse (saniye, yayın başından); tamamı indirildiyse boş. */
  range_start_sec: number | null;
  range_end_sec: number | null;
  created_at: string;
}

export interface Highlight {
  id: number;
  start_sec: number;
  end_sec: number;
  score: number | null;
  kind: string | null;
  reason: string | null;
}

export interface Frame {
  t: number;
  url: string;
}

export interface Recording {
  id: number;
  channel_slug: string;
  title: string | null;
  status: 'recording' | 'processing' | 'ready' | 'failed';
  quality: string | null;
  file_size: number;
  duration_sec: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  final_status: string | null;
  final_size: number | null;
  final_error: string | null;
  publish_status: string | null;
  publish_title: string | null;
  publish_content: string | null;
  publish_visibility: 'public' | 'unlisted' | 'private' | null;
  publish_url: string | null;
  publish_error: string | null;
  available: boolean;
  final_available: boolean;
  final_percent: number | null;
}

export interface RecorderStatus {
  recording: boolean;
  id?: number;
  channel?: string;
  title?: string;
  quality?: string;
  startedAt?: number;
  elapsedSec?: number;
  sizeBytes?: number;
  maxMinutes?: number;
  previewUrl?: string | null;
  finishing?: boolean;
  backfillSec?: number;
}

export interface WatcherFeedItem {
  clipId: string;
  type: string;
  url: string;
  sender: string;
  channel: string;
  time: string;
  ts: number;
  autoQueued: boolean;
  jobId: number | null;
  error?: string;
}

export interface WatcherStatus {
  watching: boolean;
  channel: string | null;
  chatConnected: boolean;
  isLive: boolean;
  viewerCount: number;
  autoEdit: boolean;
  subtitles: boolean;
  autoPublish: boolean;
  detectedCount: number;
  feed: WatcherFeedItem[];
}

export interface LiveState {
  watcher: WatcherStatus;
  recorder: RecorderStatus;
  autopilot: AutopilotStatus;
  /** Kullanıcının Kick hesabıyla sohbete yazma izni var mı (anlık klip için). */
  chatAccess: boolean;
}

export interface ChannelInfo {
  slug: string;
  username: string;
  avatarUrl: string | null;
  isLive: boolean;
  title: string | null;
  viewers: number;
  category: string | null;
  startedAt: string | null;
}

export interface BrandMedia {
  exists: boolean;
  url: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
}

export interface ClipOptions {
  subtitles: boolean;
  subtitleStyle: string | null;
  subtitleLang: 'auto' | 'tr' | 'en';
  subtitleFollowsTheme: boolean;
  logo: boolean;
  logoPosition: 'seam' | 'top-center' | 'custom';
  logoScale: number;
  logoOpacity: number;
  logoX: number | null;
  logoY: number | null;
  composition: 'auto' | 'split' | 'single';
  autoPublishMinScore: number;
  outputFormat: 'vertical' | 'horizontal';
  censor: boolean;
  intro: boolean;
  introAsk: boolean;
  outro: boolean;
  camFullRanges: { start: number; end: number }[];
  /** Elle çizilmiş kamera/yayın alanı kadrajı (0-1 oranlı); "Kamera + oyun" seçiliyse tespit yerine bu kullanılır. */
  manualLayout: { cam: { x: number; y: number; w: number; h: number }; content: { x: number; y: number; w: number; h: number } } | null;
}

export interface RecordingOutput {
  intro: boolean;
  outro: boolean;
  logo: boolean;
  logoOpacity: number;
  logoWidthPct: number;
  bitrateMbps: number;
  resolution: string;
  codec: 'h264' | 'hevc';
  speed: 'fast' | 'balanced' | 'quality';
}

export interface Studio {
  styles: { key: string; label: string; hint: string }[];
  /** Hangi sekme için okundu; custom ise o sekmenin kendi profili var. */
  scope: { channel: string | null; custom: boolean };
  brand: { subtitleStyle: string; brandColor: string; accentColor: string; language: 'tr' | 'en' };
  defaults: Record<'vertical' | 'horizontal', ClipOptions>;
  logo: { exists: boolean; url: string | null };
  intro: BrandMedia;
  outro: BrandMedia;
  limits: { mediaMaxSeconds: number; mediaMaxBytes: number; logoMaxBytes: number };
  recordingOutput: RecordingOutput;
  hevcAvailable: boolean;
}

/** Anlık klip düğmesiyle yayından alınan ham kesit. */
export interface Snippet {
  id: number;
  channel: string;
  title: string;
  seconds: number;
  status: 'downloading' | 'ready' | 'failed';
  error: string | null;
  sizeBytes: number | null;
  durationSec: number | null;
  jobId: number | null;
  videoUrl: string | null;
  thumbUrl: string | null;
  createdAt: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  displayName: string;
  profile: string;
}

export interface ZernioSummary {
  connected: boolean;
  profile: { id: string; name: string } | null;
  keyHint: string | null;
  accounts: SocialAccount[];
  error: string | null;
}

export interface ScheduleEntry {
  jobId: number;
  title: string;
  thumbnailUrl: string | null;
  duration: number;
  publishStatus: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  createdAt: string | null;
  platforms: { platform: string; status: string; url?: string | null }[];
}

export interface ArchiveEntry {
  id: number;
  kind: 'clip' | 'recording' | 'vod';
  refId: number;
  title: string;
  channelSlug: string | null;
  source: string | null;
  format: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  thumbUrl: string | null;
  publishStatus: string | null;
  platforms: { platform: string; status: string }[];
  publishedAt: string | null;
  producedAt: string;
  deletedAt: string | null;
  fileAvailable: boolean;
}

export interface ArchiveDay {
  day: string;
  produced: number;
  shared: number;
  deleted: number;
}

/* ── Editör projeleri ─────────────────────────────────────────────────── */

export interface ProjectSummary {
  id: number;
  title: string;
  format: 'horizontal' | 'vertical';
  durationSec: number;
  thumbUrl: string | null;
  lastExportId: number | null;
  createdAt: string;
  updatedAt: string;
  rendering: RenderStatus | null;
}

export interface RenderStatus {
  projectId: number;
  title: string;
  percent: number;
  startedAt: number;
  error: string | null;
  jobId: number | null;
  done?: boolean;
  failed?: boolean;
}

/* ── Sistem görev yöneticisi ──────────────────────────────────────────── */

export interface SystemProcess {
  pid: number;
  name: string;
  label: string;
  cpu: number;
  memBytes: number;
  elapsed: string;
  self: boolean;
}

export interface SystemReport {
  cpu: { percent: number; cores: number; load: number };
  memory: { total: number; used: number; percent: number };
  disk: { total: number; free: number; used: number; percent: number } | null;
  kesit: { pid: number; uptimeSec: number; memBytes: number; queue: QueueStatus };
  processes: SystemProcess[];
  sampledAt: number;
}
