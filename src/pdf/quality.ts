import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PageItem } from "./pages";

export interface LayerQuality {
  /** Zeichen aller Textstücke ohne Leerraum */
  chars: number;
  /** Anteil der Zeichen, die zu plausiblen Wörtern gehören (0..1) */
  plausibleShare: number;
}

// Ein Wort ist plausibel, wenn es überwiegend aus Buchstaben/Ziffern besteht und mindestens zwei davon hat.
// Rauschen, das die OCR-Engine als "Text" liest, besteht dagegen aus Satzzeichen und Einzelzeichen (~'ite;'$.::N¾;!?J;{~).
function isPlausibleWord(token: string): boolean {
  const alnum = (token.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return alnum >= 2 && alnum / token.length >= 0.7;
}

export function layerQuality(items: PageItem[]): LayerQuality {
  let chars = 0;
  let plausible = 0;
  for (const item of items) {
    for (const token of item.str.split(/\s+/)) {
      if (!token) continue;
      chars += token.length;
      if (isPlausibleWord(token)) plausible += token.length;
    }
  }
  return { chars, plausibleShare: chars === 0 ? 0 : plausible / chars };
}

/**
 * true, wenn Adobes Textebene der Seite erkennbar Müll ist (kaum plausible Wörter, aber genug "Text"),
 * etwa bei stark verblassten Kassenbons. Dann helfen Korrekturen einzelner Boxen nicht: die eigentliche
 * Schrift hat gar keine Boxen, und die Seite muss vollständig neu transkribiert werden.
 */
export function isJunkLayer(items: PageItem[], minChars = 40, maxPlausibleShare = 0.5): boolean {
  const q = layerQuality(items);
  return q.chars >= minChars && q.plausibleShare < maxPlausibleShare;
}

/**
 * Grobe Prüfung, ob ein Seitenbild überhaupt Inhalt hat (Streuung der Helligkeit im verkleinerten Bild).
 * Verhindert, dass leere Rückseiten ohne erkannten Text an das Modell geschickt werden.
 */
export async function pageHasInk(jpeg: Buffer, minStdDev = 12): Promise<boolean> {
  const img = await loadImage(jpeg);
  const w = 200;
  const h = Math.max(1, Math.round((w * img.height) / img.width));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  let sumSq = 0;
  const n = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean)) > minStdDev;
}

/**
 * Macht verblasste, verrauschte Scans lesbarer, bevor sie zur Transkription an das Modell gehen: Rauschen dämpfen
 * (3x3-Mittel), den Papierhintergrund blockweise schätzen und herausrechnen, Tinte kräftig, Papier weiß.
 * Wird nur im Ausweichfall verwendet (Seiten, bei denen Adobe nichts Brauchbares gefunden hat).
 */
export async function enhanceForReading(jpeg: Buffer): Promise<Buffer> {
  const img = await loadImage(jpeg);
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const src = ctx.getImageData(0, 0, W, H).data;

  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];

  const smooth = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += gray[(y + dy) * W + x + dx];
      smooth[y * W + x] = sum / 9;
    }
  }

  // Papierhelligkeit je Block (90. Perzentil), damit Schatten und Vergilbung nicht als Tinte zählen
  const B = 32;
  const bw = Math.ceil(W / B);
  const bh = Math.ceil(H / B);
  const paper = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const vals: number[] = [];
      for (let y = by * B; y < Math.min(H, (by + 1) * B); y++) {
        for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x++) vals.push(smooth[y * W + x]);
      }
      vals.sort((a, b) => a - b);
      paper[by * bw + bx] = vals[Math.floor(vals.length * 0.9)] || 255;
    }
  }

  const out = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ratio = Math.min(1, Math.max(0, smooth[y * W + x] / paper[Math.floor(y / B) * bw + Math.floor(x / B)]));
      const v = Math.round(255 * Math.pow(Math.max(0, (ratio - 0.72) / 0.28), 1.4));
      const i = (y * W + x) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.encode("jpeg", 90);
}
