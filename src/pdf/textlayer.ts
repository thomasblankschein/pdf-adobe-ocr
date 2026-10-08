import fs from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";
import type { TranscribedLine } from "../llm/types";

/** Für die Textebene genügen Text und (grobe) Position der Zeilen. */
export type LineInput = Pick<TranscribedLine, "text" | "x" | "y">;
import type { PageItem } from "./pages";

// ---------------------------------------------------------------------------
// Alte Textebene entfernen: die unsichtbaren Textobjekte (BT … ET im Darstellungsmodus 3) aus den Content-Streams
// streichen. Die OCR-Ebene von Adobe besteht nur aus unsichtbarem Text neben dem Scan-Bild; Bilder, Pfade, Zustand und
// SICHTBARER Text bleiben unberührt. Der Scanner beachtet Strings, Kommentare und Inline-Bilder,
// damit "BT"/"ET" in Daten nicht fälschlich erkannt werden.
// ---------------------------------------------------------------------------

const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function skipString(buf: Buffer, i: number): number {
  let depth = 0;
  for (; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x5c) i++; // Backslash: nächstes Zeichen überspringen
    else if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
  }
  return buf.length;
}

/** Nächstes "Wort" (Operator/Zahl) ab pos; Strings, Namen, Kommentare und Klammern werden übersprungen. */
function nextWord(buf: Buffer, pos: number): { word: string; start: number; end: number } | null {
  const n = buf.length;
  let i = pos;
  while (i < n) {
    const c = buf[i];
    if (isWs(c)) i++;
    else if (c === 0x25) while (i < n && buf[i] !== 10 && buf[i] !== 13) i++;
    else if (c === 0x28) i = skipString(buf, i);
    else if (c === 0x3c && buf[i + 1] !== 0x3c) {
      while (i < n && buf[i] !== 0x3e) i++;
      i++;
    } else if (c === 0x2f) {
      i++;
      while (i < n && !isWs(buf[i]) && !isDelim(buf[i])) i++;
    } else if (isDelim(c)) i++;
    else {
      const start = i;
      while (i < n && !isWs(buf[i]) && !isDelim(buf[i])) i++;
      return { word: buf.toString("latin1", start, i), start, end: i };
    }
  }
  return null;
}

/** Ende eines Inline-Bildes (nach "EI"), Start = Position direkt nach dem Operator "ID". */
function findEndOfInlineImage(buf: Buffer, start: number): number {
  for (let k = start + 1; k + 1 < buf.length; k++) {
    if (buf[k] === 0x45 && buf[k + 1] === 0x49 && isWs(buf[k - 1]) && (k + 2 >= buf.length || isWs(buf[k + 2]))) return k + 2;
  }
  return buf.length;
}

// Textdarstellungsmodus (Tr): 3 = unsichtbar (OCR-Ebene), 7 = nur Clipping; alle anderen zeichnen sichtbar
const VISIBLE_TR = new Set([0, 1, 2, 4, 5, 6]);
const SHOW_OPERATORS = new Set(["Tj", "TJ", "'", '"']);

/**
 * Entfernt nur UNSICHTBARE Textobjekte (BT … ET, deren Zeichen alle im Darstellungsmodus 3/7 gezeichnet werden):
 * die alte OCR-Ebene. Sichtbarer Text (digital erzeugte PDF, Beschriftungen) bleibt unangetastet – sonst zerstört das
 * Neuschreiben der Textebene das Layout. Der Modus wird wie im PDF-Zustand geführt (Tr setzt ihn, q/Q sichern und
 * stellen ihn wieder her), weil er auch außerhalb des Textobjekts gesetzt werden kann.
 */
