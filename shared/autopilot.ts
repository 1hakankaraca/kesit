/** Nöbetçi: takip edilen kanal canlıya geçince kayıt + klip yakalama, bitince işleme. */
export interface AutopilotConfig {
  enabled: boolean;
  /** Takip edilen Kick kanalı (kullanıcının kendi kanalı olmak zorunda değil). */
  channel: string | null;
  /** Yayının tamamını kaydet; yayın bitince kayıt kapanır ve çıktı otomatik üretilir. */
  record: boolean;
  /** Chat'e düşen klip bağlantılarını yakala. */
  clips: boolean;
  /** Yakalanan klipleri otomatik düzenle (dikey + altyazı). */
  autoEdit: boolean;
  /** Düzenlenen klipleri Zernio ile saatte bir paylaş. */
  autoPublish: boolean;
  publishAccounts: { platform: string; accountId: string }[];
  subtitles: boolean;
}

export const AUTOPILOT_DEFAULTS: AutopilotConfig = {
  enabled: false,
  channel: null,
  record: true,
  clips: true,
  autoEdit: true,
  autoPublish: false,
  publishAccounts: [],
  subtitles: true,
};

export type AutopilotEventKind = 'armed' | 'live' | 'offline' | 'record-start' | 'record-stop' | 'error' | 'disarmed';

export interface AutopilotEvent {
  at: string;
  kind: AutopilotEventKind;
  text: string;
}

export interface AutopilotStatus {
  config: AutopilotConfig;
  /** Son yoklamada kanal canlı mıydı (null: henüz yoklanmadı). */
  live: boolean | null;
  title: string | null;
  viewers: number;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  events: AutopilotEvent[];
}

export function normalizeAutopilot(raw: unknown): AutopilotConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutopilotConfig>;
  const d = AUTOPILOT_DEFAULTS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    enabled: bool(r.enabled, d.enabled),
    channel: typeof r.channel === 'string' && r.channel ? r.channel : null,
    record: bool(r.record, d.record),
    clips: bool(r.clips, d.clips),
    autoEdit: bool(r.autoEdit, d.autoEdit),
    autoPublish: bool(r.autoPublish, d.autoPublish),
    publishAccounts: Array.isArray(r.publishAccounts)
      ? r.publishAccounts
          .filter((a) => a && typeof a.platform === 'string' && typeof a.accountId === 'string')
          .map((a) => ({ platform: a.platform, accountId: a.accountId }))
      : [],
    subtitles: bool(r.subtitles, d.subtitles),
  };
}
