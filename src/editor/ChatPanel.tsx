import { CHAT_OFFSET_RANGE, CHAT_SIZE_RANGE, defaultChatLayer, updateChatLayer, type ChatBackground, type ChatData, type ChatLayer } from '../../shared/chat.ts';
import { FORMAT_SIZE, type Clip, type Project } from '../../shared/project.ts';
import { Icon } from '../components/Icon.tsx';
import { Field, Segmented, Spinner, Switch } from '../components/basics.tsx';
import { duration } from '../lib/format.ts';

type Update = (fn: (p: Project) => Project, record?: boolean) => void;

const BACKGROUND_OPTIONS: { value: ChatBackground; label: string }[] = [
  { value: 'none', label: 'Yok' },
  { value: 'soft', label: 'Yarı saydam' },
  { value: 'solid', label: 'Koyu' },
];

/**
 * Sağ panel: seçili sohbet PARÇASININ bağlı olduğu katmanın ayarları. Sohbet
 * parçası ne zaman görüneceğini söyler (zaman çizelgesinde kısaltılır,
 * taşınır); içerik o anda karede duran videonun yayın saatinden gelir. Burada
 * görünüm (yer, boyut, arka plan) ve eşleme kaydırması ayarlanır; aynı
 * videonun tüm sohbet parçaları bu ayarları paylaşır.
 */
