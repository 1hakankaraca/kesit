import { useState, type CSSProperties } from 'react';
import { COLOR_PRESETS, CTA_SIZE_RANGE, FULL_RECT, NEUTRAL_COLOR, ctaPlaceOf, ctaPlacePoint, type Clip, type ColorGrade, type CtaClipStyle, type Project, type Rect, type TextStyle } from '../../shared/project.ts';
import { CropEditor } from '../components/CropEditor.tsx';
import { Icon } from '../components/Icon.tsx';
import { Field, Segmented, Spinner, Switch } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Studio } from '../lib/types.ts';
import { CTA_POSITIONS, CTA_STYLES, CtaMini } from '../screens/Studio.tsx';
import { LAYOUTS, applyLayout, assetOf, centerFrame, clipEnd, defaultCamRect, fillFrame, fitToFrame, mainClipAt, setSpeed, updateClip, type LayoutPreset } from './model.ts';

type Update = (fn: (p: Project) => Project, record?: boolean) => void;

/** Sağ panel: seçili parçanın ayarları; seçim yoksa proje ayarları. */
export function Inspector({
  project,
  clip,
  studio,
  onChange,
  onBegin,
  onEnd,
  onProject,
  onSeek,
}: {
  project: Project;
  clip: Clip | null;
  studio: Studio | null;
  onChange: Update;
  onBegin: () => void;
  onEnd: () => void;
  onProject: (changes: Partial<Project>) => void;
  onSeek: (t: number) => void;
}) {
  if (!clip) return <ProjectPanel project={project} studio={studio} onProject={onProject} />;
  return <ClipPanel key={clip.id} project={project} clip={clip} studio={studio} onChange={onChange} onBegin={onBegin} onEnd={onEnd} onSeek={onSeek} />;
}

