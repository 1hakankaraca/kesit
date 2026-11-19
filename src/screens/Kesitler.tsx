import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Empty, Modal, Pill, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { useChannelScope } from '../lib/channelScope.ts';
import { bytes, duration, relative } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import { openMenu } from '../components/ContextMenu.tsx';
import { createStore } from '../lib/store.ts';
import type { ChannelInfo, Snippet } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';
import { ChannelBanner } from './Live.tsx';

export const SNIPPET_SECONDS = [15, 30, 45, 60, 90, 120, 180, 300, 600, 1200, 1800, 2700] as const;
/** Düğme yazısı: 5 dakikadan itibaren dakika, altı saniye. */
const secLabel = (sec: number): { n: number; unit: string } => (sec >= 300 ? { n: sec / 60, unit: 'dk' } : { n: sec, unit: 'sn' });
const AUTO_KEY = 'kesit.kesitler.otomatikDikey';

function readAuto() {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Tek ayar, iki panel: biri değişince diğeri de aynı anda güncellenir. */
const autoStore = createStore<boolean>(readAuto());
function setAutoPersist(v: boolean) {
  autoStore.set(v);
  try {
    localStorage.setItem(AUTO_KEY, v ? '1' : '0');
  } catch {
    /* depolama kapalı */
  }
}

/**
 * Kesitler: anlık klip düğmesiyle yayının son N saniyesi Kick'in süren yayın
 * kaydından alınır, ham olarak burada listelenir ve istenirse dikey videoya
 * çevrilir (dikey sonuç Galeri'ye düşer, buradan da açılır).
 */
export function Kesitler() {
  const { user } = useSession();
  const { inScope } = useChannelScope();
  const channel = user?.channelSlug ?? '';
  const info = useResource(() => (channel ? api.get<ChannelInfo>(`/api/live/channel${query({ channel })}`) : Promise.resolve(null)), [channel]);
  useInterval(() => channel && void info.reload(), 45_000);
  const list = useResource(() => api.get<{ snippets: Snippet[] }>('/api/snippets').then((r) => r.snippets));
  useSocketEvent<{ snippets: Snippet[] }>('snippet:update', (e) => list.setData(e.snippets));
  const [playing, setPlaying] = useState<Snippet | null>(null);
  const snippets = (list.data ?? []).filter((s) => inScope(s.channel));

  return (
    <>
      <WorkspaceHead
        guide="kesitler"
        title="Kesitler"
        tape="anlık"
        lead="Yayın sürerken bir düğmeye bas: yayının son 30–180 saniyesi buraya iner, istersen kendiliğinden dikey videoya çevrilir. Bilgisayarındaki bir videoyu ya da Google Drive bağlantısını da buraya atıp dikeye çevirebilirsin."
      />
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      <div className="live-grid">
        <div className="ws-stack">
          <QuickCapturePanel channel={channel} isLive={!!info.data?.isLive} />
          <ImportPanel channel={channel} />
        </div>
        <div className="ws-stack">
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2 className="panel-title">
                  <Icon name="film" size={18} /> Alınan kesitler
                </h2>
                <p className="panel-sub">Ham dosyayı indir, izle ya da dikey videoya çevir. Dikey sonuçlar Galeri'de de görünür.</p>
              </div>
              {snippets.length > 0 && <Pill tone="ok">{snippets.length} kesit</Pill>}
            </header>
            {!list.data ? (
              <Spinner />
            ) : snippets.length === 0 ? (
              <Empty icon="bolt" title="Henüz kesit yok">
                Kanal yayındayken soldaki süre düğmelerinden birine bas ya da "Dışarıdan ekle" ile bir video dosyası / Drive bağlantısı ver; kesit burada görünür.
              </Empty>
            ) : (
              <ul className="snippet-list">
                <AnimatePresence initial={false}>
                  {snippets.map((s) => (
                    <motion.li key={s.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <SnippetRow snippet={s} onPlay={() => setPlaying(s)} onChange={() => void list.reload()} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </section>
        </div>
      </div>

      <Modal open={!!playing} onClose={() => setPlaying(null)} title={playing?.title || 'Kesit'} wide>
        {playing?.videoUrl && (
          <div className="stage stage-h">
            <video className="stage-video" src={playing.videoUrl} controls autoPlay playsInline />
          </div>
        )}
      </Modal>
    </>
  );
}

/** Süre düğmeleri: yayının son N saniyesini kesit olarak alır. */
export function QuickCapturePanel({ channel, isLive, compact = false }: { channel: string; isLive: boolean; compact?: boolean }) {
  const [sending, setSending] = useState<number | null>(null);
  const auto = autoStore.use();
  const send = async (seconds: number) => {
    setSending(seconds);
    try {
      await api.post('/api/snippets/capture', { channel, seconds, autoEdit: auto });
      const l = secLabel(seconds);
      toast(`Son ${l.n} ${l.unit === 'dk' ? 'dakika' : 'saniye'} alınıyor${auto ? ' ve dikey videoya çevrilecek' : ''}`, 'ok', compact ? { label: 'Kesitlere git', run: () => navigate(sectionPath('kesitler')) } : undefined, 5000);
    } catch (err) {
      toastError(err);
    } finally {
      setSending(null);
    }
  };
  return (
    <section className="panel" aria-labelledby="qc-title">
      <header className="panel-head">
        <div>
          <h2 id="qc-title" className="panel-title">
            <Icon name="bolt" size={18} /> Anlık kesit al
          </h2>
          <p className="panel-sub">Düğmeye bastığın andan geriye doğru o kadar süre Kick'in yayın kaydından alınır (15 saniyeden 45 dakikaya). Yayın kaydı canlıdan yarım dakika kadar geride gelir; uzun kesitler biraz daha geç iner.</p>
        </div>
      </header>
      <div className="quick-grid">
        {SNIPPET_SECONDS.map((sec) => {
          const l = secLabel(sec);
          return (
            <button key={sec} type="button" className={l.unit === 'dk' ? 'quick-btn quick-btn-min' : 'quick-btn'} disabled={!isLive || !channel || sending !== null} onClick={() => void send(sec)}>
              {sending === sec ? <Spinner size={14} /> : <b>{l.n}</b>}
              <span>{l.unit}</span>
            </button>
          );
        })}
      </div>
      <div className="pad-top">
        <Switch checked={auto} onChange={setAutoPersist} label="Gelen kesitleri dikey videoya çevir" hint="Canlıdan alınan ve dışarıdan eklenen kesitler için tek ayar. Kapalıysa yalnız ham dosya iner; sonradan tek tıkla çevirirsin." />
      </div>
      {!channel ? (
        <p className="field-help pad-top">Üstteki sekmelerden bir kanal seç.</p>
      ) : (
        !isLive && <p className="field-help pad-top">Kanal şu an yayında değil; kesit yalnız yayın sürerken alınır.</p>
      )}
      {compact && (
        <p className="field-help pad-top">
          Alınan kesitler{' '}
          <button type="button" className="link" onClick={() => navigate(sectionPath('kesitler'))}>
            Kesitler
          </button>{' '}
          bölümünde.
        </p>
      )}
    </section>
  );
}

const VIDEO_ACCEPT = 'video/*,.mp4,.mov,.mkv,.webm,.m4v,.ts,.avi';

/** Dosyayı ham gövde olarak XHR ile yükler ki ilerleme izlenebilsin. */
function uploadWithProgress(url: string, file: File, onProgress: (ratio: number) => void) {
  return new Promise<{ snippet: Snippet }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new Error('Yükleme kesildi'));
    xhr.onload = () => {
      let body: { snippet?: Snippet; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* JSON değil */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.snippet) resolve({ snippet: body.snippet });
      else reject(new Error(body.error || `Yükleme başarısız (${xhr.status})`));
    };
    xhr.send(file);
  });
}

/**
 * Dışarıdan ekle: bilgisayardan dosya (sürükle-bırak ya da seç) veya bağlantı
 * (Google Drive paylaşımı, doğrudan video adresi). Kesit listeye iner ve
 * istenirse kendiliğinden dikey videoya çevrilir.
 */
function ImportPanel({ channel }: { channel: string }) {
  const auto = autoStore.use();
  const [url, setUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [upload, setUpload] = useState<{ name: string; ratio: number; index: number; count: number } | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const sendFiles = async (files: FileList | File[] | null | undefined) => {
    const list = Array.from(files ?? []).filter((f) => f.size > 0);
    if (!list.length) return;
    let ok = 0;
    for (const [i, file] of list.entries()) {
      setUpload({ name: file.name, ratio: 0, index: i + 1, count: list.length });
      try {
        await uploadWithProgress(`/api/snippets/upload${query({ channel, name: file.name, autoEdit: auto ? '1' : '0' })}`, file, (ratio) => setUpload({ name: file.name, ratio, index: i + 1, count: list.length }));
        ok++;
      } catch (err) {
        toastError(err);
      }
    }
    setUpload(null);
    if (fileInput.current) fileInput.current.value = '';
    if (ok) toast(ok === 1 ? `Video alındı${auto ? ', dikey videoya çevrilecek' : ''}` : `${ok} video alındı${auto ? ', dikey videoya çevrilecek' : ''}`, 'ok');
  };

  const sendUrl = async () => {
    const text = url.trim();
    if (!text) return;
    setSending(true);
    try {
      await api.post('/api/snippets/import', { channel, url: text, autoEdit: auto });
      setUrl('');
      toast(`İndiriliyor${auto ? '; inince dikey videoya çevrilecek' : ''}`, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="imp-title">
      <header className="panel-head">
        <div>
          <h2 id="imp-title" className="panel-title">
            <Icon name="upload" size={18} /> Dışarıdan ekle
          </h2>
          <p className="panel-sub">Bilgisayarından bir video seç ya da Google Drive bağlantısı yapıştır. Video kesit olarak buraya iner; istersen hemen dikey videoya çevrilir.</p>
        </div>
      </header>
      <label
        className={over ? 'drop-zone drop-zone-over' : 'drop-zone'}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void sendFiles(e.dataTransfer.files);
        }}
      >
        <input ref={fileInput} type="file" accept={VIDEO_ACCEPT} multiple hidden disabled={!!upload} onChange={(e) => void sendFiles(e.target.files)} />
        {upload ? (
          <>
            <Spinner size={18} />
            <b>
              {upload.count > 1 ? `${upload.index}/${upload.count} · ` : ''}
              {upload.name}
            </b>
            <span className="muted">{upload.ratio >= 1 ? 'Sunucuda hazırlanıyor…' : `Yükleniyor %${Math.round(upload.ratio * 100)}`}</span>
            <div className="progress drop-progress" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${Math.round(upload.ratio * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            <Icon name="upload" size={22} />
            <b>Dosya seç ya da buraya sürükle</b>
            <span className="muted">MP4, MOV, MKV, WebM · birden çok dosya olabilir</span>
          </>
        )}
      </label>
      <div className="import-link">
        <input
          className="input"
          type="url"
          inputMode="url"
          placeholder="https://drive.google.com/file/d/… ya da doğrudan video adresi"
          value={url}
          disabled={sending}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void sendUrl()}
          aria-label="Video bağlantısı"
        />
        <button type="button" className="btn btn-secondary" disabled={sending || !url.trim()} onClick={() => void sendUrl()}>
          {sending ? <Spinner size={12} /> : <Icon name="link" size={14} />} İndir
        </button>
      </div>
      <p className="field-help">Drive'da dosya "Bağlantıya sahip herkes" görüntüleyebilir olmalı; büyük dosyalardaki virüs taraması uyarısı kendiliğinden geçilir.</p>
      <div className="pad-top">
        <Switch checked={auto} onChange={setAutoPersist} label="Gelen kesitleri dikey videoya çevir" hint="Canlıdan alınan ve dışarıdan eklenen kesitler için tek ayar. Kapalıysa yalnız ham dosya iner; sonradan tek tıkla çevirirsin." />
      </div>
    </section>
  );
}

/** Alınırken satır metni: kaynağa ve aşamaya göre. */
function pendingText(s: Snippet) {
  if (s.source === 'live') return 'Yayın kaydından alınıyor…';
  if (s.progress?.stage === 'hazirlaniyor') return 'Dosya hazırlanıyor…';
  const pct = s.progress?.percent;
  const where = s.source === 'drive' ? "Drive'dan indiriliyor" : s.source === 'url' ? 'İndiriliyor' : 'Alınıyor';
  return pct !== null && pct !== undefined ? `${where} %${pct}${s.progress?.total ? ` · ${bytes(s.progress.bytes)} / ${bytes(s.progress.total)}` : ''}` : `${where}…${s.progress?.bytes ? ` ${bytes(s.progress.bytes)}` : ''}`;
}

function SnippetRow({ snippet: s, onPlay, onChange }: { snippet: Snippet; onPlay: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = () =>
    deleteWithUndo({
      label: 'Kesit silindi',
      hide: onChange,
      restore: onChange,
      commit: () => api.del(`/api/snippets/${s.id}`),
      done: onChange,
    });
  const edit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/snippets/${s.id}/edit`);
      toast("Dikey videoya çevriliyor — Galeri'de görünecek", 'ok');
      void refreshJobs();
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/api/snippets/${s.id}/cancel`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const menu = (e: React.MouseEvent) =>
    openMenu(
      e,
      [
        !!s.videoUrl && { label: 'İzle', icon: 'play', onSelect: onPlay },
        s.jobId ? { label: 'Dikey videoyu gör', icon: 'vertical', onSelect: () => navigate(sectionPath('galeri', s.jobId!)) } : s.status === 'ready' && { label: 'Dikey videoya çevir', icon: 'vertical', disabled: busy, onSelect: () => void edit() },
        !!s.videoUrl && { label: 'Ham kesiti indir', icon: 'download', onSelect: () => location.assign(s.videoUrl!) },
        s.status === 'downloading' && { label: 'Alımı iptal et', icon: 'x', onSelect: () => void cancel() },
        { separator: true },
        s.status !== 'downloading' && { label: 'Sil', icon: 'trash', danger: true, onSelect: remove },
      ],
      'Kesit',
    );
  return (
    <div className="snippet-item" onContextMenu={menu}>
      <button type="button" className="harvest-thumb snippet-thumb" onClick={onPlay} disabled={!s.videoUrl} aria-label="Kesiti izle">
        {s.thumbUrl ? <img src={s.thumbUrl} alt="" loading="lazy" /> : s.status === 'downloading' ? <Spinner size={16} /> : <Icon name="film" />}
        {s.videoUrl && (
          <span className="clip-play" aria-hidden="true">
            <Icon name="play" size={14} />
          </span>
        )}
      </button>
      <div className="harvest-body">
        <b>{s.title}</b>
        <span className="muted">
          {s.status === 'downloading' ? pendingText(s) : s.status === 'failed' ? `Alınamadı: ${s.error ?? ''}` : `${duration(s.durationSec)} · ${bytes(s.sizeBytes)} · ${relative(s.createdAt)}${s.source === 'drive' ? ' · Drive' : s.source === 'file' ? ' · dosya' : s.source === 'url' ? ' · bağlantı' : ''}`}
        </span>
      </div>
      <div className="row-gap">
        {s.status === 'downloading' && (
          <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void cancel()}>
            İptal
          </button>
        )}
        {s.videoUrl && (
          <a className="btn btn-quiet btn-small" href={s.videoUrl} download title="Ham kesiti indir">
            <Icon name="download" size={14} /> Ham
          </a>
        )}
        {s.status === 'ready' &&
          (s.jobId ? (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => navigate(sectionPath('galeri', s.jobId))}>
              <Icon name="vertical" size={14} /> Dikey videoyu gör
            </button>
          ) : (
            <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => void edit()}>
              {busy ? <Spinner size={12} /> : <Icon name="vertical" size={14} />} Dikey videoya çevir
            </button>
          ))}
        {s.status !== 'downloading' && (
          <button type="button" className="btn btn-quiet btn-icon" onClick={remove} aria-label="Sil">
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
