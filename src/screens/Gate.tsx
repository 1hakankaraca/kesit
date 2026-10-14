import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ChannelSearch } from '../components/ChannelSearch.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Ticks, Wordmark } from '../components/basics.tsx';
import { enterAsGuest, linkKick, pairDevice } from '../lib/session.ts';
import { useTheme } from '../lib/theme.ts';
import { toastError } from '../lib/toast.ts';

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'scissors', title: 'Kliplerden dikey video', text: 'Kanalın kliplerini tara, seç; yüz kamerası, altyazı ve 9:16 kompozisyon otomatik.' },
  { icon: 'film', title: 'Geçmiş yayından kesit', text: 'Yayını indir, zaman çizelgesinde işaretle ya da en iyi anları otomatik buldur.' },
  { icon: 'shield', title: 'Sen yokken nöbet', text: 'Yayın açılınca chat klipleri yakalanır; yayın bitince yayının tamamı indirilir, editörde seni bekler.' },
  { icon: 'share', title: 'Zernio ile paylaşım', text: 'Hesabını bağla; TikTok, YouTube, Instagram için tek tıkla ya da planlı paylaş.' },
];

/** Giriş kapısı: Kick hesabıyla ya da kayıtsız misafir olarak. */
export function Gate() {
  useTheme('gate');
  const [busy, setBusy] = useState(false);
  const [kickOpen, setKickOpen] = useState(false);

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

  const link = async (slug: string) => {
    setBusy(true);
    try {
      await linkKick(slug);
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
          {kickOpen ? (
            <div className="stack-s">
              <ChannelSearch large autoFocus placeholder="Kick kullanıcı adını yaz" onPick={(h) => void link(h.slug)} />
              <p className="start-note">{busy ? 'Hesap bağlanıyor…' : 'Kanalını listeden seç. Sohbete klip atmak istersen sonra Ayarlar\'dan kendi Kick uygulamanı bağlarsın.'}</p>
            </div>
          ) : (
            <>
              <button type="button" className="btn btn-accent btn-large" onClick={() => setKickOpen(true)}>
                <KickGlyph />
                Kick ile giriş yap
              </button>
              <p className="start-note">Kick kanalını seç, hesabın bağlansın. Şifre istenmez; Kesit senin adına yazmaz, yayın yapmaz.</p>
            </>
          )}
          <div className="start-or">ya da</div>
          <button type="button" className="btn btn-secondary btn-large" onClick={guest} disabled={busy}>
            <Icon name="user" />
            {busy ? 'Hazırlanıyor…' : 'Misafir olarak devam et'}
          </button>
          <p className="start-note">Kayıt yok. İstediğin kanalı takip edebilirsin.</p>
          <p className="start-local">
            <Icon name="folder" size={14} /> Tüm veriler — klipler, kayıtlar, ayarlar — yalnız bu bilgisayarda saklanır.
          </p>
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

/** Yerel ağdaki (telefon) eşlenmemiş cihaz: bilgisayar ekranındaki kodu girer. */
export function PairGate() {
  useTheme('gate');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await pairDevice(code);
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };
  return (
    <div className="gate-page">
      <header className="gate-top">
        <Wordmark />
      </header>
      <main className="pair">
        <section className="start">
          <div className="start-tape" aria-hidden="true">
            <Ticks />
          </div>
          <h1 className="start-title">Bu cihazı eşle</h1>
          <p className="start-note">
            Bilgisayarda Kesit'i aç, <b>Ayarlar → Telefondan erişim</b> bölümünde "Kod üret"e bas ve ekrandaki 6 haneli kodu buraya yaz.
          </p>
          <form
            className="stack-s"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              className="input pair-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              aria-label="Eşleme kodu"
              autoFocus
            />
            <button type="submit" className="btn btn-accent btn-large" disabled={busy || code.length !== 6}>
              {busy ? 'Eşleniyor…' : 'Eşle'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