function ProjectPanel({ project, studio, onProject }: { project: Project; studio: Studio | null; onProject: (changes: Partial<Project>) => void }) {
  const total = project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const hasCaptions = project.clips.some((c) => c.captions?.length);
  return (
    <aside className="epanel epanel-inspector" aria-label="Proje ayarları">
      <div className="epanel-head">
        <b>Proje</b>
        <span className="muted">{duration(total)}</span>
      </div>
      <div className="estack">
        <Field label="Ad" htmlFor="p-title">
          <input id="p-title" className="input" value={project.title} maxLength={120} onChange={(e) => onProject({ title: e.target.value })} />
        </Field>
        <Field label="Biçim" help="Dikey: TikTok, Reels, Shorts. Yatay: YouTube.">
          <Segmented
            size="small"
            label="Biçim"
            value={project.format}
            onChange={(format) => onProject({ format })}
            options={[
              { value: 'horizontal', label: 'Yatay 16:9' },
              { value: 'vertical', label: 'Dikey 9:16' },
            ]}
          />
        </Field>
        <h3 className="eyebrow">Altyazı</h3>
        <Switch checked={project.subtitles.enabled} onChange={(v) => onProject({ subtitles: { ...project.subtitles, enabled: v } })} label="Altyazıyı videoya bas" hint={hasCaptions ? 'Parçalardaki konuşma dökümünden' : 'Önce bir parçayı seçip "Konuşmayı yazıya dök" de'} />
        {studio && (
          <Field label="Altyazı stili">
            <div className="style-grid style-grid-compact">
              {studio.styles.map((st) => {
                const on = (project.subtitles.style ?? studio.brand.subtitleStyle) === st.key;
                return (
                  <button key={st.key} type="button" className={on ? 'style-tile style-tile-on' : 'style-tile'} onClick={() => onProject({ subtitles: { ...project.subtitles, style: st.key } })} title={st.hint}>
                    <span className={`sub-sample sub-${st.key}`}>
                      Aa <em>Bb</em>
                    </span>
                    <span>{st.label}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <Switch checked={project.subtitles.followTheme} onChange={(v) => onProject({ subtitles: { ...project.subtitles, followTheme: v } })} label="Vurgu rengi altyazıda" hint="Kapalıyken marka rengi" />
        <p className="field-help">Bir parçayı seçince burada o parçanın ayarları görünür: konum, kaynak bölge, renk, ses, yazı.</p>
      </div>
    </aside>
  );
}

function ClipPanel({ project, clip, studio, onChange, onBegin, onEnd, onSeek }: { project: Project; clip: Clip; studio: Studio | null; onChange: Update; onBegin: () => void; onEnd: () => void; onSeek: (t: number) => void }) {
  const asset = assetOf(project, clip);
  const set = (changes: Partial<Clip>, record = true) => onChange((p) => updateClip(p, clip.id, changes), record);
  const [busy, setBusy] = useState<string | null>(null);
  const pct = (v: number) => Math.round(v * 100);
  const fromPct = (v: string) => (Number(v) || 0) / 100;
  // Çağrı, kamera alanı ve yayın çerçevesi tüm kareyi kullanır; konum/boyut kutusu yoktur.
  const visual = clip.kind !== 'audio' && clip.kind !== 'cta' && clip.kind !== 'cam' && clip.kind !== 'frame' && clip.kind !== 'chat';
  const hasSound = clip.kind === 'audio' || (asset?.hasAudio && clip.kind === 'video');
  const title = clip.kind === 'text' ? 'Yazı' : clip.kind === 'cta' ? 'Abone çağrısı' : clip.kind === 'cam' ? 'Kamera alanı' : clip.kind === 'frame' ? 'Yayın çerçevesi' : asset?.name ?? 'Parça';

  const transcribe = async () => {
    if (!asset) return;
    setBusy('cc');
    try {
      const res = await api.post<{ captions: Clip['captions'] }>(`/api/projects/${project.id}/assets/${asset.id}/transcribe`, { from: clip.in, to: clip.in + clip.duration * (clip.speed || 1) });
      set({ captions: res.captions });
      onChange((p) => ({ ...p, subtitles: { ...p.subtitles, enabled: true } }), false);
      toast(res.captions?.length ? `${res.captions.length} satır yazıya döküldü` : 'Konuşma bulunamadı', res.captions?.length ? 'ok' : 'error');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const layout = async (key: LayoutPreset) => {
    if (!asset) return;
    const def = LAYOUTS.find((l) => l.key === key)!;
    setBusy('cam');
    try {
      let rect: Rect | null = null;
      if (def.needsCam) rect = (await api.post<{ rect: Rect | null }>(`/api/projects/${project.id}/assets/${asset.id}/facecam`)).rect;
      onChange((p) => applyLayout(p, clip.id, key, rect));
      if (def.needsCam) toast(rect ? 'Kamera bulundu ve ayrı katmana alındı' : 'Kamera bulunamadı; varsayılan köşe kullanıldı — kaynak bölgeyi elle ayarla', rect ? 'ok' : 'info');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="epanel epanel-inspector" aria-label="Parça ayarları">
      <div className="epanel-head">
        <b className="epanel-title">{title}</b>
        <span className="muted">{duration(clip.duration)}</span>
      </div>
      <div className="estack">
        {clip.kind === 'text' && clip.text && <TextSection text={clip.text} onChange={(t) => set({ text: { ...clip.text!, ...t } })} />}
        {clip.kind === 'cta' && clip.cta && <CtaSection cta={clip.cta} studio={studio} vertical={project.format === 'vertical'} onChange={(c) => set({ cta: { ...clip.cta!, ...c } })} onBegin={onBegin} onEnd={onEnd} />}
        {clip.kind === 'cam' && <CamSection project={project} clip={clip} busy={busy} setBusy={setBusy} onCrop={(crop, record) => set({ crop }, record)} onBegin={onBegin} onEnd={onEnd} />}
        {clip.kind === 'frame' && (
          <>
            <details open className="esec">
              <summary>Çerçeve</summary>
              <div className="eframe-row">
                <span className="eframe-thumb">{asset?.thumb ? <img src={asset.thumb} alt="" /> : <Icon name="monitor" size={18} />}</span>
                <p className="field-help">
                  Bu aralıkta ana yoldaki videonun {clip.crop.w < 0.999 || clip.crop.h < 0.999 ? 'kamera bölgesi' : 'tamamı'} çerçevenin penceresine{clip.regions?.chat ? ', Kick sohbeti sohbet paneline' : ''} oturur; parça bitince düzen eskisine döner. Aralığı zaman çizelgesinde kenarlarından çekerek değiştir. Pencere ve sohbet alanı Stüdyo → Kimlik'te ayarlanır.
                </p>
              </div>
              <RangeField label="Görünürlük" value={clip.opacity} min={0} max={1} step={0.01} display={`%${pct(clip.opacity)}`} onChange={(v) => set({ opacity: v }, false)} onBegin={onBegin} onEnd={onEnd} />
            </details>
            <CamSection project={project} clip={clip} busy={busy} setBusy={setBusy} onCrop={(crop, record) => set({ crop }, record)} onBegin={onBegin} onEnd={onEnd} windowed />
          </>
        )}

        {visual && (
          <details open className="esec">
            <summary>Konum ve boyut</summary>
            <div className="egrid4">
              <NumField label="X" value={pct(clip.frame.x)} onChange={(v) => set({ frame: { ...clip.frame, x: fromPct(v) } })} />
              <NumField label="Y" value={pct(clip.frame.y)} onChange={(v) => set({ frame: { ...clip.frame, y: fromPct(v) } })} />
              <NumField label="En" value={pct(clip.frame.w)} onChange={(v) => set({ frame: { ...clip.frame, w: Math.max(0.02, fromPct(v)) } })} />
              <NumField label="Boy" value={pct(clip.frame.h)} onChange={(v) => set({ frame: { ...clip.frame, h: Math.max(0.02, fromPct(v)) } })} />
            </div>
            {clip.kind !== 'text' && (
              <div className="row-gap pad-top-s">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => onChange((p) => fillFrame(p, clip.id))} title="Kareyi doldur, fazlalığı kırp">
                  <Icon name="monitor" size={14} /> Doldur
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => onChange((p) => fitToFrame(p, clip.id))} title="Tamamı görünsün">
                  <Icon name="fit" size={14} /> Sığdır
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => onChange((p) => centerFrame(p, clip.id))}>
                  <Icon name="move" size={14} /> Ortala
                </button>
              </div>
            )}
            <RangeField label="Görünürlük" value={clip.opacity} min={0} max={1} step={0.01} display={`%${pct(clip.opacity)}`} onChange={(v) => set({ opacity: v }, false)} onBegin={onBegin} onEnd={onEnd} />
          </details>
        )}

        {clip.kind === 'video' && (
          <div className="esec esec-cta">
            <span className="eyebrow">Düzen</span>
            <div className="row-gap">
              {LAYOUTS.filter((l) => !l.vertical || project.format === 'vertical').map((l) => (
                <button key={l.key} type="button" className={l.needsCam ? 'btn btn-accent btn-small' : 'btn btn-secondary btn-small'} disabled={!!busy} onClick={() => void layout(l.key)} title={l.hint}>
                  {busy === 'cam' && l.needsCam ? <Spinner size={12} /> : l.needsCam ? <Icon name="camera" size={14} /> : null} {l.label}
                </button>
              ))}
            </div>
            <p className="field-help">Kamera düzenleri yüz kamerasını bulup ayrı katmana alır; sonra her parçayı ayrı taşıyıp boyutlarsın.</p>
          </div>
        )}

        {(clip.kind === 'video' || clip.kind === 'audio') && (
          <details open className="esec">
            <summary>Hız ve yumuşatma</summary>
            <div className="row-gap">
              {[0.5, 0.75, 1, 1.5, 2, 3].map((v) => (
                <button key={v} type="button" className={Math.abs(clip.speed - v) < 0.001 ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'} onClick={() => onChange((p) => setSpeed(p, clip.id, v))}>
                  {v}x
                </button>
              ))}
            </div>
            <RangeField label="Hız" value={clip.speed} min={0.25} max={4} step={0.05} display={`${clip.speed.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}x`} onChange={(v) => onChange((p) => setSpeed(p, clip.id, v), false)} onBegin={onBegin} onEnd={onEnd} />
            <div className="egrid2">
              <RangeField label="Giriş yumuşatma" value={clip.fadeIn} min={0} max={3} step={0.1} display={clip.fadeIn ? `${clip.fadeIn.toLocaleString('tr-TR')} sn` : 'yok'} onChange={(v) => set({ fadeIn: v }, false)} onBegin={onBegin} onEnd={onEnd} />
              <RangeField label="Çıkış yumuşatma" value={clip.fadeOut} min={0} max={3} step={0.1} display={clip.fadeOut ? `${clip.fadeOut.toLocaleString('tr-TR')} sn` : 'yok'} onChange={(v) => set({ fadeOut: v }, false)} onBegin={onBegin} onEnd={onEnd} />
            </div>
          </details>
        )}
        {(clip.kind === 'text' || clip.kind === 'image' || clip.kind === 'cam' || clip.kind === 'frame') && (
          <details className="esec">
            <summary>Yumuşatma</summary>
            <div className="egrid2">
              <RangeField label="Giriş" value={clip.fadeIn} min={0} max={3} step={0.1} display={clip.fadeIn ? `${clip.fadeIn.toLocaleString('tr-TR')} sn` : 'yok'} onChange={(v) => set({ fadeIn: v }, false)} onBegin={onBegin} onEnd={onEnd} />
              <RangeField label="Çıkış" value={clip.fadeOut} min={0} max={3} step={0.1} display={clip.fadeOut ? `${clip.fadeOut.toLocaleString('tr-TR')} sn` : 'yok'} onChange={(v) => set({ fadeOut: v }, false)} onBegin={onBegin} onEnd={onEnd} />
            </div>
          </details>
        )}

        {clip.kind !== 'text' && visual && asset && (
          <details className="esec">
            <summary>Kaynak bölge (kırp)</summary>
            <CropEditor thumb={asset.thumb} crop={clip.crop} onChange={(crop, record) => set({ crop }, record)} onBegin={onBegin} onEnd={onEnd} />
            <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ crop: { ...FULL_RECT } })}>
              Tümünü kullan
            </button>
          </details>
        )}

        {visual && clip.kind !== 'text' && (
          <details className="esec">
            <summary>Renk</summary>
            <div className="preset-row">
              {COLOR_PRESETS.map((pr) => (
                <button key={pr.key} type="button" className={sameColor(pr.color, clip.color) ? 'preset preset-on' : 'preset'} onClick={() => set({ color: { ...pr.color } })}>
                  <i style={{ filter: `brightness(${1 + pr.color.brightness}) contrast(${pr.color.contrast}) saturate(${pr.color.saturation}) hue-rotate(${pr.color.hue}deg)` }} />
                  {pr.label}
                </button>
              ))}
            </div>
            <RangeField label="Parlaklık" value={clip.color.brightness} min={-0.5} max={0.5} step={0.01} display={`${clip.color.brightness >= 0 ? '+' : ''}${Math.round(clip.color.brightness * 100)}`} onChange={(v) => set({ color: { ...clip.color, brightness: v } }, false)} onBegin={onBegin} onEnd={onEnd} />
            <RangeField label="Kontrast" value={clip.color.contrast} min={0.5} max={1.8} step={0.01} display={`${Math.round(clip.color.contrast * 100)}`} onChange={(v) => set({ color: { ...clip.color, contrast: v } }, false)} onBegin={onBegin} onEnd={onEnd} />
            <RangeField label="Doygunluk" value={clip.color.saturation} min={0} max={2.5} step={0.01} display={`${Math.round(clip.color.saturation * 100)}`} onChange={(v) => set({ color: { ...clip.color, saturation: v } }, false)} onBegin={onBegin} onEnd={onEnd} />
            <RangeField label="Ton" value={clip.color.hue} min={-60} max={60} step={1} display={`${clip.color.hue}°`} onChange={(v) => set({ color: { ...clip.color, hue: v } }, false)} onBegin={onBegin} onEnd={onEnd} />
            <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ color: { ...NEUTRAL_COLOR } })}>
              Sıfırla
            </button>
          </details>
        )}

        {hasSound && (
          <details open className="esec">
            <summary>Ses</summary>
            <RangeField label="Ses seviyesi" value={clip.volume} min={0} max={2} step={0.01} display={`%${pct(clip.volume)}`} onChange={(v) => set({ volume: v }, false)} onBegin={onBegin} onEnd={onEnd} />
            <Switch checked={clip.muted} onChange={(v) => set({ muted: v })} label="Sessize al" />
          </details>
        )}

        {clip.kind === 'video' && asset?.hasAudio && (
          <details open className="esec">
            <summary>Altyazı</summary>
            {clip.captions?.length ? (
              <>
                <p className="muted">{clip.captions.length} satır · {duration(clip.captions[0].start - clip.in < 0 ? 0 : clip.captions[0].start - clip.in)} – {duration(Math.min(clip.duration, clip.captions[clip.captions.length - 1].end - clip.in))}</p>
                <CaptionList clip={clip} onChange={(captions) => set({ captions })} onSeek={onSeek} />
                <div className="row-gap">
                  <button type="button" className="btn btn-quiet btn-small" disabled={!!busy} onClick={() => void transcribe()}>
                    Yeniden dök
                  </button>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ captions: null })}>
                    Kaldır
                  </button>
                </div>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void transcribe()}>
                  {busy === 'cc' ? <Spinner size={14} /> : <Icon name="sparkle" size={16} />} Konuşmayı yazıya dök
                </button>
                <p className="field-help">Bu parçanın kullanılan bölümü yazıya dökülür; proje altyazısı açılır. Satırları sonra düzenleyebilirsin.</p>
              </>
            )}
          </details>
        )}

        {clip.kind !== 'text' && asset && (
          <p className="field-help">
            Kaynak: {asset.name}
            {asset.width ? ` · ${asset.width}×${asset.height}` : ''} · {duration(clip.in)}'den başlar
          </p>
        )}
      </div>
    </aside>
  );
}