export function stripInvisibleText(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let copyFrom = 0;
  let pos = 0;
  let mode = 0;
  const saved: number[] = [];
  const setMode = (operand: string) => {
    const m = Number(operand);
    if (Number.isInteger(m)) mode = m;
  };
  let prev = "";
  for (let tok = nextWord(buf, pos); tok; tok = nextWord(buf, pos)) {
    pos = tok.end;
    if (tok.word === "q") saved.push(mode);
    else if (tok.word === "Q") mode = saved.pop() ?? mode;
    else if (tok.word === "Tr") setMode(prev);
    else if (tok.word === "ID") pos = findEndOfInlineImage(buf, pos);
    else if (tok.word === "BT") {
      let end = buf.length; // nicht abgeschlossenes Textobjekt: Rest gehört dazu
      let visible = false;
      let before = "";
      for (let t = nextWord(buf, pos); t; t = nextWord(buf, pos)) {
        pos = t.end;
        if (t.word === "ET") {
          end = t.end;
          break;
        }
        if (t.word === "Tr") setMode(before);
        else if (SHOW_OPERATORS.has(t.word) && VISIBLE_TR.has(mode)) visible = true;
        before = t.word;
      }
      if (!visible) {
        parts.push(buf.subarray(copyFrom, tok.start), Buffer.from("\n"));
        copyFrom = pos = end;
      }
    }
    prev = tok.word;
  }
  parts.push(buf.subarray(copyFrom));
  return Buffer.concat(parts);
}

const decode = (stream: PDFStream): Buffer =>
  Buffer.from(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents());

function pageContentStreams(doc: PDFDocument, page: PDFPage): PDFStream[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFArray) {
    return contents.asArray().flatMap((ref) => {
      const s = doc.context.lookup(ref);
      return s instanceof PDFStream ? [s] : [];
    });
  }
  return contents instanceof PDFStream ? [contents] : [];
}

const FORM = PDFName.of("Form");

/** Entfernt Text auch aus Form-XObjects (rekursiv), falls der Scanner den Text dort abgelegt hat. */
function stripForms(doc: PDFDocument, resources: PDFDict | undefined, seen: Set<string>, depth = 0) {
  if (!resources || depth > 5) return;
  const xobjects = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return;
  for (const [, value] of xobjects.entries()) {
    if (!(value instanceof PDFRef) || seen.has(value.tag)) continue;
    seen.add(value.tag);
    const stream = doc.context.lookup(value);
    if (!(stream instanceof PDFStream) || stream.dict.get(PDFName.of("Subtype")) !== FORM) continue;
    const original = decode(stream);
    const stripped = stripInvisibleText(original);
    if (stripped.length !== original.length) {
      const dict: Record<string, never> = {};
      for (const [k, v] of stream.dict.entries()) {
        const key = k.decodeText();
        if (key !== "Filter" && key !== "DecodeParms" && key !== "Length") dict[key] = v as never;
      }
      doc.context.assign(value, doc.context.flateStream(stripped, dict));
    }
    stripForms(doc, stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict), seen, depth + 1);
  }
}

function stripPageText(doc: PDFDocument, page: PDFPage) {
  const streams = pageContentStreams(doc, page);
  if (streams.length > 0) {
    const joined = Buffer.concat(streams.flatMap((s) => [decode(s), Buffer.from("\n")]));
    const ref = doc.context.register(doc.context.flateStream(stripInvisibleText(joined)));
    page.node.set(PDFName.Contents, ref);
  }
  stripForms(doc, page.node.Resources(), new Set());
}

// ---------------------------------------------------------------------------
// Neue Textebene schreiben: unsichtbarer Text (Render Mode 3) pro Box, horizontal so gestaucht/gedehnt,
// dass er exakt die von Adobe gefundene Boxbreite füllt (Markieren/Kopieren passt zum Scan).
// ---------------------------------------------------------------------------

