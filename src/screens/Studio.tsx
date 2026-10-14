import { useEffect, useState, type CSSProperties } from 'react';
import { FramePreview } from '../components/FramePreview.tsx';
import { Icon } from '../components/Icon.tsx';
import { Field, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, duration } from '../lib/format.ts';
import { alignTo, logoBox } from '../lib/frame.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { BrandMedia, ClipOptions, RecordingOutput, Studio as StudioData } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';

type Format = 'vertical' | 'horizontal';

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: 'vertical', label: 'Dikey 9:16', hint: 'Kliplerden, canlıdan ve geçmiş yayından üretilen dikey videolar' },
  { value: 'horizontal', label: 'Yatay 16:9', hint: 'Geçmiş yayın ve kayıtlardan alınan yatay kesitler' },
];

/** Marka ve şablon: kimlik, önizleme ve üretim varsayılanları. */
export function Studio() {
  const studio = useResource(() => api.get<StudioData>('/api/studio'));
  if (studio.loading && !studio.data) {
    return (
      <div className="center-pad">
        <Spinner size={24} />
      </div>
    );
  }
  if (!studio.data) return <p className="field-error">{studio.error}</p>;
  return <StudioEditor data={studio.data} reload={studio.reload} />;
}

function StudioEditor({ data, reload }: { data: StudioData; reload: () => void }) {
  const [brand, setBrand] = useState(data.brand);
  const [format, setFormat] = useState<Format>('vertical');
  const [defaults, setDefaults] = useState<Record<Format, ClipOptions>>(data.defaults);
  const [output, setOutput] = useState<RecordingOutput>(data.recordingOutput);
  const [saving, setSaving] = useState<string | null>(null);
  const opts = defaults[format];
  const vertical = format === 'vertical';
  const styleKey = opts.subtitleStyle ?? brand.subtitleStyle;
  const sample = useSampleFrame(format);
  const logoAspect = useImageAspect(data.logo.url);

  // Marka renkleri anında sayfaya yansır; önizleme de bunları kullanır.
  const style = { '--brand': brand.brandColor, '--accent': brand.accentColor } as CSSProperties;

  const save = async (key: string, fn: () => Promise<unknown>, done = 'Kaydedildi') => {
    setSaving(key);
    try {
      await fn();
      toast(done, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(null);
    }
  };

  const setOpt = (patch: Partial<ClipOptions>) => setDefaults((d) => ({ ...d, [format]: { ...d[format], ...patch } }));

  return (
    <div style={style}>
      <WorkspaceHead guide="marka" title="Logo ve" tape="görünüm" lead="Logo, renk ve altyazı kimliğini bir kez ayarla. Dikey ve yatay videoların ayarları ayrı; önizleme gerçek yerleşimi gösterir." />

      <div className="studio-grid">
        <section className="panel studio-defaults" aria-label="Üretim varsayılanları">
          <span className="panel-tape" aria-hidden="true" />
          <header className="panel-head">
            <div>
              <h2 className="panel-title">Üretim varsayılanları</h2>
              <p className="panel-sub">{FORMATS.find((f) => f.value === format)!.hint}.</p>
            </div>
            <button type="button" className="btn btn-accent" disabled={saving === 'defaults'} onClick={() => save('defaults', () => api.put('/api/studio/defaults', { format, options: defaults[format] }), `${vertical ? 'Dikey' : 'Yatay'} ayarlar kaydedildi`)}>
              {saving === 'defaults' ? <Spinner /> : <Icon name="check" size={16} />} {vertical ? 'Dikey' : 'Yatay'} ayarlarını kaydet
            </button>
          </header>

          <Segmented label="Biçim" value={format} onChange={setFormat} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} />

          <div className={vertical ? 'proto-stage proto-stage-v' : 'proto-stage'}>
            <div className="proto-h-col">
              <FramePreview
                key={format}
                format={format}
                opts={opts}
                logoUrl={data.logo.url}
                styleKey={styleKey}
                sampleUrl={sample}
                onLogoMove={(x, y) => setOpt({ logoPosition: 'custom', logoX: x, logoY: y })}
              />
              {!vertical && <SequenceStrip intro={data.intro} outro={data.outro} withIntro={opts.intro} withOutro={opts.outro} />}
            </div>

            <div className="proto-settings">
              <h3 className="eyebrow">Logo</h3>
              <Switch checked={opts.logo} onChange={(v) => setOpt({ logo: v })} label="Logoyu ekle" hint={data.logo.exists ? 'Önizlemede sürükle ya da aşağıdan hizala' : 'Sağdaki "Kimlik" bölümünden logo yükle'} />
              <Field label={`Boyut · %${Math.round(opts.logoScale * 100)}`}>
                <input type="range" className="range" min={0.5} max={2} step={0.05} value={opts.logoScale} disabled={!opts.logo} onChange={(e) => setOpt({ logoScale: Number(e.target.value) })} />
              </Field>
              <Field label={`Görünürlük · %${Math.round(opts.logoOpacity * 100)}`}>
                <input type="range" className="range" min={0.05} max={1} step={0.05} value={opts.logoOpacity} disabled={!opts.logo} onChange={(e) => setOpt({ logoOpacity: Number(e.target.value) })} />
              </Field>
              {vertical && (
                <Field label="Yeri">
                  <Segmented
                    size="small"
                    label="Logo yeri"
                    value={opts.logoPosition}
                    onChange={(v) => setOpt(v === 'custom' ? { logoPosition: 'custom', logoX: opts.logoX ?? 0.5, logoY: opts.logoY ?? 0.1 } : { logoPosition: v })}
                    options={[
                      { value: 'seam', label: 'Kamera altı' },
                      { value: 'top-center', label: 'Üst orta' },
                      { value: 'custom', label: 'Serbest' },
                    ]}
                  />
                </Field>
              )}
              <Field label="Hizala" help="Kenarlarda %5 güvenli pay bırakılır. Sürüklerken merkeze, üçte birlere ve kenarlara yapışır.">
                <AlignGrid
                  disabled={!opts.logo}
                  onAlign={(col, row) => {
                    const b = logoBox(format, opts, logoAspect, vertical && opts.composition !== 'single');
                    const p = alignTo(col, row, b.w / 2, b.h / 2);
                    setOpt({ logoPosition: 'custom', logoX: Math.round(p.x * 1000) / 1000, logoY: Math.round(p.y * 1000) / 1000 });
                  }}
                />
              </Field>

              <h3 className="eyebrow pad-top">Video</h3>
              <Switch
                checked={opts.subtitles}
                onChange={(v) => setOpt({ subtitles: v })}
                label="Altyazı"
                hint={vertical ? 'Konuşma yazıya dökülür (Ayarlar\'da otomatik altyazı açık olmalı)' : 'Yatayda varsayılan kapalı; açarsan kesite basılır'}
              />
              <Switch checked={opts.subtitleFollowsTheme} onChange={(v) => setOpt({ subtitleFollowsTheme: v })} label="Vurgu rengi altyazıda" hint="Kapalıyken marka rengi" />
              <Switch checked={opts.censor} onChange={(v) => setOpt({ censor: v })} label="Küfür sansürü" hint="Geçen anlar biplenir" />
              {vertical ? (
                <Field label="Yerleşim">
                  <Segmented
                    size="small"
                    label="Yerleşim"
                    value={opts.composition}
                    onChange={(v) => setOpt({ composition: v })}
                    options={[
                      { value: 'auto', label: 'Otomatik' },
                      { value: 'split', label: 'Kamera + oyun' },
                      { value: 'single', label: 'Tek kare' },
                    ]}
                  />
                </Field>
              ) : (
                <>
                  <Switch checked={opts.intro} onChange={(v) => setOpt({ intro: v })} label="Açılış videosu ekle" hint={data.intro.exists ? `${duration(data.intro.durationSec)} başa eklenir` : 'Yüklenmedi'} disabled={!data.intro.exists} />
                  <Switch checked={opts.outro} onChange={(v) => setOpt({ outro: v })} label="Kapanış videosu ekle" hint={data.outro.exists ? `${duration(data.outro.durationSec)} sona eklenir` : 'Yüklenmedi'} disabled={!data.outro.exists} />
                </>
              )}
              {vertical && (
                <Field label={`Otomatik paylaşım eşiği · ${opts.autoPublishMinScore || 'yok'}`} help="Otomatik takipte paylaşılan kliplerde beğenilme tahmini bunun altında kalanlar paylaşılmaz">
                  <input type="range" className="range" min={0} max={100} step={5} value={opts.autoPublishMinScore} onChange={(e) => setOpt({ autoPublishMinScore: Number(e.target.value) })} />
                </Field>
              )}
            </div>
          </div>
        </section>

        <aside className="ws-stack">
          <section className="panel">
            <h2 className="panel-title">Kimlik</h2>
            <div className="stack">
              <LogoUpload logo={data.logo} max={data.limits.logoMaxBytes} onChange={reload} />
              <div className="color-row">
                <ColorField label="Marka rengi" value={brand.brandColor} onChange={(v) => setBrand({ ...brand, brandColor: v })} />
                <ColorField label="Vurgu rengi" value={brand.accentColor} onChange={(v) => setBrand({ ...brand, accentColor: v })} />
              </div>
              <Field label="Altyazı stili">
                <div className="style-grid">
                  {data.styles.map((st) => (
                    <button key={st.key} type="button" className={brand.subtitleStyle === st.key ? 'style-tile style-tile-on' : 'style-tile'} onClick={() => setBrand({ ...brand, subtitleStyle: st.key })} title={st.hint}>
                      <span className={`sub-sample sub-${st.key}`}>
                        Aa <em>Bb</em>
                      </span>
                      <span>{st.label}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Segmented
                label="İçerik dili"
                value={brand.language}
                onChange={(v) => setBrand({ ...brand, language: v })}
                options={[
                  { value: 'tr', label: 'Türkçe' },
                  { value: 'en', label: 'English' },
                ]}
              />
              <button type="button" className="btn btn-primary" disabled={saving === 'brand'} onClick={() => save('brand', () => api.put('/api/studio/brand', brand))}>
                {saving === 'brand' ? <Spinner /> : null} Kimliği kaydet
              </button>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Açılış ve kapanış videosu</h2>
            <p className="panel-sub">
              Yatay videoların ve paylaşıma hazır kayıtların başına ve sonuna eklenir; dikey videolara eklenmez. En fazla {data.limits.mediaMaxSeconds} sn, {bytes(data.limits.mediaMaxBytes)}.
            </p>
            <div className="stack">
              <MediaUpload kind="intro" media={data.intro} onChange={reload} />
              <MediaUpload kind="outro" media={data.outro} onChange={reload} />
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Paylaşıma hazır kayıt ayarları</h2>
            <p className="panel-sub">Yayın kayıtlarında "Paylaşıma hazırla" dediğinde kullanılır. Kendiliğinden hiçbir şey hazırlanmaz.</p>
            <div className="stack">
              <Switch checked={output.intro} onChange={(v) => setOutput({ ...output, intro: v })} label="Açılış videosu" />
              <Switch checked={output.outro} onChange={(v) => setOutput({ ...output, outro: v })} label="Kapanış videosu" />
              <Switch checked={output.logo} onChange={(v) => setOutput({ ...output, logo: v })} label="Logo (alt ortada)" />
              <Field label={`Kalite · ${output.bitrateMbps} Mbps (yüksek = daha net, daha büyük dosya)`}>
                <input type="range" className="range" min={1} max={8} step={0.5} value={output.bitrateMbps} onChange={(e) => setOutput({ ...output, bitrateMbps: Number(e.target.value) })} />
              </Field>
              <Segmented
                size="small"
                label="Çözünürlük"
                value={output.resolution}
                onChange={(v) => setOutput({ ...output, resolution: v })}
                options={[
                  { value: 'source', label: 'Kaynak' },
                  { value: '1080p', label: '1080p' },
                  { value: '720p', label: '720p' },
                ]}
              />
              <Segmented
                size="small"
                label="Dosya türü"
                value={output.codec}
                onChange={(v) => setOutput({ ...output, codec: v })}
                options={[
                  { value: 'h264', label: 'Her yerde açılır' },
                  { value: 'hevc', label: 'Daha küçük dosya', disabled: !data.hevcAvailable },
                ]}
              />
              <Segmented
                size="small"
                label="Hız"
                value={output.speed}
                onChange={(v) => setOutput({ ...output, speed: v })}
                options={[
                  { value: 'fast', label: 'Hızlı' },
                  { value: 'balanced', label: 'Dengeli' },
                  { value: 'quality', label: 'Kaliteli' },
                ]}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving === 'output'}
                onClick={() => save('output', async () => setOutput((await api.put<{ options: RecordingOutput }>('/api/studio/recording-output', { options: output })).options))}
              >
                {saving === 'output' ? <Spinner /> : null} Ayarları kaydet
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ── Önizleme yardımcıları ─────────────────────────────────────────────── */

/** Logonun en/boy oranı (yükseklik/genişlik); hizalama hesabı için. */
function useImageAspect(url: string | null) {
  const [aspect, setAspect] = useState(1 / 3);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => img.naturalWidth && setAspect(img.naturalHeight / img.naturalWidth);
    img.src = url;
  }, [url]);
  return aspect;
}

const ALIGN_LABELS = [
  ['Sol üst', 'Üst orta', 'Sağ üst'],
  ['Sol orta', 'Tam orta', 'Sağ orta'],
  ['Sol alt', 'Alt orta', 'Sağ alt'],
];

/** 3x3 hizalama düğmeleri. */
function AlignGrid({ onAlign, disabled }: { onAlign: (col: 0 | 1 | 2, row: 0 | 1 | 2) => void; disabled: boolean }) {
  return (
    <div className="align-grid" role="group" aria-label="Logoyu hizala">
      {ALIGN_LABELS.map((rowLabels, row) =>
        rowLabels.map((label, col) => (
          <button key={label} type="button" className="align-cell" title={label} aria-label={label} disabled={disabled} onClick={() => onAlign(col as 0 | 1 | 2, row as 0 | 1 | 2)}>
            <span />
          </button>
        )),
      )}
    </div>
  );
}

function useSampleFrame(format: 'vertical' | 'horizontal') {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // Dikey önizleme şematiktir (kamera / oyun dikişi); yalnız yatay için ham kare istenir.
    if (format === 'vertical') {
      setUrl(null);
      return;
    }
    let revoke: string | null = null;
    fetch('/api/studio/sample-frame', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) setUrl((revoke = URL.createObjectURL(b)));
      })
      .catch(() => {});
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [format]);
  return url;
}

