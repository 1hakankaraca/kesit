/**
 * Motorun teknik adım adlarını herkesin anlayacağı dile çevirir.
 * Yeni bir adım eklenirse burada karşılığı yazılmalı; yoksa baş harfi büyütülüp gösterilir.
 */
const STEPS: Record<string, string> = {
  '': 'Sırada',
  indiriliyor: 'İndiriliyor',
  hazırlanıyor: 'Hazırlanıyor',
  'kaynak bulunuyor': 'Yayın bulunuyor',
  'facecam tespiti': 'Yüz kamerası aranıyor',
  'kadraj hazırlanıyor': 'Kadraj hazırlanıyor',
  iptal: 'İptal edildi',
  'hareket analizi': 'Görüntü inceleniyor',
  'yüz takibi': 'Yüz takip ediliyor',
  'transkript çıkarılıyor': 'Konuşma yazıya dökülüyor',
  'video oluşturuluyor': 'Video hazırlanıyor',
  'kontrol ediliyor': 'Son kontrol yapılıyor',
  'kalite denetimi': 'Son kontrol yapılıyor',
  'küfür bipleniyor': 'Küfürler sansürleniyor',
  'açıklama üretiliyor': 'Açıklama yazılıyor',
  'viral skor': 'Beğenilme tahmini yapılıyor',
  kırpılıyor: 'Kırpılıyor',
  indirildi: 'İndirildi',
  tamamlandı: 'Hazır',
};

export function stepLabel(step: string | null | undefined): string {
  const key = (step ?? '').trim();
  if (key in STEPS) return STEPS[key];
  return key ? key.charAt(0).toLocaleUpperCase('tr') + key.slice(1) : 'Sırada';
}

/** Saniye başına bayt → "3,2 MB/sn". */
export function speedLabel(bps: number | null | undefined): string {
  const v = Number(bps) || 0;
  if (v <= 0) return '';
  const mb = v / 1048576;
  return mb >= 1 ? `${mb.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB/sn` : `${Math.round(v / 1024)} KB/sn`;
}

/** Yüzde ve geçen süreden kalan süre tahmini → "~4 dk kaldı". */
export function etaLabel(progress: number | null | undefined, startedAt: number | null | undefined): string {
  const p = Number(progress) || 0;
  if (!startedAt || p < 2 || p >= 100) return '';
  const elapsed = (Date.now() - startedAt) / 1000;
  const left = (elapsed * (100 - p)) / p;
  if (!Number.isFinite(left) || left <= 0) return '';
  if (left < 60) return '1 dakikadan az kaldı';
  if (left < 3600) return `~${Math.round(left / 60)} dk kaldı`;
  return `~${(left / 3600).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} saat kaldı`;
}