let fontBytes: Buffer | undefined;
const loadFontBytes = () => (fontBytes ??= fs.readFileSync(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf")));

const num = (v: number) => (Number.isFinite(v) ? v.toFixed(4).replace(/\.?0+$/, "") || "0" : "0");

function addTextLayer(doc: PDFDocument, page: PDFPage, font: PDFFont, entries: { item: PageItem; text: string }[]) {
  const fontName = page.node.newFontDictionary(font.name, font.ref);
  const ops: string[] = ["q", "BT", "3 Tr", `${fontName.toString()} 1 Tf`];
  for (const { item, text } of entries) {
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!clean) continue;
    const natural = font.widthOfTextAtSize(clean, 1);
    const [a, b, c, d, e, f] = item.transform;
    const lenX = Math.hypot(a, b);
    if (!(natural > 0) || !(lenX > 0) || !(item.width > 0)) continue;
    const k = item.width / (natural * lenX);
    ops.push(`${num(a * k)} ${num(b * k)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} Tm`, `${font.encodeText(clean).toString()} Tj`);
  }
  ops.push("ET", "Q");
  page.node.addContentStream(doc.context.register(doc.context.flateStream(ops.join("\n"))));
}

/**
 * Erzeugt die Einträge der neuen Textebene. Nimmt eine Box durch die Korrektur den Text geleerter Nachbarn
 * derselben Zeile auf (zerschnittenes Wort zusammengeführt), erhält sie deren gemeinsame Breite – sonst würde der
 * längere Text auf die schmale Ursprungsbox gestaucht.
 */
export function buildEntries(items: PageItem[], texts: Map<number, string>): { item: PageItem; text: string }[] {
  const textOf = (i: PageItem) => texts.get(i.id) ?? i.str;
  const emptied = (i: PageItem) => i.str.trim() !== "" && textOf(i).trim() === "";
  return items.map((item, idx) => {
    const text = textOf(item);
    if (!text.trim() || text.trim().length <= item.str.trim().length) return { item, text };
    const [a, b, c, d, e, f] = item.transform;
    const lenX = Math.hypot(a, b);
    const lenY = Math.hypot(c, d);
    if (!(lenX > 0) || !(lenY > 0)) return { item, text };
    const ux = a / lenX;
    const uy = b / lenX;
    let lo = 0;
    let hi = item.width;
    const span = (n: PageItem): [number, number] | undefined => {
      const dx = n.transform[4] - e;
      const dy = n.transform[5] - f;
      if (Math.abs(-uy * dx + ux * dy) > lenY * 0.5) return undefined; // andere Zeile
      const t = ux * dx + uy * dy;
      return [t, t + n.width];
    };
    const maxGap = lenY * 1.5;
    for (let j = idx - 1; j >= 0 && emptied(items[j]); j--) {
      const s = span(items[j]);
      if (!s || lo - s[1] > maxGap) break;
      lo = Math.min(lo, s[0]);
    }
    for (let j = idx + 1; j < items.length && emptied(items[j]); j++) {
      const s = span(items[j]);
      if (!s || s[0] - hi > maxGap) break;
      hi = Math.max(hi, s[1]);
    }
    if (lo === 0 && hi === item.width) return { item, text };
    const widened: PageItem = { ...item, transform: [a, b, c, d, e + ux * lo, f + uy * lo], width: hi - lo };
    return { item: widened, text };
  });
}

export interface PageStraighten {
  /** Drehwinkel in Bogenmaß, mathematisch positiv (PDF-Koordinaten, y nach oben) */
  angle: number;
  /** Größe der Ausgabeseite in Punkten */
  widthPts: number;
  heightPts: number;
}

/**
 * Begradigt eine Seite VERLUSTFREI: Der gesamte vorhandene Seiteninhalt (Scan-Bild) wird in eine Drehmatrix gepackt,
 * es wird kein Bild neu kodiert (kein JPEG-Verlust, keine Farbunterabtastung, Auflösung und Dateigröße bleiben).
 * Gedreht wird um die Seitenmitte; die Seite erhält die Größe widthPts x heightPts (Ursprung 0/0).
 */
export function rotatePage(doc: PDFDocument, page: PDFPage, st: PageStraighten) {
  const box = page.getCropBox();
  const [c, s] = [Math.cos(st.angle), Math.sin(st.angle)];
  const [cxo, cyo] = [box.x + box.width / 2, box.y + box.height / 2];
  const [cxn, cyn] = [st.widthPts / 2, st.heightPts / 2];
  // p' = R (p - Mitte_alt) + Mitte_neu
  const e = cxn - (c * cxo - s * cyo);
  const f = cyn - (s * cxo + c * cyo);

  const raw = page.node.get(PDFName.Contents);
  const existing = raw ? doc.context.lookup(raw) : undefined;
  const refs: PDFRef[] = existing instanceof PDFArray ? (existing.asArray() as PDFRef[]) : raw instanceof PDFRef ? [raw] : [];
  const open = doc.context.register(doc.context.stream(["q", `${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(e)} ${num(f)} cm`, ""].join("\n")));
  const close = doc.context.register(doc.context.stream(["", "Q", ""].join("\n")));
  page.node.set(PDFName.Contents, doc.context.obj([open, ...refs, close]));

  page.setMediaBox(0, 0, st.widthPts, st.heightPts);
  page.setCropBox(0, 0, st.widthPts, st.heightPts);
  for (const key of ["TrimBox", "BleedBox", "ArtBox"]) page.node.delete(PDFName.of(key));
}

export type PageEdit =
  | {
      /** 0-basierter Seitenindex */
      pageIndex: number;
      /** Alle Textstücke der Seite; text = endgültiger Text (leer = Stück entfällt) */
      entries: { item: PageItem; text: string }[];
      /** Seite vorher verlustfrei begradigen; die Textstücke beziehen sich dann auf die begradigte Seite */
      straighten?: PageStraighten;
    }
  | {
      pageIndex: number;
      /** Ausweichfall: vom Modell transkribierte Zeilen ersetzen die (unbrauchbare) Textebene vollständig */
      lines: LineInput[];
    };

export interface LineLayout {
  text: string;
  x: number;
  /** Grundlinie in PDF-Nutzerkoordinaten (Ursprung unten links) */
  baseline: number;
  size: number;
  /** horizontale Stauchung (<= 1), damit die Zeile nicht über den Seitenrand ragt */
  scaleX: number;
}

/**
 * Platziert transkribierte Zeilen: Anfang und Oberkante aus den (groben) Modellangaben, Schriftgröße aus dem
 * Zeilenabstand. Ergebnis sind nur Näherungen – die Positionen stammen vom Modell, nicht von Adobe.
 */
export function layoutLines(
  lines: LineInput[],
  pageWidth: number,
  pageHeight: number,
  textWidth: (text: string, size: number) => number
): LineLayout[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const gaps = sorted.slice(1).map((l, i) => l.y - sorted[i].y).filter((g) => g > 1);
  const median = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
  const lineHeight = Math.min(40, Math.max(6, median)); // Promille der Seitenhöhe
  const size = Math.min(24, Math.max(5, (lineHeight / 1000) * pageHeight * 0.8));
  return sorted.map((l) => {
    const x = Math.min(0.9, Math.max(0.02, l.x / 1000)) * pageWidth;
    const natural = textWidth(l.text, size);
    const room = pageWidth * 0.98 - x;
    const top = (l.y / 1000) * pageHeight;
    return {
      text: l.text,
      x,
      baseline: Math.max(size, pageHeight - top - size * 0.9),
      size,
      scaleX: natural > 0 ? Math.min(1, room / natural) : 1,
    };
  });
}

function addLinesLayer(doc: PDFDocument, page: PDFPage, font: PDFFont, lines: LineInput[]) {
  const { width, height } = page.getSize();
  const fontName = page.node.newFontDictionary(font.name, font.ref);
  const ops: string[] = ["q", "BT", "3 Tr"];
  for (const l of layoutLines(lines, width, height, (t, s) => font.widthOfTextAtSize(t, s))) {
    const clean = l.text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!clean) continue;
    ops.push(
      `${fontName.toString()} ${num(l.size)} Tf`,
      `${num(l.scaleX)} 0 0 1 ${num(l.x)} ${num(l.baseline)} Tm`,
      `${font.encodeText(clean).toString()} Tj`
    );
  }
  ops.push("ET", "Q");
  page.node.addContentStream(doc.context.register(doc.context.flateStream(ops.join("\n"))));
}

/** Ersetzt auf den angegebenen Seiten die Textebene; alle anderen Seiten bleiben unverändert. */
export async function rewriteTextLayers(pdf: Uint8Array, edits: PageEdit[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFontBytes(), { subset: true });
  const pages = doc.getPages();
  for (const edit of edits) {
    const page = pages[edit.pageIndex];
    if ("entries" in edit && edit.straighten) rotatePage(doc, page, edit.straighten);
    stripPageText(doc, page);
    if ("lines" in edit) addLinesLayer(doc, page, font, edit.lines);
    else addTextLayer(doc, page, font, edit.entries);
  }
  return doc.save();
}
