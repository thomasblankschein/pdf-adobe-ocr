import { createCanvas } from "@napi-rs/canvas";
import type { PageImage, TextBox } from "../llm/types";

// pdf.js ist ein reines ES-Modul; aus dem CommonJS-Build heraus daher per dynamischem import laden.
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | undefined;
export const loadPdfJs = () => (pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

export type PdfDocumentProxy = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

/** Ein von Adobe erzeugtes Textstück inkl. der Rohdaten, die zum Neuschreiben der Textebene nötig sind. */
export interface PageItem {
  id: number;
  str: string;
  /** PDF-Transformationsmatrix des Textstücks (Nutzerkoordinaten der Seite) */
  transform: [number, number, number, number, number, number];
  /** Breite entlang der Grundlinie in Nutzerkoordinaten */
  width: number;
}

export interface PageData {
  /** Seitendrehung (/Rotate) in Grad */
  rotation: number;
  image: PageImage;
  items: PageItem[];
  boxes: TextBox[];
}

export async function openPdf(bytes: Uint8Array): Promise<{ pdf: PdfDocumentProxy; close: () => Promise<void> }> {
  const pdfjs = await loadPdfJs();
  // Kopie übergeben: pdf.js kann den übergebenen Puffer an den Worker abgeben
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  return { pdf: await task.promise, close: () => task.destroy() };
}

const applyTransform = (m: number[], x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** Rendert die Seite als JPEG (lange Kante ≈ maxPx) und liest die Textboxen der vorhandenen Textebene. */
export async function extractPage(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  maxPx: number,
  jpegQuality = 85
): Promise<PageData> {
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(0.5, maxPx / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    const canvas = createCanvas(width, height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
      background: "white",
    }).promise;
    const jpeg = await canvas.encode("jpeg", jpegQuality);

    const content = await page.getTextContent();
    const items: PageItem[] = [];
    const boxes: TextBox[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || raw.str.trim() === "") continue;
      const [a, b, c, d, e, f] = raw.transform as number[];
      const lenX = Math.hypot(a, b) || 1;
      const lenY = Math.hypot(c, d) || 1;
      // Eckpunkte der Box (Grundlinienanfang, -ende, Oberkante) in Seitenbild-Koordinaten (Rotation berücksichtigt)
      const corners = [
        [e, f],
        [e + (a / lenX) * raw.width, f + (b / lenX) * raw.width],
        [e + (c / lenY) * raw.height, f + (d / lenY) * raw.height],
        [e + (a / lenX) * raw.width + (c / lenY) * raw.height, f + (b / lenX) * raw.width + (d / lenY) * raw.height],
      ].map(([x, y]) => applyTransform(base.transform, x, y));
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const id = items.length;
      items.push({ id, str: raw.str, transform: [a, b, c, d, e, f], width: raw.width });
      boxes.push({
        id,
        text: raw.str,
        x: Math.round((x0 / base.width) * 1000),
        y: Math.round((y0 / base.height) * 1000),
        w: Math.max(1, Math.round(((Math.max(...xs) - x0) / base.width) * 1000)),
        h: Math.max(1, Math.round(((Math.max(...ys) - y0) / base.height) * 1000)),
      });
    }
    return { rotation: ((page.rotate % 360) + 360) % 360, image: { jpeg, width, height }, items, boxes };
  } finally {
    page.cleanup();
  }
}