const sameColor = (a: ColorGrade, b: ColorGrade) => Math.abs(a.brightness - b.brightness) < 0.001 && Math.abs(a.contrast - b.contrast) < 0.001 && Math.abs(a.saturation - b.saturation) < 0.001 && Math.abs(a.hue - b.hue) < 0.5;

/** Abone çağrısı parçası: tasarım, yer ve boyut. Yazılar/renkler Stüdyo'dan. */
function CtaSection({ cta, studio, vertical, onChange, onBegin, onEnd }: { cta: CtaClipStyle; studio: Studio | null; vertical: boolean; onChange: (c: Partial<CtaClipStyle>) => void; onBegin: () => void; onEnd: () => void }) {
  const cfg = studio?.cta.config ?? null;
  const labels = cfg?.overlay.labels ?? { subscribe: 'Abone ol', like: 'Beğen', comment: 'Yorum yap' };
  const colors = cfg?.overlay.colors;
  const vars = {
    '--brand': colors?.primary ?? studio?.brand.brandColor ?? '#53fc18',
    '--accent': colors?.accent ?? studio?.brand.accentColor ?? '#53fc18',
    '--cta-text': colors?.text ?? '#ffffff',
    '--cta-dark': colors?.dark ?? '#2a2d33',
  } as CSSProperties;
  const fmtDefault = cfg?.overlay.formats[vertical ? 'vertical' : 'horizontal'];
  const place = ctaPlaceOf(cta);
  return (
    <details open className="esec">
      <summary>Çağrı tasarımı</summary>
      <div className="style-grid style-grid-compact" style={vars}>
        {CTA_STYLES.map((st) => (
          <button key={st.value} type="button" className={cta.style === st.value ? 'style-tile style-tile-on' : 'style-tile'} onClick={() => onChange({ style: st.value })} title={st.hint}>
            <span className="cta-sample cta-sample-small">
              <CtaMini style={st.value} labels={labels} />
            </span>
            <span>{st.label}</span>
          </button>
        ))}
      </div>
      <Segmented size="small" label="Yer" value={place ?? ('custom' as const)} onChange={(v) => v !== 'custom' && onChange(ctaPlacePoint(v))} options={place ? CTA_POSITIONS : [...CTA_POSITIONS, { value: 'custom' as const, label: 'Serbest' }]} />
      <p className="field-help">Sahnede sürükleyerek istediğin yere koy{cta.style === 'bar' ? ' (şerit tam genişlik, yalnız yukarı/aşağı)' : ''}. Konum: %{Math.round(cta.x * 100)} · %{Math.round(cta.y * 100)}</p>
      <RangeField label="Boyut" value={cta.size} min={CTA_SIZE_RANGE.min} max={CTA_SIZE_RANGE.max} step={5} display={`%${cta.size}`} onChange={(v) => onChange({ size: v })} onBegin={onBegin} onEnd={onEnd} />
      {fmtDefault && (place !== fmtDefault.place || cta.size !== fmtDefault.size || cta.style !== cfg!.overlay.style) && (
        <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange({ style: cfg!.overlay.style, ...ctaPlacePoint(fmtDefault.place), size: fmtDefault.size })}>
          Stüdyo ayarına dön
        </button>
      )}
      <p className="field-help">Parçanın süresi animasyonun süresi (2–10 sn). Yazılar ("{labels.subscribe || 'Abone ol'}" vb.) ve renkler Stüdyo › Abone çağrısı'ndan gelir; gerçek çizim dışa aktarmada basılır.</p>
    </details>
  );
}

