import { api } from './api.ts';
import { toast, toastError } from './toast.ts';

/** Videonun o anki saniyesinden ekran görüntüsü alır; çıktı klasörüne kaydedilir. */
export async function takeSnapshot(source: 'vod' | 'recording' | 'clip', id: number, t: number) {
  try {
    const res = await api.post<{ name: string }>('/api/snapshot', { source, id, t });
    toast(`Ekran görüntüsü kaydedildi: ${res.name}`, 'ok', { label: 'Klasörü aç', run: () => void api.post('/api/snapshot/reveal').catch(toastError) }, 6000);
  } catch (err) {
    toastError(err);
  }
}
