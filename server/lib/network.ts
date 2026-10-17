import os from 'node:os';

/** IPv4-eşlemeli IPv6 önekini atar (::ffff:192.168.1.5 → 192.168.1.5). */
export function plainIp(ip: string | undefined | null): string {
  return String(ip || '').replace(/^::ffff:/, '');
}

export function isLoopback(ip: string | undefined | null): boolean {
  const v = plainIp(ip);
  return v === '::1' || v === 'localhost' || /^127\./.test(v);
}

/** Tailscale/WireGuard benzeri kişisel ağların kullandığı CGNAT aralığı (100.64.0.0/10). */
export function isTailscaleIp(ip: string | undefined | null): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(plainIp(ip));
}

/**
 * Özel (yerel ağ) IPv4 aralıkları. Tailscale'in 100.64/10 aralığı da özel
 * sayılır: uzaktan erişim için port açmak yerine kişisel ağ kullanılır,
 * oradaki cihazlar yerel ağdaki telefon gibi eşleme koduyla girer.
 */
export function isPrivateIp(ip: string | undefined | null): boolean {
  const v = plainIp(ip);
  return /^10\./.test(v) || /^192\.168\./.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^169\.254\./.test(v) || isTailscaleIp(v);
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
