import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ChannelSearch, type ChannelHit } from '../components/ChannelSearch.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Spinner, Switch, Wordmark } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { liveStore, refreshLive } from '../lib/live.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { markOnboarded, saveChannels, useSession } from '../lib/session.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { AutopilotConfig, Studio as StudioData, ZernioSummary } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { ConnectionPanel } from './Publish.tsx';
import { CaptionsPanel, ExportPanel } from './Settings.tsx';
import { LogoUpload, MediaUpload } from './Studio.tsx';

type StepId = 'kanal' | 'logo' | 'intro' | 'zernio' | 'genel' | 'bitti';

const STEPS: { id: StepId; label: string; icon: IconName }[] = [
  { id: 'kanal', label: 'Kanal', icon: 'live' },
  { id: 'logo', label: 'Logo', icon: 'image' },
  { id: 'intro', label: 'Açılış / kapanış', icon: 'film' },
  { id: 'zernio', label: 'Paylaşım', icon: 'share' },
  { id: 'genel', label: 'Genel ayarlar', icon: 'key' },
  { id: 'bitti', label: 'Hazır', icon: 'check' },
];

/**
 * İlk kurulum sihirbazı: yeni kullanıcı sırayla kanalını seçer, logo ve
 * açılış/kapanış videosunu yükler, Zernio'yu bağlar, genel ayarları yapar.
 * Her adım atlanabilir; atlanan şey (logo, intro…) kliplere eklenmez,
 * sonradan Logo ve görünüm / Paylaşım / Ayarlar'dan tamamlanır.
 */
