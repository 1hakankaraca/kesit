import { useEffect, useState, type CSSProperties } from 'react';
import { DEFAULT_FRAME_CHAT } from '../../shared/frame.ts';
import type { Rect } from '../../shared/project.ts';
import { DEFAULT_LAYOUT, LayoutEditor, normalizeLayout, type LayoutFrame, type ManualLayout } from '../components/AlignDialog.tsx';
import { CropEditor } from '../components/CropEditor.tsx';
import { FramePreview } from '../components/FramePreview.tsx';
import { Icon } from '../components/Icon.tsx';
import { Field, Modal, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { bytes, duration } from '../lib/format.ts';
import { alignTo, logoBox } from '../lib/frame.ts';
import { useSession } from '../lib/session.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { BrandMedia, ClipOptions, CtaAction, CtaColorKey, CtaConfig, CtaFormat, CtaFormatConfig, CtaPlace, CtaStyle, RecordingOutput, Studio as StudioData, StudioFrame } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { SettingsTabs } from '../components/SettingsTabs.tsx';

type Format = 'vertical' | 'horizontal';
/** Eski sunucu (güncellemeden sonra yeniden başlamamış) çerçeve alanını göndermezse arayüz çökmesin. */
const NO_FRAME: StudioFrame = { exists: false, url: null, window: null, chat: null };

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: 'vertical', label: 'Dikey 9:16', hint: 'Kliplerden, canlıdan ve geçmiş yayından üretilen dikey videolar' },
  { value: 'horizontal', label: 'Yatay 16:9', hint: 'Geçmiş yayın ve kayıtlardan alınan yatay kesitler' },
];

/**
 * Marka ve şablon: kimlik, önizleme ve üretim varsayılanları. Üstteki kapsam
 * seçimiyle "Genel" ya da seçili kanal sekmesi düzenlenir; sekmenin kendi
 * profili varsa o kanalın klipleri yalnız onun logosunu ve ayarlarını kullanır.
 */
export type StudioTab = 'gorunum' | 'abone';

export function Studio({ sub = null }: { sub?: string | null }) {
  const tabKey: StudioTab = sub === 'abone' ? 'abone' : 'gorunum';
  const { user } = useSession();
  const tab = user?.channelSlug ?? null;
  // Etkin sekmenin kapsamıyla açılır: sekmenin özel logosu/rengi varsa klipler onu
  // kullanır; Genel'de yapılan değişiklik o sekmeye yansımaz.
  const [scope, setScope] = useState<'general' | 'tab'>(tab ? 'tab' : 'general');
  const channel = scope === 'tab' ? tab : null;
  const studio = useResource(() => api.get<StudioData>(`/api/studio${query({ channel })}`), [channel]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setScope(tab ? 'tab' : 'general');
  }, [tab]);

  const createProfile = async () => {
    setBusy(true);
    try {
      await api.post('/api/studio/profile', { channel: tab });
      toast(`${tab} için özel ayar oluşturuldu — genel ayarlardan kopyalandı`, 'ok');
      await studio.reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const dropProfile = () =>
    deleteWithUndo({
      label: `${tab} özel ayarı kaldırıldı, genel ayarlara dönüldü`,
      hide: () => {},
      restore: () => void studio.reload(),
      commit: () => api.del(`/api/studio/profile/${tab}`),
      done: () => void studio.reload(),
    });

  const scopeBar = tab && (
    <section className="panel studio-scope" aria-label="Hangi ayarlar">
      <Segmented
        size="small"
        label="Kapsam"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'general', label: 'Genel' },
          { value: 'tab', label: `${tab}${studio.data?.scope.custom && scope === 'tab' ? ' · özel' : ''}` },
        ]}
      />
      {scope === 'general' ? (
        <>
          <p className="muted">Üretim kuralları (yerleşim, kadraj, altyazı, logo yeri) her zaman buradan gelir ve bütün sekmeler için ortaktır. Bir sekmeye yalnız farklı logo ve renk vermek için üstten o sekmeyi seç.</p>
          {tab && studio.data?.customTabs?.includes(tab) && (
            <p className="field-error">
              <b>{tab}</b> sekmesinin özel ayarı var: o sekmenin kliplerinde buradaki logo, renk ve abone çağrısı değil, sekmenin kendisininki kullanılır. Değiştirmek için üstten <b>{tab}</b> kapsamını seç.
            </p>
          )}
        </>
      ) : studio.data?.scope.custom ? (
        <>
          <p className="muted">
            <b>{tab}</b> kendi logosunu, renklerini ve altyazı stilini kullanıyor. Üretim kuralları (yerleşim, kadraj, altyazı) ortaktır; burada değiştirirsen her sekme için değişir.
          </p>
          <button type="button" className="btn btn-quiet btn-small" onClick={dropProfile}>
            Özel ayarı kaldır
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            <b>{tab}</b> şu an genel ayarları kullanıyor.
          </p>
          <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => void createProfile()}>
            {busy ? <Spinner size={12} /> : <Icon name="plus" size={14} />} Bu sekme için özel ayar oluştur
          </button>
        </>
      )}
    </section>
  );

  if (studio.loading && !studio.data) {
    return (
      <div className="center-pad">
        <Spinner size={24} />
      </div>
    );
  }
  if (!studio.data) return <p className="field-error">{studio.error}</p>;
  // Kapsam değişince düzenleyici sıfırdan kurulur (yerel taslaklar karışmasın).
  const tabs = <SettingsTabs current={tabKey === 'abone' ? 'abone' : 'video'} />;
  const scopedChannel = studio.data.scope.custom ? channel : null;
  if (tabKey === 'abone') {
    const b = studio.data.brand;
    return (
      <div style={{ '--brand': b.brandColor, '--accent': b.accentColor } as CSSProperties}>
        <WorkspaceHead guide="marka" title="Ayarlar" tape="" lead="Abone ol, beğen ve yorum yap animasyonu ile araya dikilen abone kesiti. Dikey ve yatay videolar için ayrı ayrı açılır." />
        {tabs}
        {scopeBar}
        <CtaPanel key={`${scopedChannel ?? 'genel'}:${studio.data.scope.custom}`} data={studio.data} channel={scopedChannel} brand={b} reload={studio.reload} />
      </div>
    );
  }
  return <StudioEditor key={`${channel ?? 'genel'}:${studio.data.scope.custom}`} data={studio.data} reload={studio.reload} scopeBar={scopeBar} tabs={tabs} channel={scopedChannel} />;
}

