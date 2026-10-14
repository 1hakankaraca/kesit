import { api } from './api.ts';
import { navigate, sectionPath } from './router.ts';
import { toast, toastError } from './toast.ts';

export type EditorSource = { type: 'job' | 'recording' | 'vod' | 'harvest'; id: number };

/**
 * Galeri'deki bir kaynaktan yeni editör projesi açar. `ranges` verilirse
 * yalnız o aralıklar (ör. işaretlenen kesitler) zaman çizelgesine dizilir.
 */
export async function openInEditor(from: EditorSource, { title, ranges }: { title?: string; ranges?: { start: number; end: number }[] } = {}) {
  try {
    const res = await api.post<{ project: { id: number } }>('/api/projects', { from, title, ranges });
    toast('Editörde açıldı', 'ok');
    navigate(sectionPath('editor', res.project.id));
    return res.project.id;
  } catch (err) {
    toastError(err);
    return null;
  }
}
