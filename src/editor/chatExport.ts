import { CHAT_PAGE_MAX_HEIGHT, CHAT_PLAN_MAX_ROWS, chatPlanKey, lastIndexAt, missingChatRanges, neededChatRanges, type ChatData, type ChatLayer, type ChatRenderPlan, type ChatSegment } from '../../shared/chat.ts';
import { effectiveChatKeySuffix, effectiveChatLayers, effectiveChatSegments, type EffectiveChat } from '../../shared/frame.ts';
import type { Project } from '../../shared/project.ts';
import { canvasMeasure, chatFontsReady, chatMetrics, drawChatBackground, drawChatRow, layoutChatRow, maxChatRows, type ChatImages, type ChatRowLayout, type LayoutEnv } from './chatRender.ts';
import type { ChatStore } from './useChat.ts';

/** Son yüklenen planın özeti: proje:katman → imza. Değişmediyse yeniden çizilip yüklenmez. */
const uploaded = new Map<string, string>();

const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Sohbet sayfası çizilemedi'))), 'image/png'));

async function uploadPage(projectId: number, chatId: string, name: number | 'bg', canvas: HTMLCanvasElement) {
  const res = await fetch(`/api/projects/${projectId}/chat-render/${chatId}/page/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/png' }, body: await toPng(canvas) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Sohbet sayfası yüklenemedi');
}

/** Dışa aktarmada görünebilecek mesajların sıraları (her bölüm için: öncesinden kutuyu dolduracak kadar + bölüm boyunca gelenler). */
export function neededMessageIndices(segments: readonly ChatSegment[], layer: Pick<ChatLayer, 'offset'>, data: Pick<ChatData, 'messages'>, maxRows: number): number[] {
  const want = new Set<number>();
  for (const seg of segments) {
    const srcEnd = seg.src + (seg.end - seg.start) * seg.speed;
    const first = Math.max(0, lastIndexAt(data.messages, seg.src - layer.offset) - maxRows);
    const last = lastIndexAt(data.messages, srcEnd - layer.offset);
    for (let i = first; i <= last; i++) want.add(i);
  }
  return [...want].sort((a, b) => a - b);
}

/**
 * Bir sohbet katmanını dışa aktarmaya hazırlar: gereken mesajları çıktı
 * çözünürlüğünde satır satır çizer, satırları uzun sayfalara dizip yükler ve
 * planı gönderir. Sunucu kareleri bu satırlardan derler.
 */
export async function prepareChatRender(projectId: number, project: Project, eff: EffectiveChat, data: ChatData, images: ChatImages, onProgress?: (text: string) => void): Promise<void> {
  const { layer } = eff;
  const m = chatMetrics(layer, project.format);
  const indices = neededMessageIndices(effectiveChatSegments(project, eff), layer, data, maxChatRows(m));
  if (indices.length > CHAT_PLAN_MAX_ROWS) throw new Error('Bu projede sohbet çok uzun — videoyu kısalt ya da sohbeti bazı bölümlerde gizle');
  // Anahtar zaman kısıtını da taşır: çerçeve parçası oynayınca plan yenilenir.
  const key = chatPlanKey(layer, project.format) + effectiveChatKeySuffix(eff);
  const signature = JSON.stringify([key, data.fetchedAt, data.messages.length, indices.length, indices[0] ?? -1, indices[indices.length - 1] ?? -1]);
  const memo = `${projectId}:${layer.id}`;
  if (uploaded.get(memo) === signature) return;

  await chatFontsReady(m.font);
  const env: LayoutEnv = { measure: canvasMeasure, aspect: images.aspect, subBadges: data.subBadges, badges: layer.badges };
  // Önce görseller: emote oranı satır kırılımını etkiler, bu yüzden yerleşimden önce yüklenir.
  const urls = new Set<string>();
  for (const i of indices) for (const u of layoutChatRow(data.messages[i], m, env).images) urls.add(u);
  onProgress?.('Sohbet görselleri yükleniyor…');
  await images.loadAll(urls, (done, total) => total > 40 && done % 20 === 0 && onProgress?.(`Sohbet görselleri yükleniyor… ${done}/${total}`));

  const rows: ChatRenderPlan['rows'] = [];
  let page = 0;
  let canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d')!;
  let queue: { layout: ChatRowLayout; y: number }[] = [];
  let used = 0;
  const flush = async () => {
    if (!queue.length) return;
    canvas.width = m.width;
    canvas.height = used;
    ctx = canvas.getContext('2d')!;
    for (const q of queue) drawChatRow(ctx, q.layout, q.y, images, layer.shadow);
    await uploadPage(projectId, layer.id, page, canvas);
    page++;
    queue = [];
    used = 0;
    canvas = document.createElement('canvas');
  };
  for (let n = 0; n < indices.length; n++) {
    const msg = data.messages[indices[n]];
    const layout = layoutChatRow(msg, m, env);
    const h = Math.min(layout.height, m.height);
    if (used + h > CHAT_PAGE_MAX_HEIGHT) {
      onProgress?.(`Sohbet hazırlanıyor… %${Math.round((n / indices.length) * 100)}`);
      await flush();
    }
    queue.push({ layout, y: used });
    rows.push([Math.round((msg.t + layer.offset) * 100) / 100, page, used, h]);
    used += h;
  }
  await flush();

  const hasBackground = layer.background !== 'none';
  if (hasBackground) {
    const bg = document.createElement('canvas');
    bg.width = m.width;
    bg.height = m.height;
    drawChatBackground(bg.getContext('2d')!, m, layer.background);
    await uploadPage(projectId, layer.id, 'bg', bg);
  }
  const plan: ChatRenderPlan = { chatId: layer.id, x: m.x, y: m.y, width: m.width, height: m.height, padY: m.padY, opacity: layer.opacity, hasBackground, pages: page, rows, key };
  // Plan büyük olabilir (binlerce satır): `keepalive` isteklerinin 64 KB gövde sınırına takılmaması için düz fetch.
  const res = await fetch(`/api/projects/${projectId}/chat-render/${layer.id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Sohbet planı yüklenemedi');
  uploaded.set(memo, signature);
}

/**
 * Dışa aktarmadan önce projedeki tüm sohbet katmanlarını hazırlar: kullanılan
 * bölümlerin sohbeti eksikse çeker, sonra satırları yükler.
 */
export async function prepareChats(projectId: number, project: Project, chat: ChatStore, onProgress?: (text: string) => void) {
  // Çerçeve aralıklarında sohbet panele oturur; o aralıklar türetilmiş katman olarak ayrı plan alır.
  for (const eff of effectiveChatLayers(project)) {
    const { layer } = eff;
    if (!effectiveChatSegments(project, eff).length || layer.opacity <= 0) continue;
    let data = chat.data[layer.assetId] ?? null;
    const needed = neededChatRanges(project, layer.assetId);
    if (!data || missingChatRanges(needed, data.ranges).length) {
      onProgress?.('Sohbet çekiliyor…');
      data = await chat.ensure(layer.assetId, needed);
    }
    await prepareChatRender(projectId, project, eff, data, chat.images, onProgress);
  }
}
