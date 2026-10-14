import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FORMAT_SIZE, fitFrame, type Asset, type Clip, type Project, type Rect } from '../../shared/project.ts';
import { Icon } from '../components/Icon.tsx';
import { Empty, Modal, Progress, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { duration, relative, stamp } from '../lib/format.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { ProjectSummary, RenderStatus, Studio } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { Inspector } from './Inspector.tsx';
import { MediaPanel, type PanelTab } from './MediaPanel.tsx';
import { Stage } from './Stage.tsx';
import { Tracks, type MenuItem, type TimelineTool } from './Tracks.tsx';
import {
  LAYOUTS,
  addAssetClip,
  addTextClip,
  addTrack,
  applyLayout,
  clipEnd,
  closeGaps,
  duplicateClip,
  mainTrackId,
  moveToTrack,
  pasteClip,
  removeClips,
  removeTrack,
  rippleRemove,
  splitAt,
  trimToPlayhead,
  updateClip,
  type LayoutPreset,
  type TextPreset,
} from './model.ts';
import { renderTextToBlob, textRenderKey } from './textRender.ts';
import { useProject } from './useProject.ts';

const COACH_KEY = 'kesit.editor.rehber.v1';
const MAGNET_KEY = 'kesit.editor.miknatis';

const SHORTCUTS: [string, string][] = [
  ['Boşluk', 'Oynat / duraklat'],
  ['S  ·  ⌘B', 'Oynatma çizgisinden böl'],
  ['Q', 'Seçili parçanın başını (çizginin solunu) at'],
  ['W', 'Seçili parçanın sonunu (çizginin sağını) at'],
  ['Sil', 'Parçayı kaldır'],
  ['⇧ Sil', 'Kaldır ve sonrakileri geri çek'],
  ['⌘D', 'Çoğalt'],
  ['⌘C  ·  ⌘V', 'Kopyala · oynatma çizgisine yapıştır'],
  ['M', 'Sessize al / aç'],
  ['⌘Z  ·  ⇧⌘Z', 'Geri al · yinele'],
  ['←  →', 'Bir kare geri / ileri (⇧ ile 1 sn)'],
  ['Home  ·  End', 'Başa / sona git'],
  ['⌘ + tekerlek', 'Zaman çizelgesini yakınlaştır'],
  ['Alt + sürükle', 'Önizlemede yapışmadan taşı / serbest boyutla'],
  ['?', 'Bu listeyi aç'],
];

/** Editör: proje listesi ya da seçili projenin çalışma alanı. */
export function Editor({ projectId }: { projectId: number | null }) {
  return projectId ? <Workspace key={projectId} id={projectId} /> : <ProjectList />;
}

/* ── Proje listesi ─────────────────────────────────────────────────────── */

function ProjectList() {
  const list = useResource(() => api.get<{ projects: ProjectSummary[] }>('/api/projects').then((r) => r.projects));
  const [creating, setCreating] = useState(false);
  useSocketEvent('project:render', () => void list.reload());

  const create = async (format: 'horizontal' | 'vertical') => {
    setCreating(true);
    try {
      const res = await api.post<{ project: Project }>('/api/projects', { format });
      navigate(sectionPath('editor', res.project.id));
    } catch (err) {
      toastError(err);
    } finally {
      setCreating(false);
    }
  };

  const remove = (p: ProjectSummary) =>
    deleteWithUndo({
      label: 'Proje silindi',
      hide: () => list.setData((d) => d?.filter((x) => x.id !== p.id) ?? d),
      restore: () => void list.reload(),
      commit: () => api.del(`/api/projects/${p.id}`),
    });

  return (
    <>
      <WorkspaceHead
        guide="editor"
        title="Editör"
        tape="stüdyo"
        lead="Boş bir projeyle başla ya da kaldığın yerden devam et. Galeri'deki her videoyu da 'Editörde aç' ile buraya getirebilirsin."
        actions={
          <>
            <button type="button" className="btn btn-accent" disabled={creating} onClick={() => void create('vertical')}>
              {creating ? <Spinner /> : <Icon name="vertical" size={16} />} Yeni dikey proje
            </button>
            <button type="button" className="btn btn-secondary" disabled={creating} onClick={() => void create('horizontal')}>
              <Icon name="horizontal" size={16} /> Yeni yatay proje
            </button>
          </>
        }
      />
      {list.loading && !list.data ? (
        <div className="center-pad">
          <Spinner size={24} />
        </div>
      ) : !list.data?.length ? (
        <div className="panel">
          <Empty icon="scissors" title="Henüz proje yok">
            Yukarıdan boş bir proje aç ya da Galeri'den bir videoyu "Editörde aç" ile getir.
          </Empty>
        </div>
      ) : (
        <ul className="gallery-grid">
          {list.data.map((p) => (
            <li key={p.id}>
              <a
                href={sectionPath('editor', p.id)}
                className={`gcard gcard-${p.format}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(sectionPath('editor', p.id));
                }}
              >
                <span className="gcard-thumb">
                  {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <Icon name="scissors" size={28} />}
                  {p.durationSec > 0 && <span className="clip-badge clip-badge-dur">{duration(p.durationSec)}</span>}
                  {p.rendering && !p.rendering.jobId && !p.rendering.error && (
                    <span className="gcard-busy">
                      <Spinner size={14} /> Dışa aktarılıyor %{p.rendering.percent}
                    </span>
                  )}
                </span>
                <span className="gcard-body">
                  <span className="gcard-title">{p.title}</span>
                  <span className="gcard-meta">
                    {p.format === 'vertical' ? 'Dikey' : 'Yatay'} · {relative(p.updatedAt)}
                  </span>
                </span>
              </a>
              <button type="button" className="gcard-x" onClick={() => remove(p)} aria-label="Projeyi sil" title="Projeyi sil">
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ── Çalışma alanı ─────────────────────────────────────────────────────── */

function readFlag(key: string, dflt: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch {
    return dflt;
  }
}

function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* depolama kapalı */
  }
}

function Workspace({ id }: { id: number }) {
  const pr = useProject(id);
  const { project } = pr;
  const studio = useResource(() => api.get<Studio>('/api/studio'));
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<PanelTab>('medya');
  const [magnetic, setMagnetic] = useState(() => readFlag(MAGNET_KEY, true));
  const [safeZone, setSafeZone] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [coach, setCoach] = useState(() => !readFlag(COACH_KEY, false));
  const [hint, setHint] = useState<string | null>(null);
  const clipboard = useRef<Clip | null>(null);
  const raf = useRef<number | null>(null);
  const lastTick = useRef(0);
  const timeRef = useRef(0);
  timeRef.current = time;

  const total = useMemo(() => (project ? project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) : 0), [project]);
  const selected = project?.clips.find((c) => c.id === selectedId) ?? null;
  const accent = studio.data?.brand.brandColor ?? '#f43f5e';

  /* ── Oynatma saati ───────────────────────────────────────────────────── */
  useEffect(() => {
    if (!playing) {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
      return;
    }
    lastTick.current = performance.now();
    const step = (now: number) => {
      const dt = (now - lastTick.current) / 1000;
      lastTick.current = now;
      const next = timeRef.current + dt;
      if (next >= total) {
        setTime(total);
        setPlaying(false);
        return;
      }
      setTime(next);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, total]);

  const seek = useCallback((t: number) => setTime(Math.max(0, t)), []);
  const togglePlay = () => {
    if (!playing && time >= total) setTime(0);
    setPlaying((p) => !p);
  };

  useEffect(() => writeFlag(MAGNET_KEY, magnetic), [magnetic]);

  /* ── Render durumu ───────────────────────────────────────────────────── */
  useSocketEvent<RenderStatus>('project:render', (e) => {
    if (e.projectId !== id) return;
    pr.setRender(e);
    if (e.done && e.jobId) {
      setExporting(false);
      toast('Video hazır — Galeri\'de', 'ok', { label: 'Videoyu aç', run: () => navigate(sectionPath('galeri', e.jobId!)) }, 8000);
    } else if (e.failed) {
      setExporting(false);
      toast(e.error || 'Dışa aktarılamadı', 'error');
    }
  });

  /* ── Komutlar ────────────────────────────────────────────────────────── */
  const split = () =>
    pr.update((p) => {
      const r = splitAt(p, timeRef.current, selectedId ? [selectedId] : undefined);
      if (!r.created.length) toast('Oynatma çizgisi bir parçanın içinde değil', 'info');
      return r.project;
    });
  const remove = (ripple = false) => {
    if (!selectedId) return;
    pr.update((p) => (ripple ? rippleRemove(p, selectedId) : removeClips(p, [selectedId], magnetic)));
    setSelectedId(null);
  };
  const trimSide = (side: 'left' | 'right') => selectedId && pr.update((p) => trimToPlayhead(p, selectedId, timeRef.current, side, magnetic));
  const duplicate = () =>
    selectedId &&
    pr.update((p) => {
      const r = duplicateClip(p, selectedId);
      if (r.clip) setSelectedId(r.clip.id);
      return r.project;
    });
  const copy = () => {
    if (selected) {
      clipboard.current = selected;
      toast('Kopyalandı — ⌘V ile oynatma çizgisine yapıştır', 'ok');
    }
  };
  const paste = () => {
    const src = clipboard.current;
    if (!src) return;
    pr.update((p) => {
      const r = pasteClip(p, src, timeRef.current, magnetic);
      if (r.clip) setSelectedId(r.clip.id);
      else toast('Yapıştırılacak yer yok', 'error');
      return r.project;
    });
  };
  const toggleMute = () => selected && pr.update((p) => updateClip(p, selected.id, { muted: !selected.muted }));

  /* ── Klavye ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) pr.redo();
        else pr.undo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        duplicate();
      } else if (mod && k === 'c') copy();
      else if (mod && k === 'v') paste();
      else if (mod && k === 'b') {
        e.preventDefault();
        split();
      } else if (!mod && k === 's') split();
      else if (!mod && k === 'q') trimSide('left');
      else if (!mod && k === 'w') trimSide('right');
      else if (!mod && k === 'm') toggleMute();
      else if (k === '?' || (e.shiftKey && k === '/')) setShowKeys(true);
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          e.preventDefault();
          remove(e.shiftKey);
        }
      } else if (e.key === 'ArrowLeft') seek(timeRef.current - (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'ArrowRight') seek(timeRef.current + (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(total);
      else if (e.key === 'Escape') {
        setSelectedId(null);
        setShowKeys(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  /* ── Varlık ekleme ───────────────────────────────────────────────────── */
  const place = (asset: Asset, at = timeRef.current, trackId?: string) => {
    pr.update((p) => {
      const r = addAssetClip(p, asset, at, trackId, magnetic);
      setSelectedId(r.clip.id);
      if (p.clips.length === 0) setHint('İlk parça yerleşti. Yazı ve müzik için soldaki sekmeleri kullan; S ile oynatma çizgisinden bölersin.');
      return r.project;
    });
  };

  const link = async (origins: { type: string; id?: number }[]) => {
    for (const from of origins) {
      try {
        const res = await api.post<{ asset: Asset; project: Project }>(`/api/projects/${id}/assets/link`, { from });
        pr.update((p) => ({ ...p, assets: res.project.assets }), { record: false });
        place(res.asset);
      } catch (err) {
        toastError(err);
      }
    }
  };

  const upload = async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const res = await fetch(`/api/projects/${id}/assets/upload`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-kesit-name': encodeURIComponent(file.name) }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Yüklenemedi');
        const asset = data.asset as Asset;
        pr.update((p) => ({ ...p, assets: [...p.assets, asset] }), { record: false });
        place(asset);
      } catch (err) {
        toastError(err);
      }
    }
  };

  const removeAsset = async (asset: Asset) => {
    try {
      const res = await api.del<{ project: Project }>(`/api/projects/${id}/assets/${asset.id}`);
      pr.replace({ ...pr.current()!, assets: res.project.assets, clips: pr.current()!.clips.filter((c) => c.assetId !== asset.id) });
      if (selected?.assetId === asset.id) setSelectedId(null);
    } catch (err) {
      toastError(err);
    }
  };

  const addText = (preset: TextPreset) =>
    pr.update((p) => {
      const r = addTextClip(p, timeRef.current, preset, accent);
      setSelectedId(r.clip.id);
      return r.project;
    });

  const layout = async (key: LayoutPreset) => {
    const cur = pr.current();
    if (!cur) return;
    const target = (selected?.kind === 'video' ? selected : null) ?? cur.clips.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start)[0];
    if (!target) return toast('Önce bir video parçası ekle', 'error');
    const asset = cur.assets.find((a) => a.id === target.assetId);
    if (!asset) return;
    const def = LAYOUTS.find((l) => l.key === key)!;
    try {
      let rect: Rect | null = null;
      if (def.needsCam) {
        toast('Yüz kamerası aranıyor…', 'info');
        rect = (await api.post<{ rect: Rect | null }>(`/api/projects/${id}/assets/${asset.id}/facecam`)).rect;
      }
      pr.update((p) => applyLayout(p, target.id, key, rect));
      setSelectedId(target.id);
      if (def.needsCam) toast(rect ? 'Kamera bulundu, düzen uygulandı' : 'Kamera bulunamadı; varsayılan köşe kullanıldı — kaynak bölgeyi elle ayarla', rect ? 'ok' : 'info');
    } catch (err) {
      toastError(err);
    }
  };

  /* ── Dışa aktarma ────────────────────────────────────────────────────── */
  const exportProject = async () => {
    const cur = pr.current();
    if (!cur) return;
    if (!cur.clips.some((c) => c.kind !== 'audio')) return toast('Zaman çizelgesinde görüntü yok', 'error');
    setExporting(true);
    try {
      let next = cur;
      for (const clip of cur.clips.filter((c) => c.kind === 'text' && c.text)) {
        const key = textRenderKey(clip.text!, clip.frame, cur.format);
        let asset = next.assets.find((a) => a.name === key);
        if (!asset) {
          const blob = await renderTextToBlob(clip.text!, clip.frame, cur.format);
          const res = await fetch(`/api/projects/${id}/assets/upload`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/png', 'x-kesit-name': encodeURIComponent(`${key}.png`), 'x-kesit-kind': 'render' }, body: blob });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Yazı hazırlanamadı');
          asset = { ...(data.asset as Asset), name: key };
          next = { ...next, assets: [...next.assets, asset] };
        }
        next = updateClip(next, clip.id, { renderAssetId: asset.id });
      }
      pr.replace(next, { record: false });
      await pr.flush();
      const res = await api.post<{ render: RenderStatus }>(`/api/projects/${id}/render`, { project: next });
      pr.setRender(res.render);
      toast('Dışa aktarma başladı', 'ok');
    } catch (err) {
      setExporting(false);
      toastError(err);
    }
  };

  const cancelExport = () => api.post(`/api/projects/${id}/render/cancel`).then(() => setExporting(false), toastError);

  if (pr.error && !project) {
    return (
      <div className="panel">
        <Empty
          icon="scissors"
          title="Proje açılamadı"
          action={
            <button type="button" className="btn btn-secondary" onClick={() => navigate(sectionPath('editor'))}>
              Projelere dön
            </button>
          }
        >
          {pr.error}
        </Empty>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="center-pad">
        <Spinner size={24} />
      </div>
    );
  }

  const rendering = pr.render && !pr.render.jobId && !pr.render.error;
  const subtitleStyle = project.subtitles.style ?? studio.data?.brand.subtitleStyle ?? 'classic';
  const onProject = (changes: Partial<Project>) =>
    pr.update((p) => {
      const next = { ...p, ...changes };
      if (changes.format && changes.format !== p.format) {
        next.clips = p.clips.map((c) => {
          const a = c.assetId ? p.assets.find((x) => x.id === c.assetId) : null;
          return a && c.kind !== 'audio' ? { ...c, frame: fitFrame(a.width || 16, a.height || 9, c.crop, changes.format!), renderAssetId: null } : c;
        });
      }
      return next;
    });

  const inClip = !!selected && time > selected.start && time < clipEnd(selected);
  const tools: TimelineTool[] = [
    { key: 'split', icon: 'split', label: 'Böl', title: 'Oynatma çizgisinden böl (S)', run: split },
    { key: 'q', label: 'Başını at', title: 'Seçili parçanın çizginin solunda kalan kısmını at (Q)', disabled: !inClip, run: () => void trimSide('left') },
    { key: 'w', label: 'Sonunu at', title: 'Seçili parçanın çizginin sağında kalan kısmını at (W)', disabled: !inClip, run: () => void trimSide('right') },
    { key: 'dup', label: 'Çoğalt', title: 'Seçili parçayı çoğalt (⌘D)', disabled: !selected, run: () => void duplicate() },
    { key: 'mute', icon: selected?.muted ? 'mute' : 'volume', label: selected?.muted ? 'Sesi aç' : 'Sessiz', title: 'Seçili parçayı sessize al (M)', disabled: !selected || selected.kind === 'text' || selected.kind === 'image', run: () => void toggleMute() },
    { key: 'del', icon: 'trash', label: 'Sil', title: 'Seçili parçayı kaldır (Sil)', disabled: !selected, danger: true, run: () => remove(false) },
    { key: 'layer', icon: 'layers', label: 'Katman', title: 'Yeni görüntü katmanı', run: () => pr.update((p) => addTrack(p, 'video')) },
    { key: 'magnetic', label: '', title: '', run: () => setMagnetic((m) => !m) },
  ];

  const menuFor = (c: Clip): MenuItem[] => {
    const inside = time > c.start && time < clipEnd(c);
    const main = mainTrackId(project);
    return [
      { label: 'Böl', shortcut: 'S', disabled: !inside, run: () => pr.update((p) => splitAt(p, timeRef.current, [c.id]).project) },
      { label: 'Başını at (çizginin solu)', shortcut: 'Q', disabled: !inside, run: () => pr.update((p) => trimToPlayhead(p, c.id, timeRef.current, 'left', magnetic)) },
      { label: 'Sonunu at (çizginin sağı)', shortcut: 'W', disabled: !inside, run: () => pr.update((p) => trimToPlayhead(p, c.id, timeRef.current, 'right', magnetic)) },
      { label: 'Çoğalt', shortcut: '⌘D', run: duplicate },
      { label: 'Kopyala', shortcut: '⌘C', run: copy },
      { label: c.muted ? 'Sesi aç' : 'Sessize al', shortcut: 'M', disabled: c.kind === 'text' || c.kind === 'image', run: () => pr.update((p) => updateClip(p, c.id, { muted: !c.muted })) },
      { label: 'Bir üst katmana taşı', disabled: c.kind === 'audio', run: () => pr.update((p) => moveToTrack(p, c.id, 'up')) },
      { label: 'Bir alt katmana taşı', disabled: c.kind === 'audio' || c.trackId === main, run: () => pr.update((p) => moveToTrack(p, c.id, 'down')) },
      { label: 'Bu yolda boşlukları kapat', run: () => pr.update((p) => closeGaps(p, c.trackId)) },
      { label: 'Yolu kaldır (içindekilerle)', disabled: project.tracks.length <= 1, danger: true, run: () => pr.update((p) => removeTrack(p, c.trackId)) },
      { label: 'Sil', shortcut: 'Sil', danger: true, run: () => (pr.update((p) => removeClips(p, [c.id], magnetic)), setSelectedId(null)) },
      { label: 'Sil ve sonrakileri geri çek', shortcut: '⇧Sil', danger: true, run: () => (pr.update((p) => rippleRemove(p, c.id)), setSelectedId(null)) },
    ];
  };

  return (
    <div className="ed">
      <header className="ed-top">
        <button type="button" className="btn btn-quiet btn-small" onClick={() => navigate(sectionPath('editor'))}>
          ← Projeler
        </button>
        <input className="ed-title" value={project.title} maxLength={120} onChange={(e) => onProject({ title: e.target.value })} aria-label="Proje adı" />
        <span className="ed-save muted">{pr.saving ? 'Kaydediliyor…' : pr.dirty ? 'Değişti' : 'Kaydedildi'}</span>
        <div className="ed-top-side">
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setShowKeys(true)} title="Klavye kısayolları (?)">
            <Icon name="help" size={14} /> Kısayollar
          </button>
          <span className="ed-format muted">{project.format === 'vertical' ? '9:16 · 1080×1920' : '16:9 · 1920×1080'}</span>
          {rendering ? (
            <div className="ed-render">
              <Progress value={pr.render!.percent} label="Dışa aktarılıyor" />
              <span>%{pr.render!.percent}</span>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => void cancelExport()}>
                İptal
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-accent" disabled={exporting || !total} onClick={() => void exportProject()}>
              {exporting ? <Spinner size={14} /> : <Icon name="export" size={16} />} Dışa aktar
            </button>
          )}
        </div>
      </header>

      <AnimatePresence>
        {coach && (
          <motion.div className="coach" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <ol>
              <li>
                <b>1 · Ekle</b> Soldaki <em>Medya</em> sekmesinden Galeri'den ya da bilgisayardan video al; dosyanın üstüne gelip <em>Ekle</em>'ye bas.
              </li>
              <li>
                <b>2 · Kes</b> Alttaki çizelgede oynatma çizgisini istediğin yere getir, <em>Böl</em>'e bas (S); istemediğin parçayı seçip <em>Sil</em>.
              </li>
              <li>
                <b>3 · Süsle ve çıkar</b> <em>Yazı</em>, <em>Düzen</em> ve <em>Marka</em> sekmeleriyle ekle; sağ panelden renk ve ses; en sonda <em>Dışa aktar</em>.
              </li>
            </ol>
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => {
                setCoach(false);
                writeFlag(COACH_KEY, true);
              }}
            >
              Anladım
            </button>
          </motion.div>
        )}
        {hint && !coach && (
          <motion.p key="hint" className="ed-hintbar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Icon name="bolt" size={14} /> {hint}
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setHint(null)}>
              Tamam
            </button>
          </motion.p>
        )}
      </AnimatePresence>

      <div className="ed-body">
        <MediaPanel project={project} tab={tab} onTab={setTab} hasSelection={selected?.kind === 'video'} onLink={link} onUpload={upload} onPlace={(a) => place(a)} onRemoveAsset={(a) => void removeAsset(a)} onAddText={addText} onLayout={(l) => void layout(l)} />

        <section className="ed-center" aria-label="Önizleme">
          <Stage
            project={project}
            time={time}
            playing={playing}
            selectedId={selectedId}
            subtitleStyle={subtitleStyle}
            safeZone={safeZone}
            onSelect={setSelectedId}
            onFrame={(cid, frame: Rect) => pr.update((p) => updateClip(p, cid, { frame }), { record: false })}
            onBegin={pr.begin}
            onEnd={pr.end}
          />
          <div className="ed-transport">
            <button type="button" className="btn btn-quiet btn-icon" onClick={() => seek(0)} aria-label="Başa dön" title="Başa dön (Home)">
              <Icon name="undo" size={14} />
            </button>
            <button type="button" className="btn btn-primary btn-icon" onClick={togglePlay} aria-label={playing ? 'Duraklat' : 'Oynat'} title="Oynat / duraklat (Boşluk)">
              <Icon name={playing ? 'pause' : 'play'} size={16} />
            </button>
            <span className="timecode">
              {stamp(time)} <span className="muted">/ {duration(total)}</span>
            </span>
            <span className="ed-tools">
              <button type="button" className={safeZone ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'} onClick={() => setSafeZone((v) => !v)} title={project.format === 'vertical' ? 'TikTok/Reels/Shorts arayüzünün kapattığı bölgeleri göster' : 'Kenar payını göster'}>
                <Icon name="phone" size={14} /> Güvenli alan
              </button>
            </span>
          </div>
        </section>

        <Inspector project={project} clip={selected} studio={studio.data} onChange={(fn, record = true) => pr.update(fn, { record })} onBegin={pr.begin} onEnd={pr.end} onProject={onProject} onSeek={(t) => (setPlaying(false), seek(t))} />
      </div>

      <Tracks
        project={project}
        time={time}
        selectedId={selectedId}
        magnetic={magnetic}
        tools={tools}
        leading={
          <>
            <button type="button" className="tl-tool" onClick={pr.undo} disabled={!pr.canUndo} title="Geri al (⌘Z)">
              <Icon name="undo" size={14} />
            </button>
            <button type="button" className="tl-tool" onClick={pr.redo} disabled={!pr.canRedo} title="Yinele (⇧⌘Z)">
              <Icon name="redo" size={14} />
            </button>
          </>
        }
        onSelect={setSelectedId}
        onSeek={(t) => {
          setPlaying(false);
          seek(t);
        }}
        onChange={(fn, record = true) => pr.update(fn, { record })}
        onBegin={pr.begin}
        onEnd={pr.end}
        onDropAt={(assetId, at, trackId) => {
          const asset = project.assets.find((a) => a.id === assetId);
          if (asset) place(asset, at, trackId ?? undefined);
        }}
        onMenu={menuFor}
      />

      <AnimatePresence>
        {pr.error && project && (
          <motion.p className="notice-box ed-error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            Kaydedilemedi: {pr.error}
          </motion.p>
        )}
      </AnimatePresence>
      <p className="timeline-hint ed-hint">
        <kbd>Boşluk</kbd> oynat · <kbd>S</kbd> böl · <kbd>Q</kbd>/<kbd>W</kbd> başını/sonunu at · <kbd>Sil</kbd> kaldır · <kbd>⌘Z</kbd> geri al · <kbd>?</kbd> tüm kısayollar · çıktı {FORMAT_SIZE[project.format].w}×{FORMAT_SIZE[project.format].h}
      </p>

      <Modal open={showKeys} onClose={() => setShowKeys(false)} title="Klavye kısayolları">
        <ul className="keys">
          {SHORTCUTS.map(([k, v]) => (
            <li key={k}>
              <kbd>{k}</kbd>
              <span>{v}</span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
