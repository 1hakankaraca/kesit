/**
 * Zaman girişleri: kullanıcı "25" (dakika), "25:30" (dk:sn) ya da "1:02:00"
 * (sa:dk:sn) yazabilir; hepsi saniyeye çevrilir.
 */

/** Geçersiz ya da boş girişte null. Ondalık dakika da olur ("12.5" → 750 sn). */
export function parseClock(input: string): number | null {
  const text = String(input ?? '')
    .trim()
    .replace(',', '.');
  if (!text) return null;
  const parts = text.split(':').map((p) => p.trim());
  if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (parts.length === 1) return Math.round(nums[0] * 60);
  if (parts.length === 2) return Math.round(nums[0] * 60 + nums[1]);
  return Math.round(nums[0] * 3600 + nums[1] * 60 + nums[2]);
}

/** Saniyeyi girişe geri yazılabilir biçimde verir (sa:dd:ss ya da dd:ss). */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Kick'in "2026-10-16 18:14:00" biçimindeki saatleri UTC'dir; tarayıcı bunu
 * yerel saat sanar. ISO (T/Z) gelirse olduğu gibi okunur.
 */
export function kickTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = String(value).trim();
  const utcGibi = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const ms = Date.parse(utcGibi);
  return Number.isFinite(ms) ? ms : null;
}
