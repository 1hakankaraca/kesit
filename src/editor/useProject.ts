import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/project.ts';
import { api } from '../lib/api.ts';
import type { RenderStatus } from '../lib/types.ts';

const HISTORY_LIMIT = 80;
const SAVE_DELAY = 1200;

export type Updater = (p: Project) => Project;

/**
 * Projeyi yükler, geri al/yinele yığınını tutar ve değişiklikleri
 * kendiliğinden kaydeder. Sürükleme gibi sürekli değişikliklerde
 * `begin()` ile anlık görüntü alınır, `end()` ile tek bir geri alma adımı
 * olarak yığına girer.
 */
export function useProject(id: number) {
  const [project, setState] = useState<Project | null>(null);
  const [render, setRender] = useState<RenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const snapshot = useRef<Project | null>(null);
  const latest = useRef<Project | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ project: Project; render: RenderStatus | null }>(`/api/projects/${id}`);
      latest.current = res.project;
      past.current = [];
      future.current = [];
      setState(res.project);
      setRender(res.render);
      setHistoryTick((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async () => {
    const p = latest.current;
    if (!p || !dirtyRef.current) return;
    dirtyRef.current = false;
    setDirty(false);
    setSaving(true);
    try {
      await api.put(`/api/projects/${p.id}`, { project: p });
    } catch (err) {
      dirtyRef.current = true;
      setDirty(true);
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, []);

  const schedule = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), SAVE_DELAY);
  }, [persist]);

  // Sayfadan ayrılırken bekleyen değişiklik kaydedilsin.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void persist();
    },
    [persist],
  );

  /** Değişiklik uygular; `record` true ise geri alma adımı olur. */
  const update = useCallback(
    (fn: Updater, { record = true }: { record?: boolean } = {}) => {
      const cur = latest.current;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return;
      if (record && !snapshot.current) {
        past.current.push(cur);
        if (past.current.length > HISTORY_LIMIT) past.current.shift();
        future.current = [];
        setHistoryTick((n) => n + 1);
      }
      latest.current = next;
      setState(next);
      schedule();
    },
    [schedule],
  );

  /** Sunucudan dönen projeyi (ör. varlık bağlandıktan sonra) benimser. */
  const replace = useCallback(
    (next: Project, { record = true }: { record?: boolean } = {}) => {
      const cur = latest.current;
      if (record && cur) {
        past.current.push(cur);
        future.current = [];
        setHistoryTick((n) => n + 1);
      }
      latest.current = next;
      setState(next);
      schedule();
    },
    [schedule],
  );

  const begin = useCallback(() => {
    if (!snapshot.current && latest.current) snapshot.current = latest.current;
  }, []);

  const end = useCallback(() => {
    const snap = snapshot.current;
    snapshot.current = null;
    if (snap && snap !== latest.current) {
      past.current.push(snap);
      if (past.current.length > HISTORY_LIMIT) past.current.shift();
      future.current = [];
      setHistoryTick((n) => n + 1);
    }
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !latest.current) return;
    future.current.push(latest.current);
    latest.current = prev;
    setState(prev);
    setHistoryTick((n) => n + 1);
    schedule();
  }, [schedule]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !latest.current) return;
    past.current.push(latest.current);
    latest.current = next;
    setState(next);
    setHistoryTick((n) => n + 1);
    schedule();
  }, [schedule]);

  void historyTick;
  return {
    project,
    render,
    setRender,
    error,
    saving,
    dirty,
    reload: load,
    update,
    replace,
    begin,
    end,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    flush: persist,
    current: () => latest.current,
  };
}