function StudioEditor({ data, reload, scopeBar, tabs, channel }: { data: StudioData; reload: () => void; scopeBar: React.ReactNode; tabs: React.ReactNode; channel: string | null }) {
  const [brand, setBrand] = useState(data.brand);
  const [format, setFormat] = useState<Format>('vertical');
  const [defaults, setDefaults] = useState<Record<Format, ClipOptions>>(data.defaults);
  const [output, setOutput] = useState<RecordingOutput>(data.recordingOutput);
  const [saving, setSaving] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
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

  // Dikeyde logo iki düzen için ayrı ayarlanır: ortak alanlar "Kamera + oyun"
  // düzenine, logoSingle "Tek kare" düzenine aittir. Önizleme seçilen düzeni gösterir.
  const [logoTarget, setLogoTarget] = useState<'split' | 'single'>('split');
  const singleTarget = vertical && logoTarget === 'single';
  const baseLogo = { logoPosition: opts.logoPosition, logoScale: opts.logoScale, logoOpacity: opts.logoOpacity, logoX: opts.logoX, logoY: opts.logoY };
  const logo = singleTarget && opts.logoSingle ? { ...opts, ...opts.logoSingle } : opts;
  const setLogo = (patch: Partial<typeof baseLogo>) => {
    if (singleTarget) setOpt({ logoSingle: { ...baseLogo, ...(opts.logoSingle ?? {}), ...patch } });
    else setOpt(patch);
  };
  const previewOpts = vertical ? { ...logo, composition: (logoTarget === 'single' ? 'single' : 'split') as ClipOptions['composition'] } : opts;

  return (
    <div style={style}>
      <WorkspaceHead guide="marka" title="Ayarlar" tape="" lead="Logo, renk, altyazı ve üretim kuralları burada bir kez ayarlanır; bütün üretimler (klipler, kesitler, yayınlar, bot) bunu kullanır." />
      {tabs}
      {scopeBar}

      <div className="studio-grid">
        <section className="panel studio-defaults" aria-label="Üretim varsayılanları">
          <span className="panel-tape" aria-hidden="true" />
          <header className="panel-head">
            <div>
              <h2 className="panel-title">Üretim kuralları</h2>
              <p className="panel-sub">{FORMATS.find((f) => f.value === format)!.hint}. Bütün sekmeler ve bütün üretim yolları (klipler, kesitler, yayın kesitleri, bot takibi) için ortaktır.</p>
            </div>
            <button type="button" className="btn btn-accent" disabled={saving === 'defaults'} onClick={() => save('defaults', () => api.put('/api/studio/defaults', { format, options: defaults[format] }), `${vertical ? 'Dikey' : 'Yatay'} ayarlar kaydedildi — dikey üretilen her şey buna uyar`)}>
              {saving === 'defaults' ? <Spinner /> : <Icon name="check" size={16} />} {vertical ? 'Dikey' : 'Yatay'} ayarlarını kaydet
            </button>
          </header>

          <Segmented label="Biçim" value={format} onChange={setFormat} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} />

          <div className={vertical ? 'proto-stage proto-stage-v' : 'proto-stage'}>
            <div className="proto-h-col">
              <FramePreview
                key={`${format}-${logoTarget}`}
                format={format}
                opts={previewOpts}
                logoUrl={data.logo.url}
                styleKey={styleKey}
                sampleUrl={sample}
                onLogoMove={(x, y) => setLogo({ logoPosition: 'custom', logoX: x, logoY: y })}
              />
              {!vertical && <SequenceStrip intro={data.intro} outro={data.outro} withIntro={opts.intro} withOutro={opts.outro} />}
            </div>

            <div className="proto-settings">
              <h3 className="eyebrow">Logo</h3>
              <Switch checked={opts.logo} onChange={(v) => setOpt({ logo: v })} label="Logoyu ekle" hint={data.logo.exists ? 'Önizlemede sürükle ya da aşağıdan hizala' : 'Sağdaki "Kimlik" bölümünden logo yükle'} />
              {vertical && (
                <Field label="Hangi düzen için" help={singleTarget ? (opts.logoSingle ? 'Tek karenin kendi logo ayarı var.' : 'Tek kare şimdilik Kamera + oyun ayarını kullanıyor; burada bir şey değiştirince kendi ayarı olur.') : 'Kamera + oyun düzeninin logo ayarı. Tek kare için ayrı ayar yapabilirsin.'}>
                  <div className="row-gap">
                    <Segmented
                      size="small"
                      label="Logo düzeni"
                      value={logoTarget}
                      onChange={setLogoTarget}
                      options={[
                        { value: 'split', label: 'Kamera + oyun' },
                        { value: 'single', label: 'Tek kare' },
                      ]}
                    />
                    {singleTarget && opts.logoSingle && (
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpt({ logoSingle: null })}>
                        Ortak ayara dön
                      </button>
                    )}
                  </div>
                </Field>
              )}
              <Field label={`Boyut · %${Math.round(logo.logoScale * 100)}`}>
                <input type="range" className="range" min={0.15} max={2} step={0.05} value={logo.logoScale} disabled={!opts.logo} onChange={(e) => setLogo({ logoScale: Number(e.target.value) })} />
              </Field>
              <Field label={`Görünürlük · %${Math.round(logo.logoOpacity * 100)}`}>
                <input type="range" className="range" min={0.05} max={1} step={0.05} value={logo.logoOpacity} disabled={!opts.logo} onChange={(e) => setLogo({ logoOpacity: Number(e.target.value) })} />
              </Field>
              {vertical && (
                <Field label="Yeri">
                  <Segmented
                    size="small"
                    label="Logo yeri"
                    value={logo.logoPosition}
                    onChange={(v) => setLogo(v === 'custom' ? { logoPosition: 'custom', logoX: logo.logoX ?? 0.5, logoY: logo.logoY ?? 0.1 } : { logoPosition: v })}
                    options={(
                      [
                        { value: 'seam', label: singleTarget ? 'Üst orta' : 'Kamera altı' },
                        { value: 'top-center', label: 'Üst orta' },
                        { value: 'custom', label: 'Serbest' },
                      ] as { value: ClipOptions['logoPosition']; label: string }[]
                    ).filter((o, i, arr) => arr.findIndex((x) => x.label === o.label) === i)}
                  />
                </Field>
              )}
              <Field label="Hizala" help="Kenarlarda %5 güvenli pay bırakılır. Sürüklerken merkeze, üçte birlere ve kenarlara yapışır.">
                <AlignGrid
                  disabled={!opts.logo}
                  onAlign={(col, row) => {
                    const b = logoBox(format, logo, logoAspect, vertical && !singleTarget);
                    const p = alignTo(col, row, b.w / 2, b.h / 2);
                    setLogo({ logoPosition: 'custom', logoX: Math.round(p.x * 1000) / 1000, logoY: Math.round(p.y * 1000) / 1000 });
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
              <Switch
                checked={opts.ctaAuto}
                onChange={(v) => setOpt({ ctaAuto: v })}
                label="Abone çağrısı otomatik"
                hint={vertical ? 'Animasyon başta ve sonda, abone kesiti tam ortada; tasarım Abone çağrısı sekmesinden' : 'Animasyon introdan sonra ve outrodan önce, abone kesiti tam ortada; tasarım Abone çağrısı sekmesinden'}
              />
              {vertical ? (
                <>
                  <Field label="Yerleşim" help={opts.composition === 'split' ? 'Kamera üstte, oyun altta. Kadraj çizilmişse yüz aranmaz, o kadraj kullanılır.' : opts.composition === 'auto' ? 'Yüz kamerası bulunursa kamera + oyun; bulunamazsa çizili kadraj varsa o, yoksa tek kare.' : 'Kamera aranmaz; kare odak noktasına göre kırpılır.'}>
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
                  <Field label="Kadraj: yayın alanı ve kameralar" help={opts.composition === 'single' ? 'Tek karede yalnız yayın alanı kullanılır: kutuyu daraltırsan o bölge dikey kareye alınır.' : 'Örnek bir yayın karesinde yayın alanını ve kameraları (bir ya da birkaç) işaretle; bütün otomatik üretimler bu kadrajı kullanır.'}>
                    <div className="row-gap">
                      <button type="button" className="btn btn-secondary btn-small" onClick={() => setDrawing(true)}>
                        <Icon name="crop" size={14} /> {opts.manualLayout ? 'Kadrajı düzenle' : 'Kadrajı çiz'}
                      </button>
                      {opts.manualLayout ? (
                        <>
                          <span className="status status-ready">{opts.manualLayout.cams.length ? `${opts.manualLayout.cams.length} kamera + yayın alanı çizildi` : 'Yayın alanı çizildi (kamerasız)'}</span>
                          <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpt({ manualLayout: null })}>
                            Kaldır
                          </button>
                        </>
                      ) : (
                        <span className="muted">Çizilmedi{opts.composition === 'split' ? ' — varsayılan köşe kadrajı kullanılır' : ''}</span>
                      )}
                    </div>
                  </Field>
                </>
              ) : (
                <>
                  <Switch checked={opts.intro} onChange={(v) => setOpt({ intro: v })} label="Açılış videosu ekle" hint={data.intro.exists ? `${duration(data.intro.durationSec)} başa eklenir` : 'Yüklenmedi'} disabled={!data.intro.exists} />
                  <Switch checked={opts.outro} onChange={(v) => setOpt({ outro: v })} label="Kapanış videosu ekle" hint={data.outro.exists ? `${duration(data.outro.durationSec)} sona eklenir` : 'Yüklenmedi'} disabled={!data.outro.exists} />
                </>
              )}
              {vertical && (
                <Field label={`Otomatik paylaşım eşiği · ${opts.autoPublishMinScore || 'yok'}`} help="Bot takibinde paylaşılan kliplerde beğenilme tahmini bunun altında kalanlar paylaşılmaz">
                  <input type="range" className="range" min={0} max={100} step={5} value={opts.autoPublishMinScore} onChange={(e) => setOpt({ autoPublishMinScore: Number(e.target.value) })} />
                </Field>
              )}
            </div>
          </div>
        </section>

        <aside className="ws-stack">
          <section className="panel">
            <h2 className="panel-title">Kimlik{channel ? ` · ${channel}` : ''}</h2>
            <div className="stack">
              <LogoUpload logo={data.logo} max={data.limits.logoMaxBytes} onChange={reload} channel={channel} />
              <FrameUpload frame={data.frame ?? NO_FRAME} max={data.limits.frameMaxBytes ?? 12 * 1024 * 1024} onChange={reload} channel={channel} />
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
              <button type="button" className="btn btn-primary" disabled={saving === 'brand'} onClick={() => save('brand', () => api.put('/api/studio/brand', { ...brand, channel }))}>
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

      <LayoutDialog
        open={drawing}
        layout={normalizeLayout(opts.manualLayout) ?? DEFAULT_LAYOUT}
        onClose={() => setDrawing(false)}
        // Kadraj düzeni belirler: kamera varsa bölünmüş (otomatik korunur), yoksa tek kare.
        onSubmit={(layout) => setOpt({ manualLayout: layout, composition: layout.cams.length ? (opts.composition === 'single' ? 'split' : opts.composition) : 'single' })}
      />
    </div>
  );
}