export function Onboarding() {
  const { user, tabs } = useSession();
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const studio = useResource(() => api.get<StudioData>('/api/studio'));
  const zernio = useResource(() => api.get<ZernioSummary>('/api/zernio'));

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [index]);

  const next = () => setIndex((i) => Math.min(STEPS.length - 1, i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  const finish = async () => {
    setFinishing(true);
    try {
      await markOnboarded(true);
      toast('Kurulum tamamlandı — iyi kesitler!', 'ok');
      navigate(sectionPath('anasayfa'), true);
    } catch (err) {
      toastError(err);
      setFinishing(false);
    }
  };

  const summary = {
    channel: user?.channelSlug ?? null,
    tabs: tabs.length,
    logo: !!studio.data?.logo.exists,
    intro: !!studio.data?.intro.exists,
    outro: !!studio.data?.outro.exists,
    zernio: !!zernio.data?.connected,
  };

  return (
    <div className="onb">
      <header className="onb-head">
        <Wordmark />
        <div className="onb-head-text">
          <h1 className="onb-title">
            Hoş geldin{user?.username ? `, ${user.username}` : ''}
            <span className="onb-tape">kurulum</span>
          </h1>
          <p className="muted">Birkaç adımda stüdyonu hazırlayalım. Elinde olmayanı "Şimdilik atla" ile geçebilirsin; sonradan Ayarlar'dan tamamlarsın.</p>
        </div>
      </header>

      <ol className="onb-steps" aria-label="Kurulum adımları">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i === index ? 'onb-step on' : i < index ? 'onb-step done' : 'onb-step'}>
            <button type="button" onClick={() => i < index && setIndex(i)} disabled={i > index} aria-current={i === index ? 'step' : undefined}>
              <span className="onb-step-ic">{i < index ? <Icon name="check" size={13} /> : <Icon name={s.icon} size={13} />}</span>
              <span className="onb-step-label">{s.label}</span>
            </button>
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait">
        <motion.section key={step.id} className="panel onb-panel" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.22 }}>
          <span className="panel-tape" aria-hidden="true" />
          {step.id === 'kanal' && <ChannelStep />}
          {step.id === 'logo' && (
            <StepBody title="Logon var mı?" lead="Dikey kliplerde kamera ile oyun arasındaki şeride, yatay videolarda köşeye basılır. Yoksa klipler logosuz çıkar; sonra Logo ve görünüm'den eklersin.">
              {studio.data ? <LogoUpload logo={studio.data.logo} max={studio.data.limits.logoMaxBytes} onChange={() => void studio.reload()} /> : <Spinner />}
            </StepBody>
          )}
          {step.id === 'intro' && (
            <StepBody title="Açılış ve kapanış videosu" lead="Yalnız yatay videoların başına ve sonuna eklenir (dikey kliplere eklenmez). Yüklemezsen videolar olduğu gibi çıkar.">
              {studio.data ? (
                <div className="stack">
                  <MediaUpload kind="intro" media={studio.data.intro} onChange={() => void studio.reload()} />
                  <MediaUpload kind="outro" media={studio.data.outro} onChange={() => void studio.reload()} />
                </div>
              ) : (
                <Spinner />
              )}
            </StepBody>
          )}
          {step.id === 'zernio' && (
            <StepBody title="Paylaşım hesabı (Zernio)" lead="Hazır klipleri TikTok, YouTube ve Instagram'a tek tıkla göndermek için Zernio API anahtarını bağla. Şimdi atlarsan klipleri indirip elle de paylaşabilirsin.">
              <ConnectionPanel zernio={zernio.data} loading={zernio.loading} onChange={() => void zernio.reload()} />
            </StepBody>
          )}
          {step.id === 'genel' && (
            <StepBody title="Genel ayarlar" lead="Altyazı motoru ve hazır videoların kopyalanacağı klasör. Altyazı için yerel whisper modelini bir kez indirmen yeter; istemezsen klipler altyazısız üretilir.">
              <div className="stack">
                <CaptionsPanel />
                <ExportPanel />
              </div>
            </StepBody>
          )}
          {step.id === 'bitti' && <DoneStep summary={summary} />}
        </motion.section>
      </AnimatePresence>

      <footer className="onb-foot">
        <button type="button" className="btn btn-quiet" onClick={back} disabled={index === 0}>
          ← Geri
        </button>
        <span className="muted small">
          {index + 1} / {STEPS.length}
        </span>
        <div className="row-gap">
          {!last && step.id !== 'kanal' && (
            <button type="button" className="btn btn-secondary" onClick={next}>
              Şimdilik atla
            </button>
          )}
          {!last ? (
            <button type="button" className="btn btn-accent" onClick={next} disabled={step.id === 'kanal' && !user?.channelSlug}>
              İleri →
            </button>
          ) : (
            <button type="button" className="btn btn-accent btn-large" onClick={() => void finish()} disabled={finishing}>
              {finishing ? <Spinner /> : <Icon name="check" size={16} />} Stüdyoya gir
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function StepBody({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <>
      <h2 className="panel-title">{title}</h2>
      <p className="panel-sub">{lead}</p>
      <div className="onb-body">{children}</div>
    </>
  );
}

/** Adım 1: hangi kanal takip edilecek; istenirse çevrimdışı bot takibi de açılır. */
function ChannelStep() {
  const { user, tabs } = useSession();
  const live = liveStore.use();
  const [pending, setPending] = useState<ChannelHit | null>(null);
  const [busy, setBusy] = useState(false);
  const active = user?.channelSlug ?? null;
  const autopilot = live?.autopilot.config;
  const watching = !!autopilot?.enabled && autopilot.channel === active;

  const choose = async (hit: ChannelHit) => {
    setBusy(true);
    try {
      const slug = hit.slug;
      await saveChannels(tabs.includes(slug) ? tabs : [...tabs, slug], slug);
      setPending(null);
      toast(`${hit.username} seçildi`, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleWatch = async (on: boolean) => {
    if (!active || !autopilot) return;
    setBusy(true);
    try {
      const next: AutopilotConfig = { ...autopilot, channel: active, enabled: on };
      await api.put('/api/autopilot', next);
      await refreshLive();
      toast(on ? `Bot ${active} kanalını izleyecek` : 'Bot takibi kapalı', 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepBody title="Hangi kanalı takip edelim?" lead="Kendi kanalın ya da takip ettiğin herhangi bir yayıncı. Klipler, yayınlar ve kayıtlar bu kanala göre listelenir; üstteki sekmelerden sonradan başka kanallar da eklersin.">
      {active ? (
        <div className="onb-chosen">
          <span className="onb-chosen-dot" aria-hidden="true" />
          <div>
            <b>{active}</b>
            <span className="muted small">Seçili kanal{tabs.length > 1 ? ` · ${tabs.length} sekme` : ''}</span>
          </div>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setPending(null)} disabled={busy}>
            Değiştir
          </button>
        </div>
      ) : null}
      {(!active || pending) && (
        <div className="onb-search">
          {pending ? (
            <div className="ctabs-pending">
              {pending.avatarUrl ? <img src={pending.avatarUrl} alt="" /> : <span className="csearch-avatar" />}
              <b>{pending.username}</b>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setPending(null)}>
                Vazgeç
              </button>
              <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => void choose(pending)}>
                {busy ? <Spinner size={12} /> : 'Bu kanalı seç'}
              </button>
            </div>
          ) : (
            <ChannelSearch autoFocus large onPick={setPending} placeholder="Kick kanal adı yaz…" />
          )}
        </div>
      )}
      {active && !pending && <ChannelSearch onPick={setPending} placeholder="Başka bir kanal ara" />}
      {active && autopilot && (
        <div className="onb-watch">
          <Switch checked={watching} onChange={(v) => void toggleWatch(v)} label="Sen yokken de izlesin (çevrimdışı bot takip)" hint="Yayın açılınca chat'e düşen klipleri yakalar, yayın bitince yayını indirir. Sonradan Çevrimdışı bot takip'ten değiştirilir." />
        </div>
      )}
    </StepBody>
  );
}

function DoneStep({ summary }: { summary: { channel: string | null; tabs: number; logo: boolean; intro: boolean; outro: boolean; zernio: boolean } }) {
  const rows: { label: string; ok: boolean; text: string }[] = [
    { label: 'Kanal', ok: !!summary.channel, text: summary.channel ?? 'Seçilmedi' },
    { label: 'Logo', ok: summary.logo, text: summary.logo ? 'Yüklendi · kliplere basılır' : 'Yok · klipler logosuz çıkar' },
    { label: 'Açılış videosu', ok: summary.intro, text: summary.intro ? 'Yüklendi · yatay videoların başına' : 'Yok · eklenmez' },
    { label: 'Kapanış videosu', ok: summary.outro, text: summary.outro ? 'Yüklendi · yatay videoların sonuna' : 'Yok · eklenmez' },
    { label: 'Zernio', ok: summary.zernio, text: summary.zernio ? 'Bağlı · tek tıkla paylaşım' : 'Bağlı değil · klipleri indirip elle paylaşırsın' },
  ];
  return (
    <StepBody title="Stüdyon hazır" lead="Özet aşağıda. Eksikleri istediğin zaman Logo ve görünüm, Paylaşım ve Ayarlar bölümlerinden tamamlarsın; bu sihirbazı Ayarlar'dan yeniden açabilirsin.">
      <ul className="onb-summary">
        {rows.map((r) => (
          <li key={r.label} className={r.ok ? 'ok' : ''}>
            <span className="onb-sum-ic">
              <Icon name={r.ok ? 'check' : 'x'} size={12} />
            </span>
            <b>{r.label}</b>
            <span className="muted">{r.text}</span>
          </li>
        ))}
      </ul>
    </StepBody>
  );
}
