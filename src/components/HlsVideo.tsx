import { useEffect, useRef, type VideoHTMLAttributes } from 'react';

/**
 * HLS (.m3u8) ya da düz video oynatıcı. hls.js yalnız gerektiğinde yüklenir
 * (paket büyük).
 */
export function HlsVideo({ src, live = false, ...rest }: { src: string; live?: boolean } & VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const isHls = /\.m3u8(\?|$)/.test(src);
    if (!isHls) {
      video.src = src;
      return;
    }
    // Önce hls.js: bazı Chrome sürümleri HLS'i "oynatabilirim" deyip Kick'in
    // byte-range parçalarında başarısız oluyor. hls.js yoksa (eski iOS) yerleşik oynatıcı.
    let player: { destroy(): void } | null = null;
    let cancelled = false;
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        video.src = src;
        return;
      }
      const hls = new Hls(live ? { liveSyncDurationCount: 3 } : {});
      hls.loadSource(src);
      hls.attachMedia(video);
      player = hls;
    });
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [src, live]);

  return <video ref={ref} {...rest} />;
}
