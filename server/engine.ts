/**
 * Klip motoruna (server/engine — LivoBot'tan taşınan CommonJS modüller) tek
 * giriş noktası. Motor tipsiz JavaScript olduğundan burada `any` ile
 * dışarı verilir; Kesit katmanı motoru yalnız bu dosya üzerinden kullanır.
 *
 * DİKKAT: Motor modülleri CLIP_OUTPUT_DIR'ı yüklenirken okur — bu dosya
 * config.ts'den SONRA içe aktarılmalıdır (server/index.ts ilk satırda
 * config'i yükler).
 */
import { createRequire } from 'node:module';
import './config.ts';

const require = createRequire(import.meta.url);
const load = (name: string): any => require(`./engine/${name}.js`);

export const ClipEditorManager = load('ClipEditorManager');
export const LiveClipWatcher = load('LiveClipWatcher');
export const StreamRecorder = load('StreamRecorder');
export const RecordingFinalizer = load('RecordingFinalizer');
export const RecordingEditor = load('RecordingEditor');
export const RecordingPublisher = load('RecordingPublisher');
export const ClipCompressor = load('ClipCompressor');
export const VodScanManager = load('VodScanManager');
export const ZernioPublisher = load('ZernioPublisher');
export const IntroStore = load('IntroStore');
export const SubtitleStyles = load('SubtitleStyles');
export const PublishingPolicy = load('PublishingPolicy');
export const KickClipFetcher = load('KickClipFetcher');
export const Transcriber = load('Transcriber');
export const FacecamDetector = load('FacecamDetector');
export const HorizontalComposer = load('HorizontalComposer');
export const { BROWSER_HEADERS, SLUG_PATTERN } = KickClipFetcher as { BROWSER_HEADERS: Record<string, string>; SLUG_PATTERN: RegExp };
