import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Field, Modal, Segmented, Spinner } from './basics.tsx';
import { clockText, parseClock } from '../lib/clock.ts';
import { duration } from '../lib/format.ts';

export interface TimeRange {
  startSec: number;
  endSec: number;
}

type Mode = 'bastan' | 'geriye';

interface RowState {
  id: number;
  start: string;
  end: string;
}

const EN_AZ_SN = 5;
const CANLI_ILERI_SN = 4 * 3600;
const EN_COK_ARALIK = 10;
let nextRowId = 1;
const newRow = (): RowState => ({ id: nextRowId++, start: '', end: '' });

/**
 * Bir satırı saniyeye çevirir (saf). "Yayın başından" kipinde girilen değer
 * yayın başından uzaklıktır; "Şu andan geriye" kipinde "ne kadar önce"dir
 * (başlangıç daha geride olmalı). Hata metni ya da aralık döner.
 */
export function resolveRow(row: { start: string; end: string }, mode: Mode, nowSec: number, live: boolean): { range?: TimeRange; error?: string; empty?: boolean } {
  if (!row.start.trim() && !row.end.trim()) return { empty: true };
  const a = parseClock(row.start);
  const b = parseClock(row.end);
  if (a === null) return { error: mode === 'geriye' ? 'Başlangıcı "kaç dakika önce" olarak yaz (ör. 80 ya da 1:20:00)' : 'Başlangıcı dakika ya da sa:dk:sn olarak yaz' };
  if (b === null) return { error: mode === 'geriye' ? 'Bitişi "kaç dakika önce" olarak yaz (0 = şu an)' : 'Bitişi dakika ya da sa:dk:sn olarak yaz' };
  let startSec: number;
  let endSec: number;
  if (mode === 'geriye') {
    if (b >= a) return { error: 'Bitiş, başlangıçtan daha yakın bir an olmalı (ör. 80 dk önce → 50 dk önce)' };
    startSec = Math.max(0, nowSec - a);
    endSec = Math.max(0, nowSec - b);
    if (a > nowSec) return { error: `Yayın ${duration(nowSec)} önce başladı; daha geriye gidilemez` };
  } else {
    startSec = a;
    endSec = b;
  }
  if (endSec - startSec < EN_AZ_SN) return { error: `Bitiş başlangıçtan en az ${EN_AZ_SN} saniye sonra olmalı` };
  if (!live && nowSec > 0 && startSec >= nowSec) return { error: `Yayın ${duration(nowSec)} sürüyor; başlangıç bunun içinde olmalı` };
  if (live && endSec > nowSec + CANLI_ILERI_SN) return { error: 'Bitiş en fazla 4 saat ileride olabilir' };
  return { range: { startSec, endSec: live ? endSec : Math.min(endSec, nowSec || endSec) } };
}

/**
 * Yayının bir ya da birkaç aralığını indirmek için başlangıç/bitiş girişi.
 * Girişler "25" (dakika), "25:30" (dk:sn) ya da "1:02:00" (sa:dk:sn) olabilir.
 * Canlıda iki kip vardır: yayın başından sayarak ya da şu andan geriye
 * ("80 dk önce → 50 dk önce"). Bitiş ileride olabilir: yayın o ana gelince
 * dosya kapanır. Her aralık ayrı bir indirme olarak açılır.
 */
