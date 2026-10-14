import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Field, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, duration } from '../lib/format.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { BrandMedia, ClipOptions, RecordingOutput, Studio as StudioData } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';

type Format = 'vertical' | 'horizontal';

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: 'vertical', label: 'Dikey 9:16', hint: 'Kliplerden, canlıdan ve geçmiş yayından üretilen dikey videolar' },
  { value: 'horizontal', label: 'Yatay 16:9', hint: 'Geçmiş yayın ve kayıtlardan alınan yatay kesitler' },
];

const SAMPLE_LINE = ['Bunu', 'kimse', 'beklemiyordu', 've', 'tam', 'o', 'anda…'];

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
      <WorkspaceHead guide="marka" title="Marka ve" tape="şablon" lead="Logo, renk ve altyazı kimliğini bir kez ayarla. Dikey ve yatay videoların ayarları ayrı; önizleme gerçek yerleşimi gösterir." />

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
            {vertical ? (
              <VerticalProto opts={opts} logoUrl={data.logo.url} styleKey={styleKey} />
            ) : (
              <div className="proto-h-col">
                <HorizontalProto opts={opts} logoUrl={data.logo.url} styleKey={styleKey} onLogoMove={(x, y) => setOpt({ logoPosition: 'custom', logoX: x, logoY: y })} />
                <SequenceStrip intro={data.intro} outro={data.outro} withIntro={opts.intro} withOutro={opts.outro} />
              </div>
            )}

            <div className="proto-settings">
              <h3 className="eyebrow">Logo</h3>
              <Switch checked={opts.logo} onChange={(v) => setOpt({ logo: v })} label="Logoyu bindir" hint={data.logo.exists ? (vertical ? 'Yeri aşağıdan seçilir' : 'Önizlemede sürükleyerek konumla') : 'Sağdaki Kimlik bölümünden logo yükle'} />
              <Field label={`Boyut · ${Math.round(opts.logoScale * 100)}%`}>
                <input type="range" className="range" min={0.5} max={2} step={0.05} value={opts.logoScale} disabled={!opts.logo} onChange={(e) => setOpt({ logoScale: Number(e.target.value) })} />
              </Field>
              <Field label={`Opaklık · ${Math.round(opts.logoOpacity * 100)}%`}>
                <input type="range" className="range" min={0.05} max={1} step={0.05} value={opts.logoOpacity} disabled={!opts.logo} onChange={(e) => setOpt({ logoOpacity: Number(e.target.value) })} />
              </Field>
              {vertical && (
                <Field label="Yeri">
                  <Segmented
                    size="small"
                    label="Logo yeri"
                    value={opts.logoPosition === 'top-center' ? 'top-center' : 'seam'}
                    onChange={(v) => setOpt({ logoPosition: v })}
                    options={[
                      { value: 'seam', label: 'Dikiş' },
                      { value: 'top-center', label: 'Üst orta' },
                    ]}
                  />
                </Field>
              )}

              <h3 className="eyebrow pad-top">Video</h3>
              <Switch checked={opts.subtitles} onChange={(v) => setOpt({ subtitles: v })} label="Altyazı" hint="Konuşma yazıya dökülür (Ayarlar'da altyazı motoru gerekir)" />
              <Switch checked={opts.subtitleFollowsTheme} onChange={(v) => setOpt({ subtitleFollowsTheme: v })} label="Vurgu rengi altyazıda" hint="Kapalıyken marka rengi" />
              <Switch checked={opts.censor} onChange={(v) => setOpt({ censor: v })} label="Küfür sansürü" hint="Geçen anlar biplenir" />
              {vertical ? (
                <Field label="Kompozisyon">
                  <Segmented
                    size="small"
                    label="Kompozisyon"
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
                  <Switch checked={opts.intro} onChange={(v) => setOpt({ intro: v })} label="Intro ekle" hint={data.intro.exists ? `${duration(data.intro.durationSec)} başa eklenir` : 'Yüklenmedi'} disabled={!data.intro.exists} />
                  <Switch checked={opts.outro} onChange={(v) => setOpt({ outro: v })} label="Outro ekle" hint={data.outro.exists ? `${duration(data.outro.durationSec)} sona eklenir` : 'Yüklenmedi'} disabled={!data.outro.exists} />
                </>
              )}
              {vertical && (
                <Field label={`Otomatik paylaşım eşiği · ${opts.autoPublishMinScore || 'yok'}`} help="Nöbet'te otomatik paylaşılan kliplerde viral skoru bunun altındakiler paylaşılmaz">
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
            <h2 className="panel-title">Intro ve outro</h2>
            <p className="panel-sub">
              Yalnız yatay videolara ve çıktılara eklenir; dikey videolara eklenmez. En fazla {data.limits.mediaMaxSeconds} sn, {bytes(data.limits.mediaMaxBytes)}.
            </p>
            <div className="stack">
              <MediaUpload kind="intro" media={data.intro} onChange={reload} />
              <MediaUpload kind="outro" media={data.outro} onChange={reload} />
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Çıktı ayarları</h2>
            <p className="panel-sub">Kayıtlar bölümünde "Çıktıyı üret" dediğinde kullanılır. Hiçbir çıktı kendiliğinden üretilmez.</p>
            <div className="stack">
              <Switch checked={output.intro} onChange={(v) => setOutput({ ...output, intro: v })} label="Intro" />
              <Switch checked={output.outro} onChange={(v) => setOutput({ ...output, outro: v })} label="Outro" />
              <Switch checked={output.logo} onChange={(v) => setOutput({ ...output, logo: v })} label="Logo (alt orta)" />
              <Field label={`Bit hızı · ${output.bitrateMbps} Mbps`}>
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
                label="Kodlayıcı"
                value={output.codec}
                onChange={(v) => setOutput({ ...output, codec: v })}
                options={[
                  { value: 'h264', label: 'H.264' },
                  { value: 'hevc', label: 'H.265', disabled: !data.hevcAvailable },
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
                {saving === 'output' ? <Spinner /> : null} Çıktı ayarlarını kaydet
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ── Önizlemeler ───────────────────────────────────────────────────────── */

function useSampleFrame(orientation: 'vertical' | 'horizontal') {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    fetch(`/api/studio/sample-frame?orientation=${orientation}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) setUrl((revoke = URL.createObjectURL(b)));
      })
      .catch(() => {});
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [orientation]);
  return url;
}

function SubtitleSample({ styleKey }: { styleKey: string }) {
  return (
    <p className={`proto-sub sub-${styleKey}`}>
      {SAMPLE_LINE.map((w, i) => (i === 2 ? <em key={i}>{w} </em> : `${w} `))}
    </p>
  );
}

function VerticalProto({ opts, logoUrl, styleKey }: { opts: ClipOptions; logoUrl: string | null; styleKey: string }) {
  const frame = useSampleFrame('vertical');
  const split = opts.composition !== 'single';
  return (
    <figure className="proto proto-v">
      <div className="proto-frame">
        {frame ? (
          <img className="proto-bg" src={frame} alt="" />
        ) : (
          <>
            {split && <div className="proto-cam">Kamera</div>}
            <div className={split ? 'proto-game' : 'proto-game proto-game-full'}>Oyun / ekran</div>
          </>
        )}
        {opts.logo &&
          (logoUrl ? (
            <img
              className={opts.logoPosition === 'top-center' ? 'proto-logo proto-logo-top' : 'proto-logo proto-logo-seam'}
              src={logoUrl}
              alt=""
              style={{ width: `${22 * opts.logoScale}%`, opacity: opts.logoOpacity }}
            />
          ) : (
            <span
              className={`proto-logo proto-logo-ghost ${opts.logoPosition === 'top-center' ? 'proto-logo-top' : 'proto-logo-seam'}`}
              style={{ width: `${22 * opts.logoScale}%`, opacity: opts.logoOpacity }}
            >
              LOGO
            </span>
          ))}
        {opts.subtitles && <SubtitleSample styleKey={styleKey} />}
      </div>
      <figcaption>Dikey 9:16</figcaption>
    </figure>
  );
}

function HorizontalProto({ opts, logoUrl, styleKey, onLogoMove }: { opts: ClipOptions; logoUrl: string | null; styleKey: string; onLogoMove: (x: number, y: number) => void }) {
  const frame = useSampleFrame('horizontal');
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const x = opts.logoX ?? 0.92;
  const y = opts.logoY ?? 0.08;

  const move = (e: ReactPointerEvent) => {
    if (!dragging.current || !box.current) return;
    const r = box.current.getBoundingClientRect();
    // Logo merkezden konumlanır; kenarlardan taşmasın diye yarı boyutu kadar içeride tutulur.
    const half = ((1 / 3) * opts.logoScale) / 2;
    const halfH = ((r.width / 3) * opts.logoScale) / 6 / r.height;
    const nx = Math.min(1 - half, Math.max(half, (e.clientX - r.left) / r.width));
    const ny = Math.min(1 - halfH, Math.max(halfH, (e.clientY - r.top) / r.height));
    onLogoMove(Math.round(nx * 1000) / 1000, Math.round(ny * 1000) / 1000);
  };

  return (
    <figure className="proto proto-h">
      <div className="proto-frame" ref={box} onPointerMove={move} onPointerUp={() => (dragging.current = false)} onPointerLeave={() => (dragging.current = false)}>
        {frame ? <img className="proto-bg" src={frame} alt="" /> : <div className="proto-game proto-game-full">Yayın görüntüsü</div>}
        {opts.logo && (
          <span
            className={logoUrl ? 'proto-logo proto-logo-free' : 'proto-logo proto-logo-free proto-logo-ghost'}
            role="img"
            aria-label="Logo — sürükleyerek konumla"
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${(100 / 3) * opts.logoScale}%`, opacity: opts.logoOpacity }}
            onPointerDown={(e) => {
              dragging.current = true;
              (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
            }}
          >
            {logoUrl ? <img src={logoUrl} alt="" draggable={false} /> : 'LOGO'}
          </span>
        )}
        {opts.subtitles && <SubtitleSample styleKey={styleKey} />}
      </div>
      <figcaption>Yatay 16:9 · logoyu sürükle</figcaption>
    </figure>
  );
}

function SequenceStrip({ intro, outro, withIntro, withOutro }: { intro: BrandMedia; outro: BrandMedia; withIntro: boolean; withOutro: boolean }) {
  const parts = [
    intro.exists && withIntro && { key: 'intro', label: 'Intro', sec: intro.durationSec ?? 0 },
    { key: 'main', label: 'Kesit', sec: 0 },
    outro.exists && withOutro && { key: 'outro', label: 'Outro', sec: outro.durationSec ?? 0 },
  ].filter(Boolean) as { key: string; label: string; sec: number }[];
  return (
    <div className="sequence" aria-label="Çıktı sırası">
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
  const label = kind === 'intro' ? 'Intro' : 'Outro';
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