/**
 * Varsayılan kadraj çizimi: örnek kare indirilmiş bir yayından ya da kayıttan
 * alınır; yoksa bilgisayardan bir ekran görüntüsü seçilebilir.
 */
function LayoutDialog({ open, layout: initial, onClose, onSubmit }: { open: boolean; layout: ManualLayout; onClose: () => void; onSubmit: (layout: ManualLayout) => void }) {
  const [layout, setLayout] = useState(initial);
  const [sample, setSample] = useState<string | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLayout(initial);
    if (checked) return;
    setChecked(true);
    fetch('/api/studio/sample-frame', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => b && setSample(URL.createObjectURL(b)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (custom) URL.revokeObjectURL(custom);
    setCustom(URL.createObjectURL(file));
  };

  const frames: LayoutFrame[] = [{ id: 'sample', title: 'Örnek kare', imageUrl: custom ?? sample }];

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      className="modal-align"
      title="Kadrajı çiz: yayın alanı ve kameralar"
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={() => setLayout(DEFAULT_LAYOUT)}>
            Sıfırla
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => {
              onSubmit(layout);
              onClose();
            }}
          >
            <Icon name="check" size={16} /> Kadrajı kullan
          </button>
        </>
      }
    >
      <p className="muted hz-lead">
        <b>Yayın alanı</b> kutusunu oyunun/ekranın üstüne çek; <b>Kamera ekle</b> ile yüz kameralarını işaretle (kamera yoksa tek kare olur, birden çoğu üstte yan yana dizilir). Kaydettikten sonra "Dikey ayarlarını kaydet" demeyi unutma.
      </p>
      <LayoutEditor
        layout={layout}
        onChange={setLayout}
        frames={frames}
        footer={
          <label className="btn btn-secondary btn-small">
            <Icon name="image" size={14} /> {frames[0].imageUrl ? 'Başka kare seç' : 'Bilgisayardan kare seç'}
            <input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        }
      />
    </Modal>
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

