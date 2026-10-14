import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type FormEvent } from 'react';
import { HlsVideo } from '../components/HlsVideo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Empty, Modal, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { count, duration, relative } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { KickClip } from '../lib/types.ts';

type Source = 'kick' | 'kickbot';
type Time = 'all' | 'month' | 'week' | 'day';
type Sort = 'view' | 'date';
type Composition = 'auto' | 'split' | 'single';

interface Page {
  clips: KickClip[];
  nextCursor: string | number | null;
}

/** Klipler: kanalın Kick/KickBot kliplerini tara, seç ve dikey videoya çevir. */
export function Clips() {
  const { user } = useSession();
  const [channel, setChannel] = useState(user?.channelSlug ?? '');
  const [source, setSource] = useState<Source>('kick');
  const [time, setTime] = useState<Time>('all');
  const [sort, setSort] = useState<Sort>('view');
  const [clips, setClips] = useState<KickClip[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, KickClip>>(new Map());
  const [subtitles, setSubtitles] = useState(true);
  const [composition, setComposition] = useState<Composition>('auto');
  const [link, setLink] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<KickClip | null>(null);

  const browse = async (append = false, override?: string) => {
    const slug = (override ?? channel).trim();
    if (!slug) return;
    setLoading(true);
    try {
      const page = await api.get<Page & { channel: string }>(`/api/clips/browse${query({ channel: slug, source, time, sort, cursor: append ? cursor : 0 })}`);
      const typed = page.clips.map((c) => ({ ...c, type: source }));
      setClips((prev) => (append ? [...prev, ...typed] : typed));
      setCursor(page.nextCursor);
      setSearched(page.channel);
      if (!append) setSelected(new Map());
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  };

  // Üstteki kanal sekmesi değişince liste o kanala geçer.
  useEffect(() => {
    const slug = user?.channelSlug;
    if (!slug || slug === searched) return;
    setChannel(slug);
    void browse(false, slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.channelSlug]);

  useEffect(() => {
    if (channel.trim()) void browse();
    // Kaynak/filtre değişince listeyi tazele.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, time, sort]);

  const toggle = (clip: KickClip) =>
    setSelected((s) => {
      const next = new Map(s);
      if (next.has(clip.id)) next.delete(clip.id);
      else if (next.size < 20) next.set(clip.id, clip);
      else toast('Tek seferde en fazla 20 klip', 'error');
      return next;
    });

  const options = { subtitles, composition, outputFormat: 'vertical' };

  const process = async () => {
    setSubmitting(true);
    try {
      const res = await api.post<{ jobs: unknown[]; errors: string[] }>('/api/clips/process', {
        channel: searched,
        clips: [...selected.values()].map((c) => ({ id: c.id, type: c.type, title: c.title })),
        options,
      });
      toast(`${res.jobs.length} klip sıraya alındı${res.errors.length ? `, ${res.errors.length} hata` : ''}`, 'ok');
      setSelected(new Map());
      await refreshJobs();
      navigate(sectionPath('kutuphane'));
    } catch (err) {
      toastError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const fromLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!link.trim()) return;
    setSubmitting(true);
    try {
      await api.post('/api/clips/from-url', { url: link.trim(), options });
      toast('Klip sıraya alındı', 'ok');
      setLink('');
      await refreshJobs();
    } catch (err) {
      toastError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const autoPopular = async () => {
    setSubmitting(true);
    try {
      await api.post('/api/clips/popular', { channel: channel.trim(), limit: 5, time: time === 'all' ? 'week' : time, options });
      toast('En popüler 5 klip sıraya alındı', 'ok');
      await refreshJobs();
      navigate(sectionPath('kutuphane'));
    } catch (err) {
      toastError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <WorkspaceHead guide="klipler" title="Kick" tape="klipleri" lead="Kanalın Kick kliplerini getir, beğendiklerini seç; dikey videoya kendiliğinden çevrilsin. Küçük resme tıklayınca izlersin." />

      <div className="toolbar panel">
        <form
          className="toolbar-search"
          onSubmit={(e) => {
            e.preventDefault();
            void browse();
          }}
        >
          <div className="search search-large">
            <Icon name="search" size={18} />
            <input className="search-input" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Kanal adı (ör. livorass)" aria-label="Kanal" />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading || !channel.trim()}>
            {loading ? <Spinner /> : 'Klipleri getir'}
          </button>
        </form>
        <div className="toolbar-filters">
          <Segmented
            size="small"
            label="Kaynak"
            value={source}
            onChange={setSource}
            options={[
              { value: 'kick', label: 'Kick' },
              { value: 'kickbot', label: 'KickBot' },
            ]}
          />
          <Segmented
            size="small"
            label="Zaman"
            value={time}
            onChange={setTime}
            options={[
              { value: 'day', label: 'Bugün' },
              { value: 'week', label: 'Hafta' },
              { value: 'month', label: 'Ay' },
              { value: 'all', label: 'Tümü' },
            ]}
          />
          <Segmented
            size="small"
            label="Sıra"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'view', label: 'En çok izlenen' },
              { value: 'date', label: 'En yeni' },
            ]}
          />
        </div>
      </div>

      <div className="ws-grid">
        <div className="ws-stack">
          {!searched && !loading ? (
            <div className="panel">
              <Empty icon="scissors" title="Bir kanal yaz, klipleri getirelim">
                Kendi kanalını ya da takip ettiğin herhangi bir yayıncıyı tarayabilirsin.
              </Empty>
            </div>
          ) : loading && !clips.length ? (
            <div className="clip-grid">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="clip-card clip-card-skeleton" />
              ))}
            </div>
          ) : clips.length === 0 ? (
            <div className="panel">
              <Empty icon="search" title={`${searched} için klip bulunamadı`}>
                Zaman aralığını genişletmeyi ya da KickBot kaynağını denemeyi düşün.
              </Empty>
            </div>
          ) : (
            <>
              <ul className="clip-grid">
                {clips.map((c, i) => {
                  const on = selected.has(c.id);
                  return (
                    <motion.li key={c.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025 }}>
                      <div className={on ? 'clip-card clip-card-on' : 'clip-card'}>
                        <button type="button" className="clip-thumb clip-thumb-play" onClick={() => setPreview(c)} aria-label={`${c.title || 'Klibi'} izle`}>
                          {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" loading="lazy" /> : <Icon name="film" size={26} />}
                          <span className="clip-play" aria-hidden="true">
                            <Icon name="play" size={18} />
                          </span>
                          <span className="clip-badge clip-badge-dur">{duration(c.duration)}</span>
                          {c.processed && <span className="clip-badge clip-badge-done">İşlendi</span>}
                        </button>
                        <button type="button" className="clip-check" onClick={() => toggle(c)} aria-pressed={on} aria-label={on ? 'Seçimi kaldır' : 'Seç'}>
                          <Icon name="check" size={14} />
                        </button>
                        <button type="button" className="clip-card-body" onClick={() => toggle(c)} aria-pressed={on}>
                          <span className="clip-card-title">{c.title || 'Başlıksız klip'}</span>
                          <span className="clip-card-meta">
                            <Icon name="eye" size={13} /> {count(c.viewCount)} izlenme · {relative(c.createdAt)}
                          </span>
                        </button>
                      </div>
                    </motion.li>
                  );
                })}
              </ul>
              {cursor !== null && cursor !== undefined && (
                <div className="center-pad">
                  <button type="button" className="btn btn-secondary" onClick={() => void browse(true)} disabled={loading}>
                    {loading ? <Spinner /> : 'Daha fazla getir'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <aside className="ws-stack">
          <section className="panel">
            <span className="panel-tape" aria-hidden="true" />
            <h2 className="panel-title">Üretim</h2>
            <p className="panel-sub">Seçtiğin kliplere uygulanır. Ayrıntılı varsayılanlar Marka bölümünde.</p>
            <div className="stack">
              <Switch checked={subtitles} onChange={setSubtitles} label="Altyazı" hint="Konuşma yazıya dökülür, önemli anlar vurgulanır" />
              <Segmented
                label="Yerleşim"
                value={composition}
                onChange={setComposition}
                options={[
                  { value: 'auto', label: 'Otomatik' },
                  { value: 'split', label: 'Kamera + oyun' },
                  { value: 'single', label: 'Tek kare' },
                ]}
              />
              <button type="button" className="btn btn-secondary" onClick={autoPopular} disabled={submitting || !channel.trim()}>
                <Icon name="sparkle" size={16} /> En popüler 5'i otomatik işle
              </button>
            </div>
          </section>

          <form className="panel" onSubmit={fromLink}>
            <h2 className="panel-title">Bağlantıdan ekle</h2>
            <p className="panel-sub">kick.com ya da kickbot.com klip bağlantısı yapıştır.</p>
            <div className="inline-form">
              <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://kick.com/…/clips/clip_…" aria-label="Klip bağlantısı" />
              <button type="submit" className="btn btn-primary" disabled={submitting || !link.trim()}>
                Ekle
              </button>
            </div>
          </form>
        </aside>
      </div>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.title || 'Klip'}
        wide
        footer={
          preview && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => toggle(preview)}>
                <Icon name="check" size={16} /> {selected.has(preview.id) ? 'Seçimden çıkar' : 'Seç'}
              </button>
              <button
                type="button"
                className="btn btn-accent"
                disabled={submitting}
                onClick={() => {
                  setSelected(new Map([[preview.id, preview]]));
                  setPreview(null);
                }}
              >
                <Icon name="vertical" size={16} /> Yalnız bunu seç
              </button>
            </>
          )
        }
      >
        {preview?.videoUrl ? (
          <div className="stage stage-h">
            <HlsVideo key={preview.id} className="stage-video" src={preview.videoUrl} poster={preview.thumbnailUrl ?? undefined} controls autoPlay playsInline />
          </div>
        ) : (
          <p className="muted">Bu klibin oynatma adresi yok.</p>
        )}
        {preview && (
          <p className="muted pad-top">
            {count(preview.viewCount)} izlenme · {duration(preview.duration)} · {relative(preview.createdAt)}
          </p>
        )}
      </Modal>

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div className="action-bar" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}>
            <b>{selected.size} klip seçildi</b>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setSelected(new Map())}>
              Temizle
            </button>
            <button type="button" className="btn btn-accent" onClick={process} disabled={submitting}>
              {submitting ? <Spinner /> : <Icon name="vertical" size={16} />}
              Dikey klip üret
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