/** Kamera alanı parçası: ana videodaki webcam bölgesi; bu aralıkta tüm kareyi (çerçevede: pencereyi) doldurur. */
function CamSection({ project, clip, busy, setBusy, onCrop, onBegin, onEnd, windowed = false }: { project: Project; clip: Clip; busy: string | null; setBusy: (v: string | null) => void; onCrop: (r: Rect, record: boolean) => void; onBegin: () => void; onEnd: () => void; windowed?: boolean }) {
  const main = mainClipAt(project, clip.start + clip.duration / 2);
  const asset = main ? assetOf(project, main) : null;
  const full = clip.crop.w >= 0.999 && clip.crop.h >= 0.999;
  const detect = async () => {
    if (!asset) return toast('Ana yolda bu aralığı kapsayan video yok', 'error');
    setBusy('cam');
    try {
      const rect = (await api.post<{ rect: Rect | null }>(`/api/projects/${project.id}/assets/${asset.id}/facecam`)).rect;
      if (rect) {
        onCrop(rect, true);
        toast('Kamera bulundu', 'ok');
      } else toast('Kamera bulunamadı — bölgeyi elle çiz', 'info');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <details open className="esec">
      <summary>{windowed ? 'Pencereye ne girsin' : 'Kamera bölgesi'}</summary>
      {windowed ? (
        <Segmented
          size="small"
          label="Pencereye ne girsin"
          value={full ? 'full' : 'cam'}
          onChange={(v) => onCrop(v === 'full' ? { ...FULL_RECT } : defaultCamRect(asset?.width || 16, asset?.height || 9), true)}
          options={[
            { value: 'cam', label: 'Kamera' },
            { value: 'full', label: 'Tüm yayın' },
          ]}
        />
      ) : (
        <p className="field-help">Bu aralıkta ana videodaki kamera bölgesi tüm kareyi doldurur; parça bitince düzen eskisine döner. Kutuyu kameranın üstüne oturt.</p>
      )}
      {windowed && full && <p className="field-help">Yayının tamamı pencereye oran bozmadan sığdırılır (fazlalık kırpılır).</p>}
      {windowed && !full && <p className="field-help">Ana videodaki kamera bölgesi çerçevenin penceresini doldurur. Kutuyu kameranın üstüne oturt.</p>}
      {(!windowed || !full) && <CropEditor thumb={asset?.thumb ?? null} crop={clip.crop} onChange={onCrop} onBegin={onBegin} onEnd={onEnd} />}
      {(!windowed || !full) && (
      <div className="row-gap">
        <button type="button" className="btn btn-secondary btn-small" disabled={!!busy || !asset} onClick={() => void detect()}>
          {busy === 'cam' ? <Spinner size={12} /> : <Icon name="camera" size={14} />} Kamerayı bul
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => onCrop(defaultCamRect(asset?.width || 16, asset?.height || 9), true)}>
          Sağ üst köşe
        </button>
      </div>
      )}
      {!asset && <p className="field-help">Ana yolda (ilk görüntü yolu) bu aralığı kapsayan bir video yok; parçayı videonun üstüne taşı.</p>}
    </details>
  );
}