function SequenceStrip({ intro, outro, withIntro, withOutro }: { intro: BrandMedia; outro: BrandMedia; withIntro: boolean; withOutro: boolean }) {
  const parts = [
    intro.exists && withIntro && { key: 'intro', label: 'Açılış', sec: intro.durationSec ?? 0 },
    { key: 'main', label: 'Video', sec: 0 },
    outro.exists && withOutro && { key: 'outro', label: 'Kapanış', sec: outro.durationSec ?? 0 },
  ].filter(Boolean) as { key: string; label: string; sec: number }[];
  return (
    <div className="sequence" aria-label="Videonun sırası">
      {parts.map((p) => (
        <span key={p.key} className={`seq seq-${p.key}`}>
          <b>{p.label}</b>
          {p.sec ? <span>{duration(p.sec)}</span> : <span>içerik</span>}
        </span>
      ))}
    </div>
  );
}

/* ── Yüklemeler ────────────────────────────────────────────────────────── */

function LogoUpload({ logo: loaded, max, onChange }: { logo: StudioData['logo']; max: number; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const logo = removed ? { exists: false, url: null } : loaded;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > max) return toast(`Logo ${bytes(max)} sınırını aşıyor`, 'error');
    setBusy(true);
    try {
      await api.upload('/api/studio/logo', file);
      toast('Logo yüklendi', 'ok');
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="upload-row">
      <span className="logo-well">{logo.url ? <img src={logo.url} alt="Logo" /> : <Icon name="image" size={22} />}</span>
      <div className="upload-body">
        <b>Logo</b>
        <span className="muted">Şeffaf PNG önerilir</span>
        <div className="row-gap">
          <label className="btn btn-secondary btn-small">
            {busy ? <Spinner size={12} /> : <Icon name="upload" size={14} />} {logo.exists ? 'Değiştir' : 'Yükle'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {logo.exists && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() =>
                deleteWithUndo({
                  label: 'Logo kaldırıldı',
                  hide: () => setRemoved(true),
                  restore: () => setRemoved(false),
                  commit: () => api.del('/api/studio/logo'),
                  done: () => {
                    setRemoved(false);
                    onChange();
                  },
                })
              }
            >
              Kaldır
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MediaUpload({ kind, media: loaded, onChange }: { kind: 'intro' | 'outro'; media: BrandMedia; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const media = removed ? { ...loaded, exists: false, url: null } : loaded;
  const label = kind === 'intro' ? 'Açılış videosu' : 'Kapanış videosu';
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.upload(`/api/studio/media/${kind}`, file);
      toast(`${label} yüklendi`, 'ok');
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="upload-row">
      <span className="media-well">{media.url ? <video src={media.url} muted playsInline preload="metadata" onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} /> : <Icon name="film" size={22} />}</span>
      <div className="upload-body">
        <b>{label}</b>
        <span className="muted">{media.exists ? `${duration(media.durationSec)} · ${media.width}×${media.height}${media.hasAudio ? '' : ' · sessiz'}` : 'Yüklenmedi'}</span>
        <div className="row-gap">
          <label className="btn btn-secondary btn-small">
            {busy ? <Spinner size={12} /> : <Icon name="upload" size={14} />} {media.exists ? 'Değiştir' : 'Yükle'}
            <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {media.exists && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() =>
                deleteWithUndo({
                  label: `${label} kaldırıldı`,
                  hide: () => setRemoved(true),
                  restore: () => setRemoved(false),
                  commit: () => api.del(`/api/studio/media/${kind}`),
                  done: () => {
                    setRemoved(false);
                    onChange();
                  },
                })
              }
            >
              Kaldır
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-field">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span>
        <b>{label}</b>
        <span className="muted">{value.toUpperCase()}</span>
      </span>
    </label>
  );
}
