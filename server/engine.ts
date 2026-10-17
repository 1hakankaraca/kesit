/**
 * Klip motoruna (server/engine — LivoBot'tan taşınan CommonJS modüller) tek
 * giriş noktası. Motor tipsiz JavaScript olduğundan burada `any` ile
 * dışarı verilir; Kesit katmanı motoru yalnız bu dosya üzerinden kullanır.
 *
 * DİKKAT: Motor modülleri CLIP_OUTPUT_DIR'ı yüklenirken okur — bu dosya
 * config.ts'den SONRA içe aktarılmalıdır (server/index.ts ilk satırda
 * config'i yükler).
 */
import './config.ts';

// Dinamik import: CommonJS modülün module.exports'u `default` olarak gelir.
// Şablon yolu esbuild'in glob desteğiyle çözülür; masaüstü paketinde motor
// dosyaları sunucuyla aynı pakete girer (scripts/build-server.mjs).
const load = async (name: string): Promise<any> => (await import(`./engine/${name}.js`)).default;

export const ClipEditorManager = await load('ClipEditorManager');
export const LiveClipWatcher = await load('LiveClipWatcher');
export const StreamRecorder = await load('StreamRecorder');
export const RecordingFinalizer = await load('RecordingFinalizer');
export const RecordingEditor = await load('RecordingEditor');
export const RecordingPublisher = await load('RecordingPublisher');
export const ClipCompressor = await load('ClipCompressor');
export const VodScanManager = await load('VodScanManager');
export const ZernioPublisher = await load('ZernioPublisher');
export const IntroStore = await load('IntroStore');
export const SubtitleStyles = await load('SubtitleStyles');
export const PublishingPolicy = await load('PublishingPolicy');
export const KickClipFetcher = await load('KickClipFetcher');
export const Transcriber = await load('Transcriber');
export const FacecamDetector = await load('FacecamDetector');
export const HorizontalComposer = await load('HorizontalComposer');
export const VodSegmentFollower = await load('VodSegmentFollower');
export const { BROWSER_HEADERS, SLUG_PATTERN } = KickClipFetcher as { BROWSER_HEADERS: Record<string, string>; SLUG_PATTERN: RegExp };
