import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Icon } from '../components/Icon.tsx';
import type { MenuItem } from '../components/ContextMenu.tsx';
import { api } from '../lib/api.ts';
import { dismiss, toast, toastError } from '../lib/toast.ts';
import type { GalleryFolder, GalleryLayout } from '../lib/types.ts';

/** Sürüklenen galeri öğelerinin veri türü (yalnız Kesit içi). */
export const DRAG_TYPE = 'application/x-kesit-gallery';

export interface DragPayload {
  keys: string[];
  folderId?: number;
}

export function setDragPayload(e: DragEvent, payload: DragPayload, label: string) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', label);
  // Birden çok öğe sürüklenirken imlecin yanında sayı görünsün.
  if (payload.keys.length > 1) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = label;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 14);
    setTimeout(() => ghost.remove(), 0);
  }
}

export function readDragPayload(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

export const isGalleryDrag = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);

const CWD_KEY = 'kesit.galeri.klasor';

/** Açık klasör: izleme sayfasından dönünce aynı klasörde kalınsın (sekme ömrünce). */
export function loadCwd(): number | null {
  try {
    const v = sessionStorage.getItem(CWD_KEY);
    return v ? Number(v) || null : null;
  } catch {
    return null;
  }
}

export function saveCwd(id: number | null) {
  try {
    if (id == null) sessionStorage.removeItem(CWD_KEY);
    else sessionStorage.setItem(CWD_KEY, String(id));
  } catch {
    /* gizli pencere vb. — önemli değil */
  }
}

/** Kökten klasöre giden yol. */
export function pathTo(folders: GalleryFolder[], id: number | null): GalleryFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: GalleryFolder[] = [];
  let cur = id != null ? byId.get(id) : undefined;
  let guard = 0;
  while (cur && guard++ < 20) {
    out.unshift(cur);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Bir klasör ve tüm alt klasörlerinin kimlikleri. */
export function subtree(folders: GalleryFolder[], id: number): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId != null && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** "Klasöre taşı" alt menüsü: ağaç sırasıyla, girintili. */
export function moveTargets(folders: GalleryFolder[], { exclude = new Set<number>(), current, onPick, onNew }: { exclude?: Set<number>; current: number | null; onPick: (id: number | null) => void; onNew?: () => void }): MenuItem[] {
  const items: MenuItem[] = [{ label: 'Galeri (en üst)', icon: 'library', disabled: current === null, onSelect: () => onPick(null) }];
  const walk = (parent: number | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, 'tr'))) {
      if (exclude.has(f.id)) continue;
      items.push({ label: `${'  '.repeat(depth)}${f.name}`, icon: 'folder', disabled: f.id === current, onSelect: () => onPick(f.id) });
      if (depth < 6) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  if (onNew) items.push({ separator: true }, { label: 'Yeni klasöre…', icon: 'plus', onSelect: onNew });
  return items;
}

/** Klasör işlemleri — iyimser güncelleme, hata olursa sunucudan yeniden okunur. */
export function folderActions(layout: { data: GalleryLayout | null; setData: (fn: (d: GalleryLayout | null) => GalleryLayout | null) => void; reload: () => Promise<void> }) {
  const resync = () => void layout.reload();
  return {
    async create(parentId: number | null, name = 'Yeni klasör') {
      try {
        const { folder } = await api.post<{ folder: GalleryFolder }>('/api/gallery/folders', { name, parentId });
        layout.setData((d) => d && { ...d, folders: [...d.folders, folder] });
        return folder;
      } catch (err) {
        toastError(err);
        return null;
      }
    },
    async rename(id: number, name: string) {
      const clean = name.trim();
      if (!clean) return;
      layout.setData((d) => d && { ...d, folders: d.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) });
      try {
        const { folder } = await api.patch<{ folder: GalleryFolder }>(`/api/gallery/folders/${id}`, { name: clean });
        layout.setData((d) => d && { ...d, folders: d.folders.map((f) => (f.id === id ? folder : f)) });
      } catch (err) {
        toastError(err);
        resync();
      }
    },
    async moveFolder(id: number, parentId: number | null) {
      layout.setData((d) => d && { ...d, folders: d.folders.map((f) => (f.id === id ? { ...f, parentId } : f)) });
      try {
        const { folder } = await api.patch<{ folder: GalleryFolder }>(`/api/gallery/folders/${id}`, { parentId });
        layout.setData((d) => d && { ...d, folders: d.folders.map((f) => (f.id === id ? folder : f)) });
        toast(`"${folder.name}" taşındı`, 'ok');
      } catch (err) {
        toastError(err);
        resync();
      }
    },
    async moveItems(keys: string[], folderId: number | null, folderName: string) {
      if (!keys.length) return;
      const before = layout.data?.placements ?? {};
      layout.setData((d) => {
        if (!d) return d;
        const placements = { ...d.placements };
        for (const k of keys) {
          if (folderId == null) delete placements[k];
          else placements[k] = folderId;
        }
        return { ...d, placements };
      });
      try {
        await api.post('/api/gallery/move', { keys, folderId });
        const toastId = toast(keys.length === 1 ? `"${folderName}" klasörüne taşındı` : `${keys.length} öğe "${folderName}" klasörüne taşındı`, 'ok', {
          label: 'Geri al',
          run: () => {
            dismiss(toastId);
            // Her öğeyi eski yerine geri koy (klasörlere göre gruplayarak).
            const groups = new Map<number | null, string[]>();
            for (const k of keys) {
              const prev = before[k] ?? null;
              groups.set(prev, [...(groups.get(prev) ?? []), k]);
            }
            layout.setData((d) => {
              if (!d) return d;
              const placements = { ...d.placements };
              for (const k of keys) {
                if (before[k] == null) delete placements[k];
                else placements[k] = before[k];
              }
              return { ...d, placements };
            });
            void Promise.all([...groups].map(([fid, ks]) => api.post('/api/gallery/move', { keys: ks, folderId: fid }))).catch((err) => {
              toastError(err);
              resync();
            });
          },
        });
      } catch (err) {
        toastError(err);
        resync();
      }
    },
  };
}

/** Yerinde yeniden adlandırma kutusu: Enter kaydeder, Esc vazgeçer, dışarı tıklamak kaydeder. */
export function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="input gfolder-rename"
      value={text}
      maxLength={60}
      aria-label="Klasör adı"
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(text);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(text)}
    />
  );
}

/** Sürükle-bırak hedefi: üstüne gelince vurgulanır, bırakınca `onDrop` çağrılır. */
export function DropTarget({ onDrop, className, children, title }: { onDrop: (p: DragPayload) => void; className?: string; children: ReactNode; title?: string }) {
  const [over, setOver] = useState(0);
  return (
    <span
      className={[className, over > 0 && 'drop-over'].filter(Boolean).join(' ')}
      title={title}
      onDragEnter={(e) => {
        if (!isGalleryDrag(e)) return;
        e.preventDefault();
        setOver((n) => n + 1);
      }}
      onDragOver={(e) => {
        if (!isGalleryDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={() => setOver((n) => Math.max(0, n - 1))}
      onDrop={(e) => {
        setOver(0);
        const p = readDragPayload(e);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(p);
      }}
    >
      {children}
    </span>
  );
}

export function FolderGlyph({ color }: { color?: string | null }) {
  return (
    <span className="gfolder-glyph" style={color ? ({ '--folder': color } as React.CSSProperties) : undefined} aria-hidden="true">
      <Icon name="folder" size={30} />
    </span>
  );
}
