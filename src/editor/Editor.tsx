import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FORMAT_SIZE, fitFrame, type Asset, type Project, type Rect } from '../../shared/project.ts';
import { Icon } from '../components/Icon.tsx';
import { Empty, Progress, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { duration, relative, stamp } from '../lib/format.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { ProjectSummary, RenderStatus, Studio } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { Inspector } from './Inspector.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { Stage } from './Stage.tsx';
import { Tracks } from './Tracks.tsx';
import { addAssetClip, addTextClip, addTrack, clipEnd, closeGaps, duplicateClip, removeClips, removeTrack, rippleRemove, splitAt, updateClip } from './model.ts';
import { renderTextToBlob, textRenderKey } from './textRender.ts';
import { useProject } from './useProject.ts';

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
            <button type="button" className="btn btn-accent" disabled={creating} onClick={() => void create('horizontal')}>
              {creating ? <Spinner /> : <Icon name="plus" size={16} />} Yeni yatay proje
            </button>
            <button type="button" className="btn btn-secondary" disabled={creating} onClick={() => void create('vertical')}>
              <Icon name="vertical" size={16} /> Yeni dikey proje
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

function Workspace({ id }: { id: number }) {
  const pr = useProject(id);
  const { project } = pr;
  const studio = useResource(() => api.get<Studio>('/api/studio'));
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const raf = useRef<number | null>(null);
  const lastTick = useRef(0);
  const timeRef = useRef(0);
  timeRef.current = time;

  const total = useMemo(() => (project ? project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) : 0), [project]);
  const selected = project?.clips.find((c) => c.id === selectedId) ?? null;

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

  /* ── Klavye ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) pr.redo();
        else pr.undo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (selectedId) {
          pr.update((p) => {
            const r = duplicateClip(p, selectedId);
            if (r.clip) setSelectedId(r.clip.id);
            return r.project;
          });
        }
      } else if (e.key === 's' || e.key === 'S') {
        split();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          e.preventDefault();
          if (e.shiftKey) pr.update((p) => rippleRemove(p, selectedId));
          else pr.update((p) => removeClips(p, [selectedId]));
          setSelectedId(null);
        }
      } else if (e.key === 'ArrowLeft') seek(timeRef.current - (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'ArrowRight') seek(timeRef.current + (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(total);
      else if (e.key === 'Escape') setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const split = () => {
    pr.update((p) => {
      const r = splitAt(p, timeRef.current, selectedId ? [selectedId] : undefined);
      if (!r.created.length) toast('Oynatma çizgisi bir parçanın içinde değil', 'info');
      return r.project;
    });
  };

  /* ── Varlık ekleme ───────────────────────────────────────────────────── */
  const place = (asset: Asset, at = timeRef.current, trackId?: string) => {
    pr.update((p) => {
      const r = addAssetClip(p, asset, at, trackId);
      setSelectedId(r.clip.id);
      return r.project;
    });
  };

  const link = async (origins: { type: string; id?: number }[]) => {
    for (const from of origins) {
      try {
        const res = await api.post<{ asset: Asset; project: Project }>(`/api/projects/${id}/assets/link`, { from });
        // Varlık listesi sunucudan gelir; parçayı burada ekleriz (geri alınabilir).
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

  /* ── Dışa aktarma ────────────────────────────────────────────────────── */
  const exportProject = async () => {
    const cur = pr.current();
    if (!cur) return;
    if (!cur.clips.some((c) => c.kind !== 'audio')) return toast('Zaman çizelgesinde görüntü yok', 'error');
    setExporting(true);
    try {
      let next = cur;
      // Yazı parçaları çıktı çözünürlüğünde görsele çevrilir (önizlemeyle birebir).
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
      // Biçim değişince görsel parçalar yeni kareye oran koruyarak yeniden sığdırılır.
      if (changes.format && changes.format !== p.format) {
        next.clips = p.clips.map((c) => {
          const a = c.assetId ? p.assets.find((x) => x.id === c.assetId) : null;
          return a && c.kind !== 'audio' ? { ...c, frame: fitFrame(a.width || 16, a.height || 9, c.crop, changes.format!), renderAssetId: null } : c;
        });
      }
      return next;
    });

  return (
    <div className="ed">
      <header className="ed-top">
        <button type="button" className="btn btn-quiet btn-small" onClick={() => navigate(sectionPath('editor'))}>
          ← Projeler
        </button>
        <input className="ed-title" value={project.title} maxLength={120} onChange={(e) => onProject({ title: e.target.value })} aria-label="Proje adı" />
        <span className="ed-save muted">{pr.saving ? 'Kaydediliyor…' : pr.dirty ? 'Değişti' : 'Kaydedildi'}</span>
        <div className="ed-top-side">
          <button type="button" className="btn btn-quiet btn-icon" onClick={pr.undo} disabled={!pr.canUndo} title="Geri al (⌘Z)" aria-label="Geri al">
            <Icon name="undo" size={16} />
          </button>
          <button type="button" className="btn btn-quiet btn-icon" onClick={pr.redo} disabled={!pr.canRedo} title="Yinele (⇧⌘Z)" aria-label="Yinele">
            <Icon name="redo" size={16} />
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

      <div className="ed-body">
        <MediaPanel
          project={project}
          onLink={link}
          onUpload={upload}
          onPlace={(a) => place(a)}
          onRemoveAsset={(a) => void removeAsset(a)}
          onAddText={() =>
            pr.update((p) => {
              const r = addTextClip(p, timeRef.current);
              setSelectedId(r.clip.id);
              return r.project;
            })
          }
        />

        <section className="ed-center" aria-label="Önizleme">
          <Stage
            project={project}
            time={time}
            playing={playing}
            selectedId={selectedId}
            subtitleStyle={subtitleStyle}
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
              <button type="button" className="btn btn-secondary btn-small" onClick={split} title="Oynatma çizgisinden böl (S)">
                <Icon name="split" size={14} /> Böl
              </button>
              <button type="button" className="btn btn-secondary btn-small" disabled={!selected} onClick={() => selected && (pr.update((p) => removeClips(p, [selected.id])), setSelectedId(null))} title="Seçili parçayı sil (Sil)">
                <Icon name="trash" size={14} /> Sil
              </button>
              <button type="button" className="btn btn-secondary btn-small" disabled={!selected} onClick={() => selected && (pr.update((p) => rippleRemove(p, selected.id)), setSelectedId(null))} title="Sil ve boşluğu kapat (⇧Sil)">
                Sil + kaydır
              </button>
              <button type="button" className="btn btn-secondary btn-small" disabled={!selected} onClick={() => selected && pr.update((p) => closeGaps(p, selected.trackId))} title="Bu yoldaki boşlukları kapat">
                Boşlukları kapat
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => pr.update((p) => addTrack(p, 'video'))} title="Yeni görüntü katmanı">
                <Icon name="layers" size={14} /> Katman
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => pr.update((p) => addTrack(p, 'audio'))} title="Yeni ses yolu">
                <Icon name="music" size={14} /> Ses yolu
              </button>
              {selected && project.tracks.length > 1 && (
                <button type="button" className="btn btn-quiet btn-small" onClick={() => pr.update((p) => removeTrack(p, selected.trackId))} title="Seçili parçanın yolunu (içindekilerle) kaldır">
                  Yolu kaldır
                </button>
              )}
            </span>
          </div>
        </section>

        <Inspector project={project} clip={selected} studio={studio.data} onChange={(fn, record = true) => pr.update(fn, { record })} onBegin={pr.begin} onEnd={pr.end} onProject={onProject} />
      </div>

      <Tracks
        project={project}
        time={time}
        selectedId={selectedId}
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
      />

      <AnimatePresence>
        {pr.error && project && (
          <motion.p className="notice-box ed-error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            Kaydedilemedi: {pr.error}
          </motion.p>
        )}
      </AnimatePresence>
      <p className="timeline-hint ed-hint">
        <kbd>Boşluk</kbd> oynat · <kbd>S</kbd> böl · <kbd>Sil</kbd> parçayı kaldır · <kbd>⇧Sil</kbd> kaldır ve kaydır · <kbd>⌘Z</kbd> geri al · <kbd>⌘D</kbd> çoğalt · <kbd>←</kbd>
        <kbd>→</kbd> kare kare · <kbd>⌘</kbd>+tekerlek yakınlaştır · önizlemede köşeden oranlı, <kbd>Alt</kbd> ile serbest boyutla · çıktı {FORMAT_SIZE[project.format].w}×{FORMAT_SIZE[project.format].h}
      </p>
    </div>
  );
}
