import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Project } from '../../shared/project.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Modal, Segmented, Spinner } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Job, Recording, VodJob } from '../lib/types.ts';
import { isHorizontal, jobTitle } from '../screens/Gallery.tsx';
import { LAYOUTS, type LayoutPreset, type TextPreset } from './model.ts';

type Origin = { type: 'job' | 'recording' | 'vod' | 'harvest'; id: number } | { type: 'logo' | 'intro' | 'outro' };
export type PanelTab = 'medya' | 'ses' | 'yazi' | 'duzen' | 'marka';

const TABS: { key: PanelTab; icon: IconName; label: string }[] = [
  { key: 'medya', icon: 'film', label: 'Medya' },
  { key: 'ses', icon: 'music', label: 'Ses' },
  { key: 'yazi', icon: 'text', label: 'Yazı' },
  { key: 'duzen', icon: 'layers', label: 'Düzen' },
  { key: 'marka', icon: 'image', label: 'Marka' },
];

const TEXT_PRESETS: { key: TextPreset; label: string; hint: string; sample: string }[] = [
  { key: 'baslik', label: 'Büyük başlık', hint: 'Üstte, kalın, konturlu', sample: 'BAŞLIK' },
  { key: 'bant', label: 'Alt bant', hint: 'Altta koyu şerit üstünde yazı', sample: 'Alt bant' },
  { key: 'etiket', label: 'İsim etiketi', hint: 'Köşede küçük marka rengi etiket', sample: 'kanal' },
  { key: 'cagri', label: 'Çağrı', hint: '"Takip et" tarzı vurgulu kutu', sample: 'TAKİP ET' },
  { key: 'serbest', label: 'Serbest yazı', hint: 'Ortada, istediğin gibi düzenle', sample: 'Yazı' },
];

/**
 * Sol panel: sekmeli araçlar (CapCut düzeni). Medya ve Ses sekmelerinde
 * dosyalar; Yazı ve Düzen sekmelerinde hazır kalıplar; Marka'da logo ve
 * açılış/kapanış. Dosyanın üstüne gelince "Ekle" çıkar; sürüklenebilir.
 */