export function ChatPanel({
  project,
  layer,
  clip,
  data,
  busy,
  onChange,
  onBegin,
  onEnd,
  onRefresh,
  onRemoveClip,
  onRemoveAll,
}: {
  project: Project;
  layer: ChatLayer;
  clip: Clip;
  data: ChatData | null | undefined;
  /** Çekim sürüyorsa yüzde */
  busy: number | undefined;
  onChange: Update;
  onBegin: () => void;
  onEnd: () => void;
  onRefresh: () => void;
  /** Yalnız bu parçayı kaldırır */
  onRemoveClip: () => void;
  /** Katmanı ve tüm sohbet parçalarını kaldırır */
  onRemoveAll: () => void;
}) {
  const asset = project.assets.find((a) => a.id === layer.assetId) ?? null;
  const set = (changes: Partial<Omit<ChatLayer, 'id' | 'assetId'>>, record = true) => onChange((p) => updateChatLayer(p, layer.id, changes), record);
  const pct = (v: number) => Math.round(v * 100);
  const fromPct = (v: string) => (Number(v) || 0) / 100;
  const { h: H } = FORMAT_SIZE[project.format];
  const defaults = defaultChatLayer(layer.id, layer.assetId, project.format);
  const siblings = project.clips.filter((c) => c.kind === 'chat' && c.chatId === layer.id).length;

  return (
    <aside className="epanel epanel-inspector" aria-label="Sohbet ayarları">
      <div className="epanel-head">
        <b className="epanel-title">Kick sohbeti</b>
        <span className="muted">{duration(clip.duration)}</span>
      </div>
      <div className="estack">
        <p className="field-help">
          {asset ? <b>{asset.name}</b> : 'Video'} yayınının sohbeti{data ? ` · ${data.messages.length.toLocaleString('tr-TR')} mesaj` : ''}. Bu parça {duration(clip.start)} – {duration(clip.start + clip.duration)} aralığında görünür; kenarlarından çekerek kısalt, sürükleyerek taşı. İçerik o anda karede duran videonun yayın saatiyle eşlidir; videoyu kessen de eşleme bozulmaz.
          {siblings > 1 && ` Aynı sohbetin ${siblings} parçası var; görünüm ayarları ortaktır.`}
        </p>
        {busy !== undefined ? (
          <p className="muted epanel-note">
            <Spinner size={12} /> Sohbet Kick'ten çekiliyor… %{busy}
          </p>
        ) : data === undefined ? (
          <p className="muted epanel-note">
            <Spinner size={12} /> Sohbet yükleniyor…
          </p>
        ) : data === null ? (
          <p className="notice-box">Bu videonun sohbeti henüz çekilmemiş. "Sohbeti güncelle" ile çek.</p>
        ) : (
          <p className="field-help">
            kick.com/{data.channel}
            {data.precision === 'approx' && ' · Bu kaynakta yayın saati yaklaşık bilinir; sohbet erken ya da geç kalıyorsa aşağıdaki kaydırmayla düzelt.'}
          </p>
        )}

        {layer.hides.length > 0 && (
          <div className="notice-box">
            Bu sohbette eski sürümden kalma {layer.hides.length} gizli bölüm var; artık görünürlüğü parça belirliyor.{' '}
            <button type="button" className="link" onClick={() => set({ hides: [] })}>
              Gizli bölümleri temizle
            </button>
          </div>
        )}

        <details open className="esec">
          <summary>Konum ve boyut</summary>
          <div className="egrid4">
            <Num label="X" value={pct(layer.frame.x)} onChange={(v) => set({ frame: { ...layer.frame, x: fromPct(v) } })} />
            <Num label="Y" value={pct(layer.frame.y)} onChange={(v) => set({ frame: { ...layer.frame, y: fromPct(v) } })} />
            <Num label="En" value={pct(layer.frame.w)} onChange={(v) => set({ frame: { ...layer.frame, w: Math.max(0.05, fromPct(v)) } })} />
            <Num label="Boy" value={pct(layer.frame.h)} onChange={(v) => set({ frame: { ...layer.frame, h: Math.max(0.05, fromPct(v)) } })} />
          </div>
          <Range label="Yazı boyutu" value={layer.size} min={CHAT_SIZE_RANGE.min} max={CHAT_SIZE_RANGE.max} step={0.0005} display={`${Math.round(layer.size * H)} px`} onChange={(v) => set({ size: v }, false)} onBegin={onBegin} onEnd={onEnd} />
          <Range label="Opaklık" value={layer.opacity} min={0} max={1} step={0.01} display={`%${pct(layer.opacity)}`} onChange={(v) => set({ opacity: v }, false)} onBegin={onBegin} onEnd={onEnd} />
          <p className="field-help">Kutuyu sahnede sürükleyerek taşı, kenarlarından boyutlandır. Yazı boyutu kutudan bağımsızdır. Yayın çerçevesi aralığında kutu kendiliğinden çerçevenin sohbet paneline oturur.</p>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ frame: defaults.frame, size: defaults.size })}>
            Varsayılan yere dön
          </button>
        </details>

        <details open className="esec">
          <summary>Görünüm</summary>
          <Field label="Arka plan">
            <Segmented size="small" label="Arka plan" value={layer.background} onChange={(background) => set({ background })} options={BACKGROUND_OPTIONS} />
          </Field>
          <Switch checked={layer.shadow} onChange={(v) => set({ shadow: v })} label="Yazı gölgesi" hint="Arka plansız kullanımda okunurluğu artırır" />
          <Switch checked={layer.badges} onChange={(v) => set({ badges: v })} label="Rozetler" hint="Abone, moderatör, seviye…" />
        </details>

        <details open={layer.offset !== 0 || data?.precision === 'approx'} className="esec">
          <summary>Eşleme</summary>
          <Range
            label="Kaydırma"
            value={layer.offset}
            min={-30}
            max={30}
            step={0.1}
            display={layer.offset ? `${layer.offset > 0 ? '+' : ''}${layer.offset.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn` : 'yok'}
            onChange={(v) => set({ offset: Math.min(CHAT_OFFSET_RANGE.max, Math.max(CHAT_OFFSET_RANGE.min, v)) }, false)}
            onBegin={onBegin}
            onEnd={onEnd}
          />
          <p className="field-help">Sohbet videodaki ana göre erken geliyorsa artır, geç geliyorsa azalt. Kesmelerden etkilenmez; tüm video için geçerlidir.</p>
          {layer.offset !== 0 && (
            <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ offset: 0 })}>
              Sıfırla
            </button>
          )}
        </details>

        <div className="row-gap">
          <button type="button" className="btn btn-secondary btn-small" disabled={busy !== undefined} onClick={onRefresh} title="Projede kullanılan bölümlerin sohbetini Kick'ten çek (eksik kalan kısımlar)">
            <Icon name="refresh" size={14} /> Sohbeti güncelle
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={onRemoveClip} title="Yalnız bu parçayı kaldır (Sil)">
            <Icon name="trash" size={14} /> Parçayı kaldır
          </button>
          {siblings > 1 && (
            <button type="button" className="btn btn-quiet btn-small" onClick={onRemoveAll} title="Bu videonun sohbetini bütün parçalarıyla kaldır">
              Sohbeti tümden kaldır
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <label className="numfield">
      <span>{label}</span>
      <input type="number" className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Range({ label, value, min, max, step, display, onChange, onBegin, onEnd }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void; onBegin?: () => void; onEnd?: () => void }) {
  return (
    <label className="rangefield">
      <span>
        {label} <b>{display}</b>
      </span>
      <input type="range" className="range" min={min} max={max} step={step} value={value} onPointerDown={onBegin} onPointerUp={onEnd} onKeyDown={onBegin} onKeyUp={onEnd} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
