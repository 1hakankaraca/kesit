import { FORMAT_SIZE, type Project } from '../../shared/project.ts';

/**
 * Editör projesindeki abone çağrısı parçaları → ASS olayları.
 *
 * Her `cta` parçası bir pencere: başlangıcı ve süresi zaman çizelgesinden,
 * tasarımı (stil/konum/boyut) parçanın kendi ayarından, yazılar ve renkler
 * Stüdyo'daki marka ayarından (SubscribeCta ayarı) gelir. Çizim motoru
 * (SubscribeCta.eventsFor) parametre olarak alınır; böylece bu modül motor
 * yüklenmeden test edilebilir.
 */
export interface CtaBrand {
  brandColor?: string | null;
  accentColor?: string | null;
  channel?: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ctaEvents(Cta: any, project: Pick<Project, 'clips' | 'tracks' | 'format'>, cfg: any, brand: CtaBrand = {}): string[] {
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  const clips = project.clips.filter((c) => c.kind === 'cta' && c.cta && !hidden.has(c.trackId) && c.duration >= 1).sort((a, b) => a.start - b.start);
  if (!clips.length) return [];
  const { w: playResX, h: playResY } = FORMAT_SIZE[project.format];
  const colors = Cta.colorsOf(cfg, brand.brandColor, brand.accentColor);
  const out: string[] = [];
  for (const c of clips) {
    const overlay = { ...cfg.overlay, style: c.cta!.style, x: c.cta!.x, y: c.cta!.y, scale: (c.cta!.size || 100) / 100 };
    const win = { start: c.start, end: c.start + c.duration, at: 'start' };
    out.push(...Cta.eventsFor(overlay, win, { playResX, playResY, brandColor: colors.primary, accentColor: colors.accent, textColor: colors.text, darkColor: colors.dark, channel: brand.channel ?? null }));
  }
  return out;
}
