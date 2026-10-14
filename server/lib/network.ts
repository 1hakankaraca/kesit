import os from 'node:os';

/** IPv4-eşlemeli IPv6 önekini atar (::ffff:192.168.1.5 → 192.168.1.5). */
export function plainIp(ip: string | undefined | null): string {
  return String(ip || '').replace(/^::ffff:/, '');
}

export function isLoopback(ip: string | undefined | null): boolean {
  const v = plainIp(ip);
  return v === '::1' || v === 'localhost' || /^127\./.test(v);
}

/** Özel (yerel ağ) IPv4 aralıkları. */
export function isPrivateIp(ip: string | undefined | null): boolean {
  const v = plainIp(ip);
  return /^10\./.test(v) || /^192\.168\./.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^169\.254\./.test(v);
}

/**
 * Host başlığı izin listesi — DNS rebinding'e karşı: tarayıcı başka bir alan
 * adıyla bu sunucuya istek atarsa reddedilir. Yalnız localhost, loopback,
 * yerel ağ IP'leri ve bu bilgisayarın adı (.local) kabul edilir.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  // *.localhost adları (ör. kesit.localhost) tarayıcıda yerel makineye çözülür.
  if (host === 'localhost' || host.endsWith('.localhost') || isLoopback(host) || isPrivateIp(host)) return true;
  const name = os.hostname().toLowerCase().replace(/\.local$/, '');
  return host === name || host === `${name}.local`;
}