function TextSection({ text, onChange }: { text: TextStyle; onChange: (t: Partial<TextStyle>) => void }) {
  return (
    <details open className="esec">
      <summary>Yazı</summary>
      <textarea className="textarea" rows={3} value={text.content} maxLength={400} onChange={(e) => onChange({ content: e.target.value })} aria-label="Yazı içeriği" />
      <Segmented
        size="small"
        label="Yazı tipi"
        value={text.font}
        onChange={(font) => onChange({ font })}
        options={[
          { value: 'display', label: 'Afiş' },
          { value: 'body', label: 'Düz' },
          { value: 'mono', label: 'Daktilo' },
        ]}
      />
      <RangeField label="Boyut" value={text.size} min={0.02} max={0.3} step={0.005} display={`%${Math.round(text.size * 100)}`} onChange={(v) => onChange({ size: v })} />
      <Segmented
        size="small"
        label="Hiza"
        value={text.align}
        onChange={(align) => onChange({ align })}
        options={[
          { value: 'left', label: 'Sol' },
          { value: 'center', label: 'Orta' },
          { value: 'right', label: 'Sağ' },
        ]}
      />
      <div className="egrid2">
        <label className="color-field">
          <input type="color" value={text.color} onChange={(e) => onChange({ color: e.target.value })} />
          <span>
            <b>Yazı rengi</b>
          </span>
        </label>
        <label className="color-field">
          <input type="color" value={text.background?.slice(0, 7) ?? '#000000'} onChange={(e) => onChange({ background: `${e.target.value}b3` })} />
          <span>
            <b>Arka plan</b>
            <button type="button" className="link" onClick={(e) => (e.preventDefault(), onChange({ background: text.background ? null : '#000000b3' }))}>
              {text.background ? 'kaldır' : 'ekle'}
            </button>
          </span>
        </label>
      </div>
      <div className="row-gap">
        <Toggle on={text.bold} label="Kalın" onClick={() => onChange({ bold: !text.bold })} />
        <Toggle on={text.italic} label="Eğik" onClick={() => onChange({ italic: !text.italic })} />
        <Toggle on={text.outline} label="Kontur" onClick={() => onChange({ outline: !text.outline })} />
      </div>
    </details>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={on ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <label className="numfield">
      <span>{label}</span>
      <input type="number" className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function RangeField({ label, value, min, max, step, display, onChange, onBegin, onEnd }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void; onBegin?: () => void; onEnd?: () => void }) {
  return (
    <label className="rangefield">
      <span>
        {label} <b>{display}</b>
      </span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onPointerDown={onBegin} onPointerUp={onEnd} onKeyDown={onBegin} onKeyUp={onEnd} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function CaptionList({ clip, onChange, onSeek }: { clip: Clip; onChange: (c: NonNullable<Clip['captions']>) => void; onSeek: (t: number) => void }) {
  const caps = clip.captions ?? [];
  const speed = clip.speed || 1;
  const inRange = caps.filter((c) => c.end > clip.in && c.start < clip.in + clip.duration * speed);
  return (
    <ul className="caplist">
      {inRange.slice(0, 200).map((c) => {
        const i = caps.indexOf(c);
        const at = clip.start + Math.max(0, c.start - clip.in) / speed;
        return (
          <li key={i}>
            <button type="button" className="caplist-time" onClick={() => onSeek(at)} title="O ana git">
              {duration(at)}
            </button>
            <input className="input" value={c.text} onChange={(e) => onChange(caps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} aria-label="Altyazı satırı" />
            <button type="button" className="btn btn-quiet btn-icon" onClick={() => onChange(caps.filter((_, j) => j !== i))} aria-label="Satırı sil">
              <Icon name="x" size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
