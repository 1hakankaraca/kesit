import type { Server as IOServer } from 'socket.io';
import type { Store } from '../db/Store.ts';
import {
  ClipCompressor,
  ClipEditorManager,
  LiveClipWatcher,
  RecordingEditor,
  RecordingFinalizer,
  RecordingPublisher,
  StreamRecorder,
} from '../engine.ts';

/** Bir kullanıcının motor örnekleri. Hepsi aynı socket odasına (user:<id>) yayın yapar. */
export interface Workspace {
  userId: number;
  clipEditor: any;
  clipWatcher: any;
  recorder: any;
  finalizer: any;
  publisher: any;
  editor: any;
  compressor: any;
}

/**
 * Kullanıcı başına çalışma alanlarını ilk ihtiyaçta kurar ve süreç boyunca
 * tutar (nöbetçi kullanıcı tarayıcıyı kapatsa da kayıt sürebilsin diye).
 * Kurulumda yeniden başlatmadan yarım kalan işler toparlanır.
 */
export class Workspaces {
  private open = new Map<number, Promise<Workspace>>();

  constructor(
    private store: Store,
    private io: IOServer,
    private vodScanner: any,
  ) {}

  get(userId: number): Promise<Workspace> {
    let ws = this.open.get(userId);
    if (!ws) {
      ws = this.build(userId);
      this.open.set(userId, ws);
      ws.catch(() => this.open.delete(userId));
    }
    return ws;
  }

  /** Kurulmuşsa döner; kurmaz (salt okuma uçları için). */
  peek(userId: number): Promise<Workspace> | null {
    return this.open.get(userId) ?? null;
  }

  async destroy(userId: number) {
    const ws = await this.open.get(userId);
    this.open.delete(userId);
    if (!ws) return;
    ws.clipWatcher.destroy?.();
    ws.recorder.destroy?.();
    ws.finalizer.destroy?.();
    ws.compressor.destroy?.();
    ws.clipEditor.destroy?.();
  }

  async destroyAll() {
    await Promise.all([...this.open.keys()].map((id) => this.destroy(id)));
  }

  private async build(userId: number): Promise<Workspace> {
    const user = this.store.getUser(userId);
    const deps = { db: this.store, io: this.io, userId };
    const clipEditor = new ClipEditorManager({ ...deps, channelSlug: user?.channel_slug || '' });
    const finalizer = new RecordingFinalizer(deps);
    const ws: Workspace = {
      userId,
      clipEditor,
      clipWatcher: new LiveClipWatcher({ ...deps, clipEditor }),
      recorder: new StreamRecorder({ ...deps, finalizer }),
      finalizer,
      publisher: new RecordingPublisher(deps),
      editor: new RecordingEditor(deps),
      compressor: new ClipCompressor({ io: this.io, userId }),
    };

    const recover = (label: string, task: () => Promise<unknown>) =>
      task().catch((err: Error) => console.error(`[Çalışma alanı ${userId}] ${label} toparlanamadı:`, err.message));
    await recover('klip işleri', () => clipEditor.recoverPendingJobs());
    await recover('VOD taramaları', () => this.vodScanner.reconcile(userId));
    await recover('kayıtlar', () => ws.recorder.recoverOrphans());
    await recover('kayıt çıktıları', () => finalizer.recoverOrphans());
    await recover('YouTube taslakları', () => ws.publisher.recoverOrphans());
    await recover('kayıt düzenlemeleri', () => ws.editor.recoverOrphans());
    return ws;
  }
}