export function MediaPanel({
  project,
  tab,
  onTab,
  hasSelection,
  onLink,
  onUpload,
  onPlace,
  onRemoveAsset,
  onAddText,
  onLayout,
}: {
  project: Project;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  hasSelection: boolean;
  onLink: (origins: Origin[]) => Promise<void>;
  onUpload: (files: FileList) => Promise<void>;
  onPlace: (asset: Asset) => void;
  onRemoveAsset: (asset: Asset) => void;
  onAddText: (preset: TextPreset) => void;
  onLayout: (layout: LayoutPreset) => void;
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
  const media = project.assets.filter((a) => !renders.has(a.id) && a.kind !== 'audio' && !['logo', 'intro', 'outro'].includes(a.origin.type));
  const audio = project.assets.filter((a) => a.kind === 'audio');
  const brand = project.assets.filter((a) => ['logo', 'intro', 'outro'].includes(a.origin.type));

  return (
    <aside className="epanel epanel-media" aria-label="Araçlar">
      <nav className="etabs" aria-label="Sekmeler">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? 'etab etab-on' : 'etab'} onClick={() => onTab(t.key)} aria-pressed={tab === t.key}>
            <Icon name={t.icon} size={16} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="etab-body">
        {busy && (
          <p className="muted epanel-note">
            <Spinner size={12} /> Ekleniyor…
          </p>
        )}

        {tab === 'medya' && (
          <>
            <div className="eadd">
              <AddButton icon="library" label="Galeri'den" hint="Video, kayıt, yayın" onClick={() => setPicker(true)} />
              <AddButton icon="upload" label="Bilgisayardan" hint="Video ya da görsel" onClick={() => fileInput.current?.click()} />
            </div>
            <AssetGrid assets={media} project={project} onPlace={onPlace} onRemove={onRemoveAsset} empty="Henüz video yok. Galeri'den ya da bilgisayardan ekle; eklenen dosyanın üstüne gelip Ekle'ye bas ya da zaman çizelgesine sürükle." />
          </>
        )}

        {tab === 'ses' && (
          <>
            <div className="eadd">
              <AddButton icon="music" label="Müzik / ses yükle" hint="MP3, WAV, M4A" onClick={() => audioInput.current?.click()} />
            </div>
            <AssetGrid assets={audio} project={project} onPlace={onPlace} onRemove={onRemoveAsset} empty="Müzik ya da ses efekti yükle; ses yoluna eklenir. Videonun kendi sesi parça ayarlarından kısılır." />
            <p className="field-help">İpucu: videonun sesini kısmak için parçayı seç, sağdan "Ses seviyesi"ni ayarla; <kbd>M</kbd> sessize alır.</p>
          </>
        )}

        {tab === 'yazi' && (
          <ul className="preset-list">
            {TEXT_PRESETS.map((t) => (
              <li key={t.key}>
                <button type="button" className="preset-card" onClick={() => onAddText(t.key)}>
                  <span className={`preset-sample preset-sample-${t.key}`}>{t.sample}</span>
                  <span>
                    <b>{t.label}</b>
                    <small>{t.hint}</small>
                  </span>
                  <Icon name="plus" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === 'duzen' && (
          <>
            <p className="field-help">{hasSelection ? 'Seçili parçaya uygulanır.' : 'Önce zaman çizelgesinde bir video parçası seç; yoksa ilk video parçasına uygulanır.'}</p>
            <ul className="preset-list">
              {LAYOUTS.filter((l) => !l.vertical || project.format === 'vertical').map((l) => (
                <li key={l.key}>
                  <button type="button" className="preset-card" onClick={() => onLayout(l.key)}>
                    <LayoutSketch layout={l.key} vertical={project.format === 'vertical'} />
                    <span>
                      <b>{l.label}</b>
                      <small>{l.hint}</small>
                    </span>
                    <Icon name="chevron" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {project.format !== 'vertical' && <p className="field-help">Kamera üstte/altta düzenleri dikey projede görünür. Proje biçimini sağ panelden değiştirebilirsin.</p>}
          </>
        )}

        {tab === 'marka' && (
          <>
            <div className="eadd">
              <AddButton icon="image" label="Logo" hint="Logo ve görünüm'den" onClick={() => void run(() => onLink([{ type: 'logo' }]))} />
              <AddButton icon="film" label="Açılış / kapanış" hint="Marka videoları" onClick={() => void run(() => onLink([{ type: 'intro' }, { type: 'outro' }]))} />
            </div>
            <AssetGrid assets={brand} project={project} onPlace={onPlace} onRemove={onRemoveAsset} empty="Logo ile açılış/kapanış videolarını 'Logo ve görünüm' bölümünde yüklersin; burada projeye eklersin." />
          </>
        )}
      </div>

      <input ref={fileInput} type="file" hidden multiple accept="video/*,image/*" onChange={(e) => e.target.files?.length && void run(() => onUpload(e.target.files!)).then(() => (e.target.value = ''))} />
      <input ref={audioInput} type="file" hidden multiple accept="audio/*" onChange={(e) => e.target.files?.length && void run(() => onUpload(e.target.files!)).then(() => (e.target.value = ''))} />

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

function AssetGrid({ assets, project, onPlace, onRemove, empty }: { assets: Asset[]; project: Project; onPlace: (a: Asset) => void; onRemove: (a: Asset) => void; empty: string }) {
  if (!assets.length) return <p className="muted epanel-note">{empty}</p>;
  const used = new Set(project.clips.map((c) => c.assetId));
  return (
    <ul className="easset-grid">
      {assets.map((a) => (
        <li key={a.id}>
          <div
            className="easset"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('kesit/asset', a.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            title="Sürükleyip zaman çizelgesine bırak"
          >
            <span className={`easset-thumb easset-${a.kind}`}>
              {a.thumb ? <img src={a.thumb} alt="" loading="lazy" /> : <Icon name={a.kind === 'audio' ? 'music' : a.kind === 'image' ? 'image' : 'film'} size={20} />}
              {a.duration > 0 && <span className="clip-badge clip-badge-dur">{duration(a.duration)}</span>}
              {used.has(a.id) && <span className="easset-used" title="Zaman çizelgesinde kullanılıyor" />}
              <button type="button" className="easset-add" onClick={() => onPlace(a)} title="Oynatma çizgisine ekle">
                <Icon name="plus" size={14} /> Ekle
              </button>
            </span>
            <span className="easset-name">{a.name}</span>
          </div>
          <button type="button" className="easset-x" onClick={() => onRemove(a)} aria-label="Dosyayı projeden çıkar" title="Projeden çıkar">
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
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

/** Düzen kalıbının küçük şeması. */
function LayoutSketch({ layout, vertical }: { layout: LayoutPreset; vertical: boolean }) {
  return (
    <span className={vertical ? 'lsk lsk-v' : 'lsk lsk-h'} aria-hidden="true">
      {layout === 'kamera-ust' && (
        <>
          <i className="lsk-cam" style={{ top: 0, left: 0, width: '100%', height: '32%' }} />
          <i className="lsk-scr" style={{ bottom: 0, left: 0, width: '100%', height: '66%' }} />
        </>
      )}
      {layout === 'kamera-alt' && (
        <>
          <i className="lsk-scr" style={{ top: 0, left: 0, width: '100%', height: '66%' }} />
          <i className="lsk-cam" style={{ bottom: 0, left: 0, width: '100%', height: '32%' }} />
        </>
      )}
      {layout === 'kamera-kose' && (
        <>
          <i className="lsk-scr" style={{ inset: 0 }} />
          <i className="lsk-cam" style={{ right: '6%', bottom: vertical ? '24%' : '8%', width: vertical ? '42%' : '28%', height: vertical ? '14%' : '28%' }} />
        </>
      )}
      {layout === 'tam' && <i className="lsk-scr" style={{ inset: 0 }} />}
      {layout === 'sigdir' && <i className="lsk-scr" style={{ left: 0, right: 0, top: '34%', height: '32%' }} />}
    </span>
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
