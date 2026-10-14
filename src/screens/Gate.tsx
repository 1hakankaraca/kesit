import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Ticks, Wordmark } from '../components/basics.tsx';
import { enterAsGuest, useSession } from '../lib/session.ts';
import { useTheme } from '../lib/theme.ts';
import { toastError } from '../lib/toast.ts';

const LOGIN_ERRORS: Record<string, string> = {
  'kick-kapali': 'Kick ile giriş bu sunucuda henüz yapılandırılmadı. Misafir olarak devam edebilirsin.',
  gecersiz: 'Giriş isteğinin süresi doldu ya da yarıda kaldı. Tekrar dene.',
  hata: 'Kick girişi tamamlanamadı. Biraz sonra tekrar dene.',
};

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'scissors', title: 'Kliplerden dikey video', text: 'Kanalın kliplerini tara, seç; yüz kamerası, altyazı ve 9:16 kompozisyon otomatik.' },
  { icon: 'film', title: 'Geçmiş yayından kesit', text: 'Yayını indir, zaman çizelgesinde işaretle ya da en iyi anları otomatik buldur.' },
  { icon: 'shield', title: 'Sen yokken nöbet', text: 'Yayın açılınca kayıt başlar, chat klipleri işlenir; yayın bitince çıktı hazır olur.' },
  { icon: 'share', title: 'Zernio ile paylaşım', text: 'Hesabını bağla; TikTok, YouTube, Instagram için tek tıkla ya da planlı paylaş.' },
];

/** Giriş kapısı: Kick hesabıyla ya da kayıtsız misafir olarak. */
export function Gate() {
  useTheme('gate');
  const { kickLogin } = useSession();
  const [busy, setBusy] = useState(false);
  const reason = new URLSearchParams(location.search).get('giris');

  useEffect(() => {
    document.title = 'Kesit — giriş';
  }, []);

  const guest = async () => {
    setBusy(true);
    try {
      await enterAsGuest();
      history.replaceState(null, '', '/');
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <div className="gate-page">
      <header className="gate-top">
        <Wordmark />
        <span className="topbar-note">Kick yayıncıları için klip stüdyosu</span>
      </header>

      <main className="gate-main">
        <div className="gate-hero">
          <motion.h1 className="gate-title" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}>
            Yayından
            <br />
            <span className="reel-word">kesit</span>, kesitten
            <br />
            paylaşım.
          </motion.h1>
          <p className="gate-lead">Klipleri tara, geçmiş yayınları kes, canlıyı kaydet. Gerisini Kesit halleder — sen bilgisayar başında olmasan da.</p>

          <ul className="gate-features">
            {FEATURES.map((f, i) => (
              <motion.li key={f.title} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.07 }}>
                <span className="gate-feature-icon">
                  <Icon name={f.icon} />
                </span>
                <span>
                  <b>{f.title}</b>
                  {f.text}
                </span>
              </motion.li>
            ))}
          </ul>
        </div>

        <motion.section className="start" aria-labelledby="gate-start" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 26 }}>
          <div className="start-tape" aria-hidden="true">
            <Ticks />
          </div>
          <h2 id="gate-start" className="start-title">
            Stüdyoya gir
          </h2>
          {reason && LOGIN_ERRORS[reason] && (
            <p className="notice-box" role="alert">
              {LOGIN_ERRORS[reason]}
            </p>
          )}
          <a className={`btn btn-accent btn-large${kickLogin ? '' : ' is-disabled'}`} href={kickLogin ? '/auth/kick' : undefined} aria-disabled={!kickLogin}>
            <KickGlyph />
            Kick ile giriş yap
          </a>
          <p className="start-note">Yalnız kullanıcı adın ve kanalın okunur. Kesit senin adına yazmaz, yayın yapmaz.</p>
          <div className="start-or">ya da</div>
          <button type="button" className="btn btn-secondary btn-large" onClick={guest} disabled={busy}>
            <Icon name="user" />
            {busy ? 'Hazırlanıyor…' : 'Misafir olarak devam et'}
          </button>
          <p className="start-note">Kayıt yok. Çalışmaların bu tarayıcıdaki oturumda saklanır; istediğin kanalı takip edebilirsin.</p>
        </motion.section>
      </main>
    </div>
  );
}

function KickGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M3 3h6v5h2V6h2V4h2V3h6v6h-2v2h-2v2h2v2h2v6h-6v-1h-2v-2h-2v-2H9v5H3z" />
    </svg>
  );
}
