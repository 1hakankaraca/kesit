const tr = 'tr-TR';

export function duration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Zaman çizelgesi damgası: ondalıklı saniye. */
export function stamp(sec: number): string {
  const whole = Math.floor(sec);
  return `${duration(whole)}.${Math.floor((sec - whole) * 10)}`;
}

export function bytes(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toLocaleString(tr, { maximumFractionDigits: x < 10 ? 1 : 0 })} ${units[i]}`;
}

export function count(n: number | null | undefined): string {
  return (Number(n) || 0).toLocaleString(tr, { notation: 'compact', maximumFractionDigits: 1 });
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleString(tr, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function day(v: string | Date): string {
  return new Date(v).toLocaleDateString(tr, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function time(v: string | Date | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleTimeString(tr, { hour: '2-digit', minute: '2-digit' });
}

export function relative(v: string | Date | null | undefined): string {
  if (!v) return '';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(tr, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(-Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(-Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(-Math.round(diff / (86400 * 365)), 'year');
}

/** Yerel tarih anahtarı (YYYY-AA-GG). */
export function dayKey(v: string | Date): string {
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
