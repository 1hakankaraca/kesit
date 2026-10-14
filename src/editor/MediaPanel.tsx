import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Project } from '../../shared/project.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Modal, Segmented, Spinner } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Job, Recording, VodJob } from '../lib/types.ts';
import { isHorizontal, jobTitle } from '../screens/Gallery.tsx';

type Origin = { type: 'job' | 'recording' | 'vod' | 'harvest'; id: number } | { type: 'logo' | 'intro' | 'outro' };

/**
 * Sol panel: projedeki dosyalar ve ekleme yolları. Tıklayınca oynatma
 * çizgisine eklenir; zaman çizelgesine sürüklenebilir.
 */
export function MediaPanel({
  project,
  onLink,
  onUpload,
  onPlace,
  onRemoveAsset,
  onAddText,
}: {
  project: Project;
  onLink: (origins: Origin[]) => Promise<void>;
  onUpload: (files: FileList) => Promise<void>;
  onPlace: (asset: Asset) => void;
  onRemoveAsset: (asset: Asset) => void;
  onAddText: () => void;
}) {
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const renders = new Set(project.assets.filter((a) => a.origin.type === 'render').map((a) => a.id));
  const visible = project.assets.filter((a) => !renders.has(a.id));

  return (
    <aside className="epanel epanel-media" aria-label="Dosyalar">
      <div className="epanel-head">
        <b>Dosyalar</b>
        {busy && <Spinner size={14} />}
      </div>
      <div className="eadd">
        <AddButton icon="library" label="Galeri'den" hint="Video, kayıt, yayın" onClick={() => setPicker(true)} />
        <AddButton icon="upload" label="Bilgisayardan" hint="Video ya da görsel" onClick={() => fileInput.current?.click()} />
        <AddButton icon="music" label="Müzik / ses" hint="MP3, WAV, M4A" onClick={() => audioInput.current?.click()} />
        <AddButton icon="text" label="Yazı" hint="Başlık, not, isim" onClick={onAddText} />
        <AddButton icon="image" label="Logo" hint="Logo ve görünüm'den" onClick={() => void run(() => onLink([{ type: 'logo' }]))} />
        <AddButton icon="film" label="Açılış / kapanış" hint="Marka videoları" onClick={() => void run(() => onLink([{ type: 'intro' }, { type: 'outro' }]))} />
      </div>
      <input ref={fileInput} type="file" hidden multiple accept="video/*,image/*" onChange={(e) => e.target.files?.length && void run(() => onUpload(e.target.files!)).then(() => (e.target.value = ''))} />
      <input ref={audioInput} type="file" hidden multiple accept="audio/*" onChange={(e) => e.target.files?.length && void run(() => onUpload(e.target.files!)).then(() => (e.target.value = ''))} />

      {visible.length === 0 ? (
        <p className="muted epanel-note">Henüz dosya yok. Yukarıdan ekle; eklenen dosyaya tıklayınca oynatma çizgisinin olduğu yere gelir.</p>
      ) : (
        <ul className="easset-grid">
          {visible.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="easset"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('kesit/asset', a.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onPlace(a)}
                title="Tıkla: oynatma çizgisine ekle · Sürükle: zaman çizelgesine bırak"
              >
                <span className={`easset-thumb easset-${a.kind}`}>
                  {a.thumb ? <img src={a.thumb} alt="" loading="lazy" /> : <Icon name={a.kind === 'audio' ? 'music' : a.kind === 'image' ? 'image' : 'film'} size={20} />}
                  {a.duration > 0 && <span className="clip-badge clip-badge-dur">{duration(a.duration)}</span>}
                </span>
                <span className="easset-name">{a.name}</span>
              </button>
              <button type="button" className="easset-x" onClick={() => onRemoveAsset(a)} aria-label="Dosyayı projeden çıkar" title="Projeden çıkar">
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <GalleryPicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(origins) => {
          setPicker(false);
          void run(() => onLink(origins));
        }}
      />
    </aside>
  );
}

function AddButton({ icon, label, hint, onClick }: { icon: IconName; label: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" className="eadd-btn" onClick={onClick}>
      <Icon name={icon} size={16} />
      <span>
        <b>{label}</b>
        <small>{hint}</small>
      </span>
    </button>
  );
}

type PickKind = 'video' | 'recording' | 'vod' | 'harvest';

interface PickItem {
  key: string;
  origin: Origin;
  title: string;
  thumb: string | null;
  meta: string;
  vertical: boolean;
}

/** Galeri'den çoklu seçim: videolar, yayın kayıtları, indirilen yayınlar, yakalanan klipler. */
function GalleryPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (origins: Origin[]) => void }) {
  const [kind, setKind] = useState<PickKind>('video');
  const [items, setItems] = useState<PickItem[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setChosen(new Set());
    const load = async () => {
      if (kind === 'video') {
        const r = await api.get<{ jobs: Job[] }>('/api/jobs?limit=300');
        setItems(r.jobs.filter((j) => j.status === 'ready').map((j) => ({ key: `j${j.id}`, origin: { type: 'job', id: j.id }, title: jobTitle(j), thumb: j.thumbnail_url, meta: `${duration(j.duration)} · ${j.channel_slug ?? ''}`, vertical: !isHorizontal(j) })));
      } else if (kind === 'recording') {
        const r = await api.get<{ recordings: Recording[] }>('/api/recordings');
        setItems(r.recordings.filter((x) => x.available).map((x) => ({ key: `r${x.id}`, origin: { type: 'recording', id: x.id }, title: x.title || `${x.channel_slug} yayın kaydı`, thumb: null, meta: `${duration(x.duration_sec)} · ${x.channel_slug}`, vertical: false })));
      } else if (kind === 'vod') {
        const r = await api.get<{ jobs: VodJob[] }>('/api/vod-jobs');
        setItems(r.jobs.filter((x) => x.status === 'downloaded').map((x) => ({ key: `v${x.id}`, origin: { type: 'vod', id: x.id }, title: x.title || `Yayın #${x.source_video_id}`, thumb: x.thumbnail_url, meta: `${duration(x.duration_sec)} · ${x.channel_slug}`, vertical: false })));
      } else {
        const r = await api.get<{ clips: { id: number; title: string | null; thumbnailUrl: string | null; durationSec: number | null; channel: string; videoUrl: string | null }[] }>('/api/harvest');
        setItems(r.clips.filter((x) => x.videoUrl).map((x) => ({ key: `h${x.id}`, origin: { type: 'harvest', id: x.id }, title: x.title || 'Kick klibi', thumb: x.thumbnailUrl, meta: `${duration(x.durationSec)} · ${x.channel}`, vertical: false })));
      }
    };
    load().catch((err) => {
      toastError(err);
      setItems([]);
    });
  }, [open, kind]);

  const visible = useMemo(() => {
    const n = q.trim().toLocaleLowerCase('tr');
    return (items ?? []).filter((i) => !n || i.title.toLocaleLowerCase('tr').includes(n));
  }, [items, q]);

  const toggle = (key: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Galeri'den ekle"
      wide
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Vazgeç
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={!chosen.size}
            onClick={() => {
              const picked = (items ?? []).filter((i) => chosen.has(i.key)).map((i) => i.origin);
              if (!picked.length) return toast('Bir şey seçmedin', 'error');
              onPick(picked);
            }}
          >
            {chosen.size ? `${chosen.size} dosyayı ekle` : 'Ekle'}
          </button>
        </>
      }
    >
      <div className="picker-tools">
        <Segmented
          size="small"
          label="Kaynak"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'video', label: 'Videolar' },
            { value: 'recording', label: 'Yayın kayıtları' },
            { value: 'vod', label: 'İndirilen yayınlar' },
            { value: 'harvest', label: 'Yakalanan klipler' },
          ]}
        />
        <div className="search">
          <Icon name="search" size={14} />
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ara" aria-label="Ara" />
        </div>
      </div>
      {items === null ? (
        <div className="center-pad">
          <Spinner size={20} />
        </div>
      ) : visible.length === 0 ? (
        <p className="muted pad">Bu bölümde eklenecek dosya yok.</p>
      ) : (
        <ul className="picker-grid">
          {visible.map((i) => {
            const on = chosen.has(i.key);
            return (
              <li key={i.key}>
                <button type="button" className={on ? 'picker-item picker-on' : 'picker-item'} onClick={() => toggle(i.key)} aria-pressed={on}>
                  <span className={i.vertical ? 'picker-thumb picker-thumb-v' : 'picker-thumb'}>
                    {i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : <Icon name="film" size={20} />}
                    <span className="clip-check">
                      <Icon name="check" size={12} />
                    </span>
                  </span>
                  <span className="picker-title">{i.title}</span>
                  <span className="picker-meta">{i.meta}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
