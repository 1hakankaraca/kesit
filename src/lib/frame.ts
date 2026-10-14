/**
 * Video karesi modeli: motorun (server/engine) logo ve altyazı yerleşimini
 * önizleme için oran olarak verir. Tüm değerler karenin genişlik/yüksekliğine
 * oranlıdır; bu yüzden her çözünürlükte aynı görünür.
 *
 * Kaynaklar (değiştirilirse buradaki sayılar da güncellenmeli):
 *  - VerticalComposer.js: 1080x1920 çıktı, LOGO_W = 1080/3, LOGO_TOP_Y = 60,
 *    kamera bölümü 608–760 px, altyazı dikişin 140 px altında (tek parçada alttan 320 px)
 *  - HorizontalComposer.js: logo genişliği = genişlik/3 × ölçek, merkezden (x, y);
 *    altyazı: yazı = stil × (yükseklik/1920) × 1.55, alt boşluk = yüksekliğin %7'si
 *  - SubtitleStyles.js: stillerin yazı boyutları (1080x1920 düzleminde)
 */

export type Format = 'vertical' | 'horizontal';

export const V_W = 1080;
export const V_H = 1920;
const V_LOGO_W = V_W / 3;
const V_LOGO_TOP = 60;
/** Önizlemede kamera bölümü: 16:9 webcam (en sık durum). Gerçekte 608–760 px arasıdır. */
export const V_CAM_H = 608;
const V_SUB_BELOW_SEAM = 140;
const V_SUB_SINGLE_BOTTOM = 320;

const H_FONT_BOOST = 1.55;
const H_SUB_MARGIN = 0.07;

/** Stillerin ASS yazı boyutu (1080x1920 düzleminde). */
const STYLE_SIZE: Record<string, number> = { classic: 58, tiktok: 62, pop: 60, minimal: 52, neon: 60, podcast: 50 };

/** ASS yazı boyutu yaklaşık olarak satır yüksekliğidir; CSS em'ine çevirme katsayısı. */
const ASS_TO_CSS = 0.86;

/** Kenarlara yapışma ve kılavuzlar için güvenli kenar payı (karenin oranı). */
export const SAFE_MARGIN = 0.05;

export interface LogoBox {
  /** Merkez, karenin oranı (0–1). */
  cx: number;
  cy: number;
  /** Genişlik ve yükseklik, karenin oranı. */
  w: number;
  h: number;
}

/** Logonun karedeki kutusu. aspect = logo yüksekliği / genişliği. */
export function logoBox(
  format: Format,
  o: { logoScale: number; logoPosition: string; logoX: number | null; logoY: number | null },
  aspect: number,
  split: boolean,
): LogoBox {
  const scale = Math.min(2, Math.max(0.5, o.logoScale || 1));
  const w = (1 / 3) * scale;
  if (format === 'horizontal') {
    const h = w * aspect * (16 / 9);
    return { cx: o.logoX ?? 0.92, cy: o.logoY ?? 0.08, w, h };
  }
  const h = (V_LOGO_W * scale * aspect) / V_H;
  if (o.logoPosition === 'custom' && o.logoX !== null && o.logoY !== null) return { cx: o.logoX, cy: o.logoY, w, h };
  if (o.logoPosition === 'top-center' || !split) return { cx: 0.5, cy: V_LOGO_TOP / V_H + h / 2, w, h };
  return { cx: 0.5, cy: V_CAM_H / V_H, w, h };
}

/** Altyazının karedeki yeri: alt kenarın alttan uzaklığı ve yazı boyutu (genişliğin oranı, CSS için cqi). */
export function subtitleBox(format: Format, styleKey: string, logo: LogoBox | null, logoPosition: string, split: boolean) {
  const size = STYLE_SIZE[styleKey] ?? 58;
  if (format === 'horizontal') {
    return {
      bottom: H_SUB_MARGIN,
      // px = boyut × (H/1920) × 1.55; genişliğe oranı için × (H/W) = 9/16
      fontCqi: ((size * H_FONT_BOOST) / 1920) * (9 / 16) * 100 * ASS_TO_CSS,
    };
  }
  let bottomPx = V_SUB_SINGLE_BOTTOM;
  if (split) {
    const logoHalf = logo && logoPosition !== 'top-center' ? (logo.h * V_H) / 2 : 0;
    bottomPx = V_H - V_CAM_H - V_SUB_BELOW_SEAM - logoHalf;
  }
  return { bottom: bottomPx / V_H, fontCqi: (size / V_W) * 100 * ASS_TO_CSS };
}

/** Logo merkezini, logonun tamamı kare içinde kalacak şekilde sınırlar. */
export function clampCenter(v: number, half: number) {
  return Math.min(1 - half, Math.max(half, v));
}

/**
 * Yapışma noktaları: merkez, üçte birler ve güvenli kenarlar (logonun kenarı
 * kenar payına değecek şekilde). Eşiğin içindeyse o noktaya yapışır.
 */
export function snap(value: number, half: number, threshold = 0.015): { value: number; guide: number | null } {
  const targets = [0.5, 1 / 3, 2 / 3, SAFE_MARGIN + half, 1 - SAFE_MARGIN - half];
  let best: { value: number; guide: number | null } = { value, guide: null };
  let dist = threshold;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d < dist) {
      dist = d;
      // Kenar hizasında kılavuz, logonun değdiği kenar payı çizgisinde gösterilir.
      const guide = t === SAFE_MARGIN + half ? SAFE_MARGIN : t === 1 - SAFE_MARGIN - half ? 1 - SAFE_MARGIN : t;
      best = { value: t, guide };
    }
  }
  return best;
}

/** 3x3 hizalama: sol/orta/sağ × üst/orta/alt, güvenli kenar payıyla. */
export function alignTo(col: 0 | 1 | 2, row: 0 | 1 | 2, halfW: number, halfH: number) {
  const pos = (i: 0 | 1 | 2, half: number) => (i === 0 ? SAFE_MARGIN + half : i === 1 ? 0.5 : 1 - SAFE_MARGIN - half);
  return { x: pos(col, halfW), y: pos(row, halfH) };
}
