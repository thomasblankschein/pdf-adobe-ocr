import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { PageImage, TextBox } from "../llm/types";
import { measureSkew } from "./deskew";
import { flattenBackground } from "./quality";

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
  // Ohne wasmUrl kann pdf.js JBIG2-/JPEG2000-Bilder nicht dekodieren: solche Scans würden leer gerendert und das
  // Modell sähe eine weiße Seite. Die Datenverzeichnisse liegen im Paket (Pfad mit abschließendem Schrägstrich).
  const dir = (name: string) => path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), name).split(path.sep).join("/") + "/";
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    wasmUrl: dir("wasm"),
    iccUrl: dir("iccs"),
    standardFontDataUrl: dir("standard_fonts"),
  });
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

export interface OcrPage {
  /** Seitenbild (PNG) für die Texterkennung */
  png: Buffer;
  /** erkannte und ausgeglichene Schräglage in Grad (0 = keine) */
  skew: number;
  /**
   * Nur im Modus "straighten" bei erkannter Schräglage: die begradigte Seite als JPEG mit Seitengröße in Punkten.
   * Sie ersetzt die Originalseite; die Textstücke von toItem beziehen sich dann auf diese (unrotierte) Seite.
   */
  straightened?: { jpeg: Buffer; widthPts: number; heightPts: number };
  /** Rechnet eine erkannte Zeile (Pixel des Bilds) in ein Textstück in PDF-Nutzerkoordinaten um */
  toItem(line: { x: number; y: number; w: number; h: number }, id: number): PageItem;
}

export interface OcrRenderOptions {
  /** > 0: Schräglage bis zu dieser Gradzahl erkennen und ausgleichen */
  deskewMaxDegrees?: number;
  /**
   * false (Standard): nur das Erkennungsbild wird begradigt, Original und Textebene bleiben schräg passend.
   * true: die Seite wird begradigt ausgegeben (Bild gedreht, Ränder weiß aufgefüllt, Seitengröße bleibt).
   */
  straighten?: boolean;
  /** Papierhintergrund fürs Erkennungsbild herausrechnen (farbiges Papier); die Ausgabe bleibt unverändert */
  flatten?: boolean;
  /** JPEG-Qualität der begradigten Seite (1-100) */
  jpegQuality?: number;
}

/** Rendert eine Seite mit der gewünschten Auflösung für externe Texterkennung (lange Kante höchstens 5000 px). */
export async function renderPageForOcr(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  dpi: number,
  options: OcrRenderOptions = {}
): Promise<OcrPage> {
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(dpi / 72, 5000 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "white" }).promise;

    const [W, H] = [canvas.width, canvas.height];
    const maxDeg = options.deskewMaxDegrees ?? 0;
    const measured =
      maxDeg > 0 ? measureSkew({ data: canvas.getContext("2d").getImageData(0, 0, W, H).data, width: W, height: H, stride: 4 }, maxDeg) : { degrees: 0 };
    const skew = measured.degrees;
    const rad = (skew * Math.PI) / 180;
    const [sin, cos] = [Math.sin(rad), Math.cos(rad)];
    const straighten = skew !== 0 && options.straighten === true;

    let target = canvas;
    if (skew !== 0) {
      // um -skew drehen. Die Zeichenfläche wächst, wenn sonst Tinte abgeschnitten würde (immer beim reinen Erkennungsbild);
      // passt der gedrehte Inhalt in die Seite, bleibt bei begradigter Ausgabe die Seitengröße
      const expanded: [number, number] = [Math.ceil(W * Math.abs(cos) + H * Math.abs(sin)), Math.ceil(W * Math.abs(sin) + H * Math.abs(cos))];
      const b = measured.bounds;
      const fits = !!b && b.x0 >= 4 && b.x1 <= W - 4 && b.y0 >= 4 && b.y1 <= H - 4;
      const [W2, H2] = straighten && fits ? [W, H] : expanded;
      target = createCanvas(W2, H2);
      const ctx = target.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W2, H2);
      ctx.translate(W2 / 2, H2 / 2);
      ctx.rotate(-rad);
      ctx.drawImage(canvas, -W / 2, -H / 2);
    }
    const png = await (options.flatten ? flattenBackground(target) : target).encode("png");
    const straightened = straighten
      ? { jpeg: await target.encode("jpeg", options.jpegQuality ?? 85), widthPts: target.width / scale, heightPts: target.height / scale }
      : undefined;

    // Bildpunkt des begradigten Erkennungsbilds -> Bildpunkt der Originalseite (Drehung um +skew um die Bildmitte)
    const back = (x: number, y: number): [number, number] => {
      if (skew === 0) return [x, y];
      const [dx, dy] = [x - target.width / 2, y - target.height / 2];
      return [W / 2 + dx * cos - dy * sin, H / 2 + dx * sin + dy * cos];
    };
    // Bildpunkt -> PDF-Punkt: bei begradigter Ausgabe auf der neuen, unrotierten Seite; sonst auf der Originalseite
    const toPdf = (x: number, y: number): [number, number] =>
      straightened ? [x / scale, straightened.heightPts - y / scale] : (viewport.convertToPdfPoint(...back(x, y)) as [number, number]);
    return {
      png,
      skew,
      straightened,
      toItem(line, id) {
        // Grundlinie etwa bei 80 % der Zeilenhöhe; die Schriftgröße reicht von dort bis zur Oberkante der Zeile
        const yBase = line.y + line.h * 0.8;
        const [x0, y0] = toPdf(line.x, yBase);
        const [x1, y1] = toPdf(line.x + line.w, yBase);
        const width = Math.hypot(x1 - x0, y1 - y0) || 1;
        const [ux, uy] = [(x1 - x0) / width, (y1 - y0) / width];
        const fontSize = (line.h * 0.8) / scale;
        return { id, str: "", transform: [ux * fontSize, uy * fontSize, -uy * fontSize, ux * fontSize, x0, y0], width };
      },
    };
  } finally {
    page.cleanup();
  }
}