export function RangeDialog({
  open,
  onClose,
  title,
  durationSec,
  live = false,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Bitmiş yayında süre; canlıda şu ana kadar geçen süre (saniye, canlıda her saniye artar). */
  durationSec: number;
  live?: boolean;
  onSubmit: (ranges: TimeRange[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<RowState[]>(() => [newRow()]);
  const [mode, setMode] = useState<Mode>('bastan');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Açılış anındaki süre: yer tutucular ve hızlı seçimler bununla hesaplanır ki
  // canlıda her saniye değişip göz önünde oynamasın. Gerçek hesap gönderim
  // anındaki süreyle yapılır.
  const [base, setBase] = useState(durationSec);
  const latest = useRef(durationSec);
  latest.current = durationSec;

  useEffect(() => {
    if (open) {
      setRows([newRow()]);
      setMode('bastan');
      setError(null);
      setBase(latest.current);
    }
  }, [open]);

  const resolved = rows.map((r) => resolveRow(r, mode, base, live));
  const problem = resolved.find((r) => r.error)?.error ?? null;
  const ranges = resolved.filter((r) => r.range).map((r) => r.range!);
  const ready = !problem && ranges.length > 0;

  const patch = (id: number, p: Partial<RowState>) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: number) => setRows((list) => (list.length > 1 ? list.filter((r) => r.id !== id) : list));
  const add = () => setRows((list) => (list.length < EN_COK_ARALIK ? [...list, newRow()] : list));

  const preset = (lastSec: number) => {
    setRows((list) => {
      const target = list.find((r) => !r.start.trim() && !r.end.trim()) ?? list[list.length - 1];
      const start = mode === 'geriye' ? clockText(lastSec) : clockText(Math.max(0, base - lastSec));
      const end = mode === 'geriye' ? '0' : clockText(base);
      return list.map((r) => (r.id === target.id ? { ...r, start, end } : r));
    });
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // Canlıda "geriye" kipi gönderim anına göre hesaplanır.
      const now = latest.current;
      const final = rows.map((r) => resolveRow(r, mode, now, live)).filter((r) => r.range).map((r) => r.range!);
      await onSubmit(final);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const geriye = mode === 'geriye';
  const future = live && !geriye && ranges.some((r) => r.endSec > base);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-accent" onClick={() => void submit()} disabled={!ready || busy}>
            {busy ? <Spinner /> : <Icon name="download" size={16} />} {ranges.length > 1 ? `${ranges.length} aralığı indir` : future ? 'Aralığı kaydet' : 'Aralığı indir'}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted">
          {live
            ? `Yayın şu an ${duration(base)} noktasında. Yazdığın her aralık ayrı bir dosya olarak iner; bitişi ileride verirsen yayın o ana gelene kadar beklenir.`
            : `Yayın ${duration(base)} sürüyor. Sadece yazdığın aralıklar iner; aynı yayından istediğin kadar aralık alabilirsin.`}
        </p>
        {live && (
          <Segmented
            size="small"
            label="Zaman kipi"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setRows([newRow()]);
            }}
            options={[
              { value: 'bastan', label: 'Yayın başından' },
              { value: 'geriye', label: 'Şu andan geriye' },
            ]}
          />
        )}
        <div className="range-rows">
          {rows.map((row, i) => (
            <div key={row.id} className="range-row">
              <span className="range-row-no">{i + 1}</span>
              <Field label={geriye ? 'Başlangıç (… önce)' : 'Başlangıç'} htmlFor={`range-start-${row.id}`} help={geriye ? 'ör. 80 = 80 dk önce' : 'dakika ya da sa:dk:sn'}>
                <input
                  id={`range-start-${row.id}`}
                  className="input input-narrow"
                  value={row.start}
                  onChange={(e) => patch(row.id, { start: e.target.value })}
                  placeholder={geriye ? '80' : live ? clockText(Math.max(0, base - 600)) : '12:00'}
                  autoFocus={i === 0}
                  autoComplete="off"
                />
              </Field>
              <Field label={geriye ? 'Bitiş (… önce)' : 'Bitiş'} htmlFor={`range-end-${row.id}`} help={geriye ? '0 = şu an' : 'dakika ya da sa:dk:sn'}>
                <input id={`range-end-${row.id}`} className="input input-narrow" value={row.end} onChange={(e) => patch(row.id, { end: e.target.value })} placeholder={geriye ? '50' : live ? clockText(base) : '35:00'} autoComplete="off" />
              </Field>
              <span className="range-row-sum muted">
                {resolved[i].range ? `${clockText(resolved[i].range!.startSec)} – ${clockText(resolved[i].range!.endSec)} · ${duration(resolved[i].range!.endSec - resolved[i].range!.startSec)}` : ''}
              </span>
              <button type="button" className="btn btn-quiet btn-icon" onClick={() => remove(row.id)} disabled={rows.length === 1} aria-label="Aralığı kaldır" title="Aralığı kaldır">
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="row-gap">
          <button type="button" className="btn btn-secondary btn-small" onClick={add} disabled={rows.length >= EN_COK_ARALIK}>
            <Icon name="plus" size={14} /> Aralık ekle
          </button>
          {live && base > 60 && (
            <>
              <span className="eyebrow">Hızlı seç</span>
              {[5, 10, 30].map((dk) => (
                <button key={dk} type="button" className="btn btn-quiet btn-small" onClick={() => preset(dk * 60)} disabled={base < dk * 60}>
                  Son {dk} dk
                </button>
              ))}
            </>
          )}
        </div>
        {problem && <p className="field-error">{problem}</p>}
        {!problem && future && <p className="field-help">Bitişi ileride olan aralıklar yayın o ana gelince kapanır.</p>}
        {error && <p className="field-error">{error}</p>}
      </form>
    </Modal>
  );
}
