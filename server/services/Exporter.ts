import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Store } from '../db/Store.ts';
import { badRequest } from '../http.ts';

const KEY_DIR = 'export.dir';
const KEY_ENABLED = 'export.enabled';
const SUBDIRS = { vertical: 'Dikey', horizontal: 'Yatay', recording: 'Kayıtlar' } as const;
export type ExportKind = keyof typeof SUBDIRS;

export const DEFAULT_EXPORT_DIR = path.join(os.homedir(), 'Downloads', 'Kesit');

function safeName(title: string) {
  return title.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Kesit';
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/**
 * Hazır olan klip ve kayıt çıktılarını bilgisayarın İndirilenler klasörüne
 * (varsayılan ~/Downloads/Kesit) kopyalar: Dikey/, Yatay/, Kayıtlar/.
 * Klasör Ayarlar'dan değiştirilebilir ya da dışa aktarma kapatılabilir.
 * Kesit'in kendi kopyası data/ altında kalır; buradaki dosyalar kullanıcının.
 */
export class Exporter {
  constructor(private store: Store) {}

  get enabled() {
    return this.store.getAppSetting(KEY_ENABLED) !== '0';
  }

  get dir() {
    return this.store.getAppSetting(KEY_DIR) || DEFAULT_EXPORT_DIR;
  }

  settings() {
    return { enabled: this.enabled, dir: this.dir, defaultDir: DEFAULT_EXPORT_DIR, isDefault: this.dir === DEFAULT_EXPORT_DIR };
  }

  update({ enabled, dir }: { enabled?: unknown; dir?: unknown }) {
    if (typeof enabled === 'boolean') this.store.setAppSetting(KEY_ENABLED, enabled ? '1' : '0');
    if (dir !== undefined) {
      if (dir === null || dir === '') {
        this.store.setAppSetting(KEY_DIR, null);
      } else {
        const resolved = path.resolve(String(dir).replace(/^~(?=$|\/)/, os.homedir()));
        try {
          fs.mkdirSync(resolved, { recursive: true });
          fs.accessSync(resolved, fs.constants.W_OK);
        } catch {
          throw badRequest('Bu klasöre yazılamıyor — başka bir klasör seç');
        }
        this.store.setAppSetting(KEY_DIR, resolved);
      }
    }
    return this.settings();
  }

  /** Dosyayı arka planda kopyalar; hedef yolu döner (kopya bitmeden de). */
  copy(source: string, kind: ExportKind, title: string, id: number): string | null {
    if (!this.enabled || !source || !fs.existsSync(source)) return null;
    const folder = path.join(this.dir, SUBDIRS[kind]);
    const target = path.join(folder, `${stamp()} ${safeName(title)} #${id}${path.extname(source) || '.mp4'}`);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (err) {
      console.warn('[Dışa aktarma] Klasör oluşturulamadı:', (err as Error).message);
      return null;
    }
    fs.copyFile(source, target, (err) => {
      if (err) console.warn(`[Dışa aktarma] ${path.basename(target)} kopyalanamadı:`, err.message);
    });
    return target;
  }

  get snapshotDir() {
    return path.join(this.dir, 'Ekran görüntüleri');
  }

  /** Ekran görüntüsü için hedef yol: "<tarih> <başlık> 01.23.jpg". Dışa aktarma kapalı olsa da kaydedilir. */
  snapshotPath(title: string, sec: number) {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const at = `${String(m).padStart(2, '0')}.${String(s).padStart(2, '0')}`;
    return path.join(this.snapshotDir, `${stamp()} ${safeName(title)} ${at}.jpg`);
  }

  /** Klasörü Finder/Explorer'da açar (yalnız bu bilgisayarda anlamlı). */
  reveal(target = this.dir) {
    fs.mkdirSync(target, { recursive: true });
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [target], () => {});
  }
}