export function LogoUpload({ logo: loaded, max, onChange, channel = null }: { logo: StudioData['logo']; max: number; onChange: () => void; channel?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const logo = removed ? { exists: false, url: null } : loaded;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > max) return toast(`Logo ${bytes(max)} sınırını aşıyor`, 'error');
    setBusy(true);
    try {
      await api.upload(`/api/studio/logo${query({ channel })}`, file);
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
                  commit: () => api.del(`/api/studio/logo${query({ channel })}`),
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

/**
 * Yayın çerçevesi: saydam pencereli tam kare PNG. Pencere yüklemede
 * kendiliğinden bulunur; sohbet alanı küçük resim üstünde kutu çizilerek
 * işaretlenir (çerçevede sohbet paneli yoksa kapatılır). Editörde Marka →
 * Yayın çerçevesi ile projeye eklenir.
 */
export function FrameUpload({ frame: loaded, max, onChange, channel = null }: { frame: StudioFrame; max: number; onChange: () => void; channel?: string | null }) {
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const [removed, setRemoved] = useState(false);
  const [chat, setChat] = useState<Rect>(loaded.chat ?? DEFAULT_FRAME_CHAT);
  const [chatOn, setChatOn] = useState(!!loaded.chat);
  const [dirty, setDirty] = useState(false);
  const frame = removed ? { ...loaded, exists: false, url: null } : loaded;
  const endpoint = `/api/studio/frame${query({ channel })}`;
  useEffect(() => {
    setChat(loaded.chat ?? DEFAULT_FRAME_CHAT);
    setChatOn(!!loaded.chat);
    setDirty(false);
  }, [loaded]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > max) return toast(`Çerçeve ${bytes(max)} sınırını aşıyor`, 'error');
    if (file.type !== 'image/png') return toast('Çerçeve saydam pencereli PNG olmalı', 'error');
    setBusy('upload');
    try {
      const res = await api.upload<{ window: Rect }>(endpoint, file);
      toast(`Çerçeve yüklendi — pencere ${Math.round(res.window.w * 1920)}×${Math.round(res.window.h * 1080)} px olarak bulundu`, 'ok');
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };
  const save = async (next: Rect | null) => {
    setBusy('save');
    try {
      await api.put(endpoint, { chat: next });
      toast(next ? 'Sohbet alanı kaydedildi' : 'Sohbet alanı kapatıldı', 'ok');
      setDirty(false);
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };
  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="stack">
      <div className="upload-row">
        <span className="media-well">{frame.url ? <img src={frame.url} alt="Yayın çerçevesi" /> : <Icon name="monitor" size={22} />}</span>
        <div className="upload-body">
          <b>Yayın çerçevesi</b>
          <span className="muted">{frame.exists && frame.window ? `Video penceresi ${Math.round(frame.window.w * 1920)}×${Math.round(frame.window.h * 1080)} px` : '1920×1080 PNG; video penceresi saydam bırakılmış'}</span>
          <div className="row-gap">
            <label className="btn btn-secondary btn-small">
              {busy === 'upload' ? <Spinner size={12} /> : <Icon name="upload" size={14} />} {frame.exists ? 'Değiştir' : 'Yükle'}
              <input type="file" accept="image/png" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            </label>
            {frame.exists && (
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={() =>
                  deleteWithUndo({
                    label: 'Çerçeve kaldırıldı',
                    hide: () => setRemoved(true),
                    restore: () => setRemoved(false),
                    commit: () => api.del(endpoint),
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
      {frame.exists && frame.window && (
        <>
          <Switch
            checked={chatOn}
            onChange={(v) => {
              setChatOn(v);
              if (!v) void save(null);
              else setDirty(true);
            }}
            label="Sohbet alanı"
            hint="Kick sohbeti çerçevedeki bu kutuya oturur; çerçevede sohbet paneli yoksa kapat"
            disabled={busy !== null}
          />
          {chatOn && (
            <>
              <CropEditor
                thumb={frame.url}
                crop={chat}
                onChange={(r) => {
                  setChat(r);
                  setDirty(true);
                }}
                onBegin={() => {}}
                onEnd={() => {}}
              >
                <i className="cropbox-window" style={{ left: pct(frame.window.x), top: pct(frame.window.y), width: pct(frame.window.w), height: pct(frame.window.h) }} title="Video penceresi" />
              </CropEditor>
              <div className="row-gap">
                <button type="button" className="btn btn-primary btn-small" disabled={!dirty || busy !== null} onClick={() => void save(chat)}>
                  {busy === 'save' ? <Spinner size={12} /> : null} Sohbet alanını kaydet
                </button>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => (setChat(DEFAULT_FRAME_CHAT), setDirty(true))}>
                  Varsayılan
                </button>
              </div>
              <p className="field-help">Kesikli çizgi videonun oturacağı saydam pencere; yeşil kutu sohbetin akacağı alan. Kutuyu başlığın ve ayırıcı çizginin altına, panelin içine oturt.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function MediaUpload({ kind, media: loaded, onChange, channel = null }: { kind: 'intro' | 'outro' | 'cta'; media: BrandMedia; onChange: () => void; channel?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const media = removed ? { ...loaded, exists: false, url: null } : loaded;
  const label = kind === 'intro' ? 'Açılış videosu' : kind === 'outro' ? 'Kapanış videosu' : 'Abone kesiti';
  // Abone kesiti sekme profiline (varsa) yüklenir; intro/outro bilgisayar genelidir.
  const endpoint = kind === 'cta' ? `/api/studio/cta/clip${query({ channel })}` : `/api/studio/media/${kind}`;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.upload(endpoint, file);
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
                  commit: () => api.del(endpoint),
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

/* ── Abone çağrısı ─────────────────────────────────────────────────────── */

const CTA_PLACES: { value: CtaPlace; label: string }[] = [
  { value: 'start', label: 'Başta' },
  { value: 'middle', label: 'Ortada' },
  { value: 'end', label: 'Sonda' },
];
export const CTA_STYLES: { value: CtaStyle; label: string; hint: string }[] = [
  { value: 'pill', label: 'Haplar', hint: 'Sırayla yükselen haplar' },
  { value: 'bar', label: 'Şerit', hint: 'Soldan kayan tam genişlik bant' },
  { value: 'card', label: 'Kart', hint: 'Satır satır beliren kart, altta kanal adı' },
  { value: 'cursor', label: 'Tıkla', hint: 'Beyaz şerit; imleç butona, zile, kalbe tıklar' },
  { value: 'icons', label: 'Simgeler', hint: 'Daire içinde simgeler, sırayla tıklanır' },
  { value: 'side', label: 'Yan dizi', hint: 'Sağ kenarda alt alta (TikTok tarzı)' },
];
const CTA_ACTIONS: { key: CtaAction; label: string; glyph: string }[] = [
  { key: 'like', label: 'Beğen', glyph: '❤' },
  { key: 'comment', label: 'Yorum yap', glyph: '💬' },
  { key: 'subscribe', label: 'Abone ol', glyph: '🔔' },
];

/** Seçim kartı: tasarımın küçük, döngüde oynayan CSS kopyası (gerçek çizim videoda). Editör sahnesi de bunu kullanır. */
export function CtaMini({ style, labels }: { style: CtaStyle; labels: Record<CtaAction, string> }) {
  const acts = CTA_ACTIONS.filter((a) => labels[a.key].trim());
  const order = style === 'cursor' ? [...acts].sort((a, b) => (a.key === 'subscribe' ? -1 : b.key === 'subscribe' ? 1 : 0)) : acts;
  if (style === 'cursor') {
    const sub = order.find((a) => a.key === 'subscribe');
    return (
      <span className="cta-mini cta-mini-cursor">
        <i className="m-panel">
          {sub && <b className="m-btn">{labels.subscribe}</b>}
          {sub && <em className="m-ic m-ic-bell">🔔</em>}
          {order.filter((a) => a.key !== 'subscribe').map((a) => (
            <em key={a.key} className={`m-ic m-ic-${a.key}`}>
              {a.glyph}
            </em>
          ))}
          <svg className="m-cursor" viewBox="0 0 56 90" aria-hidden="true">
            <path d="M0 0 L0 74 L19 58 L31 88 L44 82 L32 53 L55 53 Z" />
          </svg>
        </i>
      </span>
    );
  }
  if (style === 'bar') {
    return (
      <span className="cta-mini cta-mini-bar">
        <i className="m-bar">
          {order.map((a, i) => (
            <b key={a.key} style={{ animationDelay: `${0.3 + i * 0.3}s` }}>
              {a.glyph} {labels[a.key]}
            </b>
          ))}
        </i>
      </span>
    );
  }
  if (style === 'card') {
    return (
      <span className="cta-mini cta-mini-card">
        <i className="m-card">
          {order.map((a, i) => (
            <b key={a.key} style={{ animationDelay: `${0.3 + i * 0.3}s` }}>
              {a.glyph} {labels[a.key]}
            </b>
          ))}
        </i>
      </span>
    );
  }
  if (style === 'icons' || style === 'side') {
    return (
      <span className={`cta-mini cta-mini-${style}`}>
        {order.map((a, i) => (
          <i key={a.key} className={`m-circle m-circle-${a.key}`} style={{ animationDelay: `${i * 0.35}s` }}>
            {a.glyph}
            <small>{labels[a.key]}</small>
          </i>
        ))}
      </span>
    );
  }
  return (
    <span className="cta-mini cta-mini-pill">
      {order.map((a, i) => (
        <i key={a.key} className={a.key === 'subscribe' ? 'm-pill m-brand' : 'm-pill'} style={{ animationDelay: `${i * 0.4}s` }}>
          {a.glyph} {labels[a.key]}
        </i>
      ))}
    </span>
  );
}

/** Başta / Ortada / Sonda — birden çok seçilebilir, en az biri kalır. */
function PlaceChips({ value, onChange }: { value: CtaPlace[]; onChange: (next: CtaPlace[]) => void }) {
  const toggle = (p: CtaPlace) => {
    const next = value.includes(p) ? value.filter((x) => x !== p) : CTA_PLACES.map((x) => x.value).filter((x) => x === p || value.includes(x));
    if (next.length) onChange(next);
  };
  return (
    <div className="chip-row" role="group">
      {CTA_PLACES.map((p) => (
        <button key={p.value} type="button" className={value.includes(p.value) ? 'chip chip-on' : 'chip'} aria-pressed={value.includes(p.value)} onClick={() => toggle(p.value)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Abone çağrısı: marka renginde çizilen "abone ol / beğen / yorum yap"
 * animasyonu ve yüklenen kısa kesitin klibin içine dikilmesi. Sekme profili
 * varsa o sekmeye yazılır. Tasarımlar seçim kartında döngüde oynar; "Hepsini
 * oynat" gerçek çizimi (ffmpeg) her tasarım için üretip yan yana gösterir.
 */
const CTA_FORMATS: { value: CtaFormat; label: string; icon: 'vertical' | 'horizontal'; hint: string }[] = [
  { value: 'vertical', label: 'Dikey video', icon: 'vertical', hint: '9:16 · TikTok, Shorts, Reels' },
  { value: 'horizontal', label: 'Yatay video', icon: 'horizontal', hint: '16:9 · YouTube, yayın kesitleri' },
];
/** Boyut kademeleri (yüzde); kaydırıcı 30–200 arasında serbest. */
const CTA_SIZES: { value: number; label: string }[] = [
  { value: 45, label: 'Minik' },
  { value: 60, label: 'Çok küçük' },
  { value: 80, label: 'Küçük' },
  { value: 100, label: 'Orta' },
  { value: 125, label: 'Büyük' },
  { value: 150, label: 'Çok büyük' },
];
const CTA_SIZE_MIN = 30;
const CTA_SIZE_MAX = 200;
const CTA_COLORS: { key: CtaColorKey; label: string; hint: string }[] = [
  { key: 'primary', label: 'Ana renk', hint: 'Abone butonu, kart ve şerit zemini' },
  { key: 'accent', label: 'Vurgu', hint: 'Tıklanınca dönen renk, kalp, alt çizgi' },
  { key: 'text', label: 'Yazı ve simge', hint: 'Renkli zemin üstündeki yazı ve simgeler; Tıkla tasarımında açık panel' },
  { key: 'dark', label: 'Koyu zemin', hint: 'Beğen/yorum hapları, daireler ve beyaz paneldeki simgeler' },
];
const sizeLabel = (n: number) => CTA_SIZES.find((x) => x.value === n)?.label ?? `%${n}`;
export const CTA_POSITIONS: { value: CtaFormatConfig['place']; label: string }[] = [
  { value: 'top', label: 'Üst' },
  { value: 'center', label: 'Orta' },
  { value: 'bottom', label: 'Alt' },
];

/**
 * Abone çağrısı sayfası: çağrılar + tasarım solda, biçim başına (dikey/yatay)
 * açma, yer ve boyut kartları sağda; altta abone kesiti dikme.
 */
function CtaPanel({ data, channel, brand, reload }: { data: StudioData; channel: string | null; brand: StudioData['brand']; reload: () => void }) {
  const [cfg, setCfg] = useState<CtaConfig>(data.cta.config);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; format: CtaFormat } | null>(null);
  const [gallery, setGallery] = useState<{ urls: Record<string, string>; format: CtaFormat } | null>(null);
  const [galleryFormat, setGalleryFormat] = useState<CtaFormat>('vertical');
  const setOverlay = (patch: Partial<CtaConfig['overlay']>) => setCfg((c) => ({ ...c, overlay: { ...c.overlay, ...patch } }));
  const setInsert = (patch: Partial<CtaConfig['insert']>) => setCfg((c) => ({ ...c, insert: { ...c.insert, ...patch } }));
  const setFormat = (fmt: CtaFormat, patch: Partial<CtaFormatConfig>) => setCfg((c) => ({ ...c, overlay: { ...c.overlay, formats: { ...c.overlay.formats, [fmt]: { ...c.overlay.formats[fmt], ...patch } } } }));
  const setInsertFormat = (fmt: CtaFormat, on: boolean) => setCfg((c) => ({ ...c, insert: { ...c.insert, formats: { ...c.insert.formats, [fmt]: on } } }));
  const setLabel = (key: CtaAction, v: string) => setOverlay({ labels: { ...cfg.overlay.labels, [key]: v } });
  const setColor = (key: CtaColorKey, v: string | null) => setOverlay({ colors: { ...cfg.overlay.colors, [key]: v } });
  const colorFallback: Record<CtaColorKey, string> = { primary: brand.brandColor, accent: brand.accentColor, text: '#ffffff', dark: '#2a2d33' };
  // Küçük tasarım kartları ve şematik çerçeve seçilen renkleri kullanır.
  const pageStyle = {
    '--brand': cfg.overlay.colors.primary ?? brand.brandColor,
    '--accent': cfg.overlay.colors.accent ?? brand.accentColor,
    '--cta-text': cfg.overlay.colors.text ?? '#ffffff',
    '--cta-dark': cfg.overlay.colors.dark ?? '#2a2d33',
  } as CSSProperties;
  const anyLabel = CTA_ACTIONS.some((a) => cfg.overlay.labels[a.key].trim());
  const anyFormat = CTA_FORMATS.some((f) => cfg.overlay.formats[f.value].enabled);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(data.cta.config);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/api/studio/cta', { channel, config: cfg });
      toast('Abone çağrısı kaydedildi — bundan sonra üretilen videolara eklenir', 'ok');
      reload();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };
  const runPreview = async (format: CtaFormat, all: boolean) => {
    const key = `${format}:${all ? 'all' : 'one'}`;
    setRendering(key);
    try {
      const r = await api.post<{ url: string; urls: Record<string, string> }>('/api/studio/cta/preview', { channel, config: cfg, format, all, brandColor: brand.brandColor, accentColor: brand.accentColor });
      if (all) setGallery({ urls: r.urls, format });
      else setPreview({ url: r.url, format });
    } catch (err) {
      toastError(err);
    } finally {
      setRendering(null);
    }
  };

  return (
    <div className="cta-page" style={pageStyle}>
      <div className="cta-columns">
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">Animasyon{channel ? ` · ${channel}` : ''}</h2>
              <p className="panel-sub">Videonun üstünde, seçtiğin anlarda birkaç saniye oynayan abone ol · beğen · yorum yap çağrısı. Marka ve vurgu renginde çizilir.</p>
            </div>
          </header>
          <div className="stack">
            <Switch checked={cfg.overlay.enabled} onChange={(v) => setOverlay({ enabled: v })} label="Animasyonu ekle" hint="Kapalıysa hiçbir videoya çizilmez; açıkken sağdaki biçim kartlarından dikey ve yatay ayrı ayrı yönetilir" />
            <div className={cfg.overlay.enabled ? 'cta-body' : 'cta-body cta-body-off'}>
              <Field label="Çağrılar" help="Boş bıraktığın çağrı videoda görünmez.">
                <div className="cta-labels">
                  {CTA_ACTIONS.map((a) => (
                    <label key={a.key} className="cta-label">
                      <span className="muted">
                        {a.glyph} {a.label}
                      </span>
                      <input className="input" maxLength={24} value={cfg.overlay.labels[a.key]} onChange={(e) => setLabel(a.key, e.target.value)} placeholder={a.label} />
                    </label>
                  ))}
                </div>
                {!anyLabel && <p className="field-error">En az bir çağrı yazısı gerekli.</p>}
              </Field>
              <Field label="Tasarım" help="Kartlar tasarımın küçük kopyasını oynatır; gerçek çizimi görmek için biçim kartındaki önizlemeyi kullan.">
                <div className="style-grid cta-grid">
                  {CTA_STYLES.map((st) => (
                    <button key={st.value} type="button" className={cfg.overlay.style === st.value ? 'style-tile style-tile-on' : 'style-tile'} onClick={() => setOverlay({ style: st.value })} title={st.hint}>
                      <span className="cta-sample">
                        <CtaMini style={st.value} labels={cfg.overlay.labels} />
                      </span>
                      <span>{st.label}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="row-gap">
                <Segmented size="small" label="Galeri biçimi" value={galleryFormat} onChange={setGalleryFormat} options={CTA_FORMATS.map((f) => ({ value: f.value, label: f.value === 'vertical' ? 'Dikey' : 'Yatay' }))} />
                <button type="button" className="btn btn-secondary btn-small" disabled={rendering !== null || !anyLabel} onClick={() => void runPreview(galleryFormat, true)}>
                  {rendering === `${galleryFormat}:all` ? <Spinner size={12} /> : <Icon name="play" size={14} />} Hepsini oynat
                </button>
              </div>
              <div className="color-row">
                <Segmented size="small" label="Süre" value={cfg.overlay.seconds} onChange={(v) => setOverlay({ seconds: v })} options={[3, 4, 5, 6, 8].map((n) => ({ value: n, label: `${n} sn` }))} />
              </div>
              <Field label="Ne zaman görünsün" help="Ayarlar › Video'da “Abone çağrısı otomatik” açıksa bu seçim yerine animasyon başta ve sonda çizilir.">
                <PlaceChips value={cfg.overlay.at} onChange={(at) => setOverlay({ at })} />
              </Field>
              <Field label="Renkler" help="Boşken marka ve vurgu rengin, beyaz yazı ve koyu zemin kullanılır. Değiştirince soldaki kartlar da o renge döner.">
                <div className="cta-colors">
                  {CTA_COLORS.map((c) => {
                    const custom = cfg.overlay.colors[c.key];
                    const shown = custom ?? colorFallback[c.key];
                    return (
                      <div key={c.key} className={custom ? 'cta-color cta-color-on' : 'cta-color'}>
                        <label className="color-field">
                          <input type="color" value={shown} onChange={(e) => setColor(c.key, e.target.value)} />
                          <span>
                            <b>{c.label}</b>
                            <span className="muted">{custom ? custom.toUpperCase() : c.key === 'primary' ? 'Marka rengi' : c.key === 'accent' ? 'Vurgu rengi' : c.key === 'text' ? 'Beyaz' : 'Koyu gri'}</span>
                          </span>
                        </label>
                        <span className="muted cta-color-hint">{c.hint}</span>
                        {custom && (
                          <button type="button" className="btn btn-quiet btn-small" onClick={() => setColor(c.key, null)}>
                            Varsayılana dön
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Field>
            </div>
          </div>
        </section>

        <div className="ws-stack">
          {CTA_FORMATS.map((f) => {
            const fc = cfg.overlay.formats[f.value];
            const active = cfg.overlay.enabled && fc.enabled;
            return (
              <section key={f.value} className={active ? 'panel cta-format' : 'panel cta-format cta-format-off'}>
                <header className="panel-head">
                  <div>
                    <h2 className="panel-title">
                      <Icon name={f.icon} size={18} /> {f.label}
                    </h2>
                    <p className="panel-sub">{f.hint}</p>
                  </div>
                  <Switch checked={fc.enabled} onChange={(v) => setFormat(f.value, { enabled: v })} label={fc.enabled ? 'Açık' : 'Kapalı'} />
                </header>
                <div className="cta-format-body">
                  <Segmented size="small" label="Yer" value={fc.place} onChange={(v) => setFormat(f.value, { place: v })} options={CTA_POSITIONS} />
                  <div className="field">
                    <label className="field-label" htmlFor={`cta-size-${f.value}`}>
                      Boyut · <b>%{fc.size}</b> <span className="muted">({sizeLabel(fc.size)})</span>
                    </label>
                    <div className="cta-size-row">
                      <input id={`cta-size-${f.value}`} className="cta-size-slider" type="range" min={CTA_SIZE_MIN} max={CTA_SIZE_MAX} step={5} value={fc.size} onChange={(e) => setFormat(f.value, { size: Number(e.target.value) })} />
                      <span className={f.value === 'vertical' ? 'cta-size-frame cta-size-frame-v' : 'cta-size-frame cta-size-frame-h'} aria-hidden="true">
                        <i className={`cta-size-dot cta-size-${fc.place}`} style={{ width: `${Math.min(92, 22 + fc.size * 0.36)}%`, height: `${Math.min(30, 4 + fc.size * 0.1)}%` }} />
                      </span>
                    </div>
                    <div className="chip-row">
                      {CTA_SIZES.map((sz) => (
                        <button key={sz.value} type="button" className={fc.size === sz.value ? 'chip chip-on' : 'chip'} onClick={() => setFormat(f.value, { size: sz.value })}>
                          {sz.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button type="button" className="btn btn-quiet btn-small" disabled={rendering !== null || !anyLabel} onClick={() => void runPreview(f.value, false)}>
                    {rendering === `${f.value}:one` ? <Spinner size={12} /> : <Icon name="play" size={14} />} Gerçek çizimle önizle
                  </button>
                </div>
              </section>
            );
          })}
          {cfg.overlay.enabled && !anyFormat && <p className="field-error">İki biçim de kapalı; animasyon hiçbir videoya çizilmez.</p>}
        </div>
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">Abone kesiti</h2>
            <p className="panel-sub">Yüklediğin kısa videoyu (en çok {data.limits.ctaMaxSeconds} sn) klibin başına, ortasına ya da sonuna diker. Oranı uymazsa bulanık arka planla ortalanır.</p>
          </div>
          <Switch checked={cfg.insert.enabled} onChange={(v) => setInsert({ enabled: v })} label={cfg.insert.enabled ? 'Açık' : 'Kapalı'} />
        </header>
        <div className={cfg.insert.enabled ? 'cta-body cta-insert' : 'cta-body cta-insert cta-body-off'}>
          <MediaUpload kind="cta" media={data.cta.clip} onChange={reload} channel={channel} />
          <div className="cta-insert-opts">
            <Field label="Nereye" help="Ortada: klip ikiye bölünür, kesit tam ortaya girer; 10 saniyeden kısa kliplerde atlanır. Yatay videolarda açılış videosundan sonra gelir. Ayarlar › Video'da “Abone çağrısı otomatik” açıksa bu seçim yerine her videoda ortaya dikilir.">
              <PlaceChips value={cfg.insert.at} onChange={(at) => setInsert({ at })} />
            </Field>
            <Field label="Hangi videolara">
              <div className="chip-row">
                {CTA_FORMATS.map((f) => (
                  <button key={f.value} type="button" className={cfg.insert.formats[f.value] ? 'chip chip-on' : 'chip'} aria-pressed={cfg.insert.formats[f.value]} onClick={() => setInsertFormat(f.value, !cfg.insert.formats[f.value])}>
                    <Icon name={f.icon} size={13} /> {f.value === 'vertical' ? 'Dikey' : 'Yatay'}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          {!data.cta.clip.exists && <p className="field-help">Kesit yüklenmeden bu ayar bir şey yapmaz.</p>}
        </div>
      </section>

      <div className="cta-save">
        <span className="muted">{dirty ? 'Kaydedilmemiş değişiklik var.' : 'Kaydedildi; bundan sonra üretilen videolara uygulanır.'}</span>
        <button type="button" className="btn btn-primary" disabled={saving || (cfg.overlay.enabled && !anyLabel)} onClick={() => void save()}>
          {saving ? <Spinner /> : null} Abone çağrısını kaydet
        </button>
      </div>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={`Önizleme · ${preview?.format === 'vertical' ? 'dikey' : 'yatay'}`} wide={preview?.format === 'horizontal'}>
        {preview && (
          <div className={preview.format === 'vertical' ? 'stage stage-v' : 'stage stage-h'}>
            <video className="stage-video" src={preview.url} controls autoPlay muted playsInline loop />
          </div>
        )}
      </Modal>
      <Modal open={!!gallery} onClose={() => setGallery(null)} title={`Tasarımlar · ${gallery?.format === 'vertical' ? 'dikey' : 'yatay'} · hepsi gerçek çizim`} wide className="modal-gallery">
        {gallery && (
          <div className={gallery.format === 'vertical' ? 'cta-gallery cta-gallery-v' : 'cta-gallery cta-gallery-h'}>
            {CTA_STYLES.map((st) => (
              <figure key={st.value} className={cfg.overlay.style === st.value ? 'cta-pick cta-pick-on' : 'cta-pick'}>
                <video src={gallery.urls[st.value]} muted autoPlay playsInline loop />
                <figcaption>
                  <b>{st.label}</b>
                  <span className="muted">{st.hint}</span>
                  <button
                    type="button"
                    className={cfg.overlay.style === st.value ? 'btn btn-accent btn-small' : 'btn btn-secondary btn-small'}
                    onClick={() => {
                      setOverlay({ style: st.value });
                      setGallery(null);
                      toast(`${st.label} seçildi — kaydetmeyi unutma`, 'ok');
                    }}
                  >
                    {cfg.overlay.style === st.value ? 'Seçili' : 'Bunu kullan'}
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Modal>
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
