import { FORMAT_SIZE, type ProjectFormat, type Rect, type TextStyle } from '../../shared/project.ts';

export const TEXT_FONTS: Record<TextStyle['font'], string> = {
  display: "'Sofia Sans Extra Condensed Variable', 'Arial Narrow', sans-serif",
  body: "'Instrument Sans Variable', system-ui, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
};

/** Önizleme ile aynı ölçüler: iç boşluk ve satır yüksekliği (em). */
export const TEXT_PAD_X = 0.4;
export const TEXT_PAD_Y = 0.15;
export const TEXT_LINE = 1.15;
export const TEXT_RADIUS = 0.15;
export const TEXT_STROKE = 0.12;

/** Yazı özelliklerinden tekil anahtar: aynı yazı yeniden çizilmez. */
export function textRenderKey(text: TextStyle, frame: Rect, format: ProjectFormat) {
  const { w, h } = FORMAT_SIZE[format];
  const body = JSON.stringify([text, Math.round(frame.w * w), Math.round(frame.h * h), h]);
  let hash = 0;
  for (let i = 0; i < body.length; i++) hash = (hash * 31 + body.charCodeAt(i)) | 0;
  return `text:${(hash >>> 0).toString(36)}`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (const w of words.slice(1)) {
      const test = `${line} ${w}`;
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Yazı klibini çıktı çözünürlüğünde PNG'ye çizer (dışa aktarma için).
 * Önizlemedeki DOM düzeniyle aynı kurallar: kutu kadar alan, yazı boyutu
 * karenin yüksekliğine oranlı, kelime kaydırmalı, isteğe bağlı arka plan ve
 * kontur.
 */
export async function renderTextToBlob(text: TextStyle, frame: Rect, format: ProjectFormat): Promise<Blob> {
  await document.fonts.ready.catch(() => {});
  const { w: W, h: H } = FORMAT_SIZE[format];
  const width = Math.max(2, Math.round(frame.w * W));
  const height = Math.max(2, Math.round(frame.h * H));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const size = text.size * H;
  ctx.font = `${text.italic ? 'italic ' : ''}${text.bold ? '700' : '400'} ${size}px ${TEXT_FONTS[text.font]}`;
  ctx.textBaseline = 'alphabetic';
  const padX = TEXT_PAD_X * size;
  const padY = TEXT_PAD_Y * size;
  const lineH = TEXT_LINE * size;
  const lines = wrap(ctx, text.content, Math.max(size, width - padX * 2));
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  const boxW = Math.min(width, textW + padX * 2);
  const boxH = Math.min(height, lines.length * lineH + padY * 2);
  const boxX = text.align === 'left' ? 0 : text.align === 'right' ? width - boxW : (width - boxW) / 2;
  const boxY = (height - boxH) / 2;

  if (text.background) {
    ctx.fillStyle = text.background;
    const r = TEXT_RADIUS * size;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, r);
    ctx.fill();
  }

  ctx.textAlign = text.align;
  const tx = text.align === 'left' ? boxX + padX : text.align === 'right' ? boxX + boxW - padX : boxX + boxW / 2;
  // Satır içi taban çizgisi: satır yüksekliğinin ~%80'i.
  lines.forEach((line, i) => {
    const y = boxY + padY + i * lineH + lineH * 0.8;
    if (text.outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = TEXT_STROKE * size;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(line, tx, y);
    }
    ctx.fillStyle = text.color;
    ctx.fillText(line, tx, y);
  });

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Yazı çizilemedi'))), 'image/png'));
}
