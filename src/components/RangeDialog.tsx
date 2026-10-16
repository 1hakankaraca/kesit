import { useEffect, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Field, Modal, Spinner } from './basics.tsx';
import { clockText, parseClock } from '../lib/clock.ts';
import { duration } from '../lib/format.ts';

export interface TimeRange {
  startSec: number;
  endSec: number;
}

const EN_AZ_SN = 5;
const CANLI_ILERI_SN = 4 * 3600;

/**
 * Yayının bir aralığını indirmek için başlangıç/bitiş girişi.
 * Girişler "25" (dakika), "25:30" (dk:sn) ya da "1:02:00" (sa:dk:sn) olabilir.
 * Canlıda bitiş ileride olabilir: yayın o ana gelince dosya kapanır.
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
  /** Bitmiş yayında süre; canlıda şu ana kadar geçen süre (saniye). */
  durationSec: number;
  live?: boolean;
  onSubmit: (range: TimeRange) => Promise<void>;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStart('');
      setEnd('');
      setError(null);
    }
  }, [open]);

  const startSec = parseClock(start);
  const endSec = parseClock(end);
  const problem = (() => {
    if (!start.trim() && !end.trim()) return null;
    if (startSec === null) return 'Başlangıcı dakika ya da sa:dk:sn olarak yaz';
    if (endSec === null) return 'Bitişi dakika ya da sa:dk:sn olarak yaz';
    if (endSec - startSec < EN_AZ_SN) return `Bitiş başlangıçtan en az ${EN_AZ_SN} saniye sonra olmalı`;
    if (!live && durationSec > 0 && startSec >= durationSec) return `Yayın ${duration(durationSec)} sürüyor; başlangıç bunun içinde olmalı`;
    if (live && endSec > durationSec + CANLI_ILERI_SN) return 'Bitiş en fazla 4 saat ileride olabilir';
    return null;
  })();
  const ready = startSec !== null && endSec !== null && !problem;
  const future = live && endSec !== null && endSec > durationSec;

  const preset = (lastSec: number) => {
    const s = Math.max(0, durationSec - lastSec);
    setStart(clockText(s));
    setEnd(clockText(durationSec));
  };

  const submit = async () => {
    if (!ready || startSec === null || endSec === null) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ startSec, endSec: live ? endSec : Math.min(endSec, durationSec || endSec) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
            {busy ? <Spinner /> : <Icon name="download" size={16} />} {future ? 'Aralığı kaydet' : 'Aralığı indir'}
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
            ? `Yayın şu an ${duration(durationSec)} noktasında. Bitişi ileride verirsen yayın o ana gelene kadar beklenir, sonra dosya kapanır.`
            : `Yayın ${duration(durationSec)} sürüyor. Sadece yazdığın aralık iner; aynı yayından istediğin kadar aralık alabilirsin.`}
        </p>
        <div className="inline-form">
          <Field label="Başlangıç" htmlFor="range-start" help="dakika ya da sa:dk:sn">
            <input id="range-start" className="input input-narrow" value={start} onChange={(e) => setStart(e.target.value)} placeholder={live ? clockText(Math.max(0, durationSec - 600)) : '12:00'} autoFocus />
          </Field>
          <Field label="Bitiş" htmlFor="range-end" help="dakika ya da sa:dk:sn">
            <input id="range-end" className="input input-narrow" value={end} onChange={(e) => setEnd(e.target.value)} placeholder={live ? clockText(durationSec) : '35:00'} />
          </Field>
        </div>
        {live && durationSec > 60 && (
          <div className="row-gap">
            <span className="eyebrow">Hızlı seç</span>
            {[5, 10, 30].map((dk) => (
              <button key={dk} type="button" className="btn btn-quiet btn-small" onClick={() => preset(dk * 60)} disabled={durationSec < dk * 60}>
                Son {dk} dk
              </button>
            ))}
          </div>
        )}
        {problem && <p className="field-error">{problem}</p>}
        {!problem && ready && startSec !== null && endSec !== null && (
          <p className="field-help">
            {clockText(startSec)} – {clockText(endSec)} · {duration(endSec - startSec)}
            {future ? ' · bitiş ileride, yayın o ana gelince kapanır' : ''}
          </p>
        )}
        {error && <p className="field-error">{error}</p>}
      </form>
    </Modal>
  );
}
