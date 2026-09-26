import { spawn } from "node:child_process";
import os from "node:os";
import { logger } from "./logger";
import { PDFDocument } from "pdf-lib";
import { openPdf, renderPageForOcr, type OcrPage } from "./pdf/pages";
import { rewriteTextLayers, type PageEdit } from "./pdf/textlayer";

/**
 * OCR ohne Adobe: Tesseract liefert nur Zeilen und ihre Positionen, den Text korrigiert danach (wie beim Adobe-Weg)
 * das LLM. Das Ergebnis ist die Original-PDF mit unsichtbarer Textebene; Bild und Seiten bleiben unverändert.
 */

/** Eine von Tesseract gefundene Textzeile in Pixeln des gerenderten Seitenbilds (Ursprung oben links). */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** mittlere Wortsicherheit 0–100 */
  conf: number;
}

interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  conf: number;
}

/** Ab diesem Vielfachen der Zeilenhöhe zwischen zwei Wörtern beginnt eine neue Spalte (Tesseract verbindet Spalten oft zu einer Zeile). */
const COLUMN_GAP = 2;

function toLine(words: Word[]): OcrLine {
  const x0 = Math.min(...words.map((w) => w.x0));
  const y0 = Math.min(...words.map((w) => w.y0));
  return {
    text: words.map((w) => w.text).join(" "),
    x: x0,
    y: y0,
    w: Math.max(...words.map((w) => w.x1)) - x0,
    h: Math.max(...words.map((w) => w.y1)) - y0,
    conf: words.reduce((a, w) => a + w.conf, 0) / words.length,
  };
}

/**
 * Wandelt die TSV-Ausgabe von Tesseract in Zeilen (Wörter derselben Block/Absatz/Zeile-Nummer zusammengefasst).
 * Wörter mit großem Abstand (Spalten, Tabellen, Adressblock neben Text) werden zu getrennten Zeilenstücken, damit
 * jede Box genau einen zusammenhängenden Text umschließt.
 */
export function parseTsv(tsv: string): OcrLine[] {
  const lines = new Map<string, Word[]>();
  for (const row of tsv.split(/\r?\n/)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue; // nur Wortzeilen (Ebene 5)
    const conf = Number(c[10]);
    const text = c.slice(11).join("\t").trim();
    if (!text || !(conf >= 0)) continue;
    const [left, top, width, height] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
    if (![left, top, width, height].every(Number.isFinite)) continue;
    const key = `${c[2]}.${c[3]}.${c[4]}`;
    const list = lines.get(key) ?? [];
    list.push({ text, x0: left, y0: top, x1: left + width, y1: top + height, conf });
    lines.set(key, list);
  }
  const out: OcrLine[] = [];
  for (const words of lines.values()) {
    const lineHeight = Math.max(...words.map((w) => w.y1 - w.y0));
    let segment: Word[] = [];
    for (const w of [...words].sort((p, q) => p.x0 - q.x0)) {
      const prev = segment[segment.length - 1];
      if (prev && w.x0 - prev.x1 > COLUMN_GAP * lineHeight) {
        out.push(toLine(segment));
        segment = [];
      }
      segment.push(w);
    }
    if (segment.length > 0) out.push(toLine(segment));
  }
  return out;
}

/** Zeilen ohne Buchstaben/Ziffern, winzige Zeilen und Zeilen ohne jede Sicherheit sind Rauschen (Flecken, Ränder). */
export function keepLine(l: OcrLine, minConf: number): boolean {
  return /[\p{L}\p{N}]/u.test(l.text) && l.h >= 4 && l.w >= 4 && l.conf >= minConf;
}

const LANG_CODES: Record<string, string> = {
  de: "deu", en: "eng", fr: "fra", es: "spa", it: "ita", nl: "nld", pt: "por", sv: "swe", da: "dan",
  fi: "fin", nb: "nor", no: "nor", pl: "pol", cs: "ces", tr: "tur", hu: "hun", ru: "rus", ro: "ron",
};

/** "de-DE" -> "deu" (Tesseract-Sprachcode); unbekannte Sprachen -> undefined. */
export function tesseractCode(locale: string): string | undefined {
  return LANG_CODES[locale.split(/[-_]/)[0].toLowerCase()];
}

/** Sprachangabe für Tesseract: TESSERACT_LANGS überschreibt alles; sonst Sprache des Requests plus Englisch, soweit installiert. */
export function pickLanguages(locale: string, installed: string[], override = process.env.TESSERACT_LANGS): string {
  if (override?.trim()) return override.trim();
  const wanted = [tesseractCode(locale), "eng"].filter((c): c is string => !!c && installed.includes(c));
  const unique = [...new Set(wanted)];
  if (unique.length > 0) return unique.join("+");
  return installed.find((l) => l !== "osd") ?? "eng";
}

function run(args: string[], input?: Buffer, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // ein Thread je Tesseract-Prozess: mehrere Seiten laufen parallel, Mehrfach-Threads würden sich nur bremsen
    const child = spawn("tesseract", args, { env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Tesseract nicht ausführbar: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`Tesseract beendet mit Code ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`));
    });
    child.stdin.on("error", () => {}); // bei früh beendetem Prozess
    child.stdin.end(input);
  });
}

let installedLanguages: Promise<string[]> | undefined;
/** Installierte Sprachdaten; wirft, wenn Tesseract fehlt. */
export function listLanguages(): Promise<string[]> {
  return (installedLanguages ??= run(["--list-langs"]).then((s) =>
    s.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean)
  ));
}

export async function tesseractVersion(): Promise<string> {
  const out = await run(["--version"]);
  return out.split(/\r?\n/)[0].trim();
}

export type Recognizer = (png: Buffer, lang: string, dpi: number) => Promise<OcrLine[]>;

const recognizeWithTesseract: Recognizer = async (png, lang, dpi) => {
  const psm = process.env.TESSERACT_PSM?.trim() || "3";
  const tsv = await run(["stdin", "stdout", "-l", lang, "--psm", psm, "--dpi", String(dpi), "tsv"], png);
  return parseTsv(tsv);
};

export interface TesseractOptions {
  /** Sprache des Requests (z. B. "de-DE") */
  locale: string;
  /** Auflösung, mit der die Seiten für die Erkennung gerendert werden */
  dpi?: number;
  /** Schräglage je Seite erkennen und ausgleichen (entspricht type=deskew) */
  deskew?: boolean;
  /**
   * Mit deskew: die Seite begradigt ausgeben (wie bei Adobe). false = nur fürs Erkennen begradigen, das Original bleibt.
   * Standard: TESSERACT_DESKEW_OUTPUT (true, wenn nicht gesetzt).
   */
  straighten?: boolean;
  reqId?: string;
  /** nur für Tests: ersetzt den Tesseract-Aufruf */
  recognize?: Recognizer;
}

/** Ersetzt die angegebenen Seiten durch begradigte Bilder (gleiche Reihenfolge und Seitenzahl); übrige Seiten bleiben unverändert. */
async function replaceWithStraightened(input: Uint8Array, pages: Map<number, NonNullable<OcrPage["straightened"]>>): Promise<Uint8Array> {
  const src = await PDFDocument.load(input, { updateMetadata: false });
  const out = await PDFDocument.create();
  for (let i = 0; i < src.getPageCount(); i++) {
    const s = pages.get(i);
    if (s) {
      const page = out.addPage([s.widthPts, s.heightPts]);
      page.drawImage(await out.embedJpg(s.jpeg), { x: 0, y: 0, width: s.widthPts, height: s.heightPts });
    } else {
      out.addPage((await out.copyPages(src, [i]))[0]);
    }
  }
  return out.save();
}

/**
 * Erzeugt aus einer (gescannten) PDF eine PDF mit unsichtbarer Textebene: je Seite rendern, Zeilen erkennen,
 * Positionen in PDF-Koordinaten umrechnen. Vorhandene Textebenen der bearbeiteten Seiten werden ersetzt.
 */
export async function ocrWithTesseract(input: Uint8Array, opts: TesseractOptions): Promise<Uint8Array> {
  const dpi = opts.dpi ?? (Number(process.env.TESSERACT_DPI) || 300);
  const minConf = Number(process.env.TESSERACT_MIN_CONF ?? 10);
  const deskewMax = Number(process.env.TESSERACT_DESKEW_MAX ?? 10);
  const straighten = opts.deskew === true && (opts.straighten ?? (process.env.TESSERACT_DESKEW_OUTPUT ?? "true").toLowerCase() !== "false");
  const jpegQuality = Number(process.env.TESSERACT_JPEG_QUALITY) || 85;
  const recognize = opts.recognize ?? recognizeWithTesseract;
  const lang = opts.recognize ? "deu+eng" : pickLanguages(opts.locale, await listLanguages());
  const { pdf, close } = await openPdf(input);
  const t0 = Date.now();
  try {
    const total = pdf.numPages;
    const edits: PageEdit[] = new Array(total);
    const straightened = new Map<number, NonNullable<OcrPage["straightened"]>>();
    let next = 1;
    const workers = Math.max(1, Math.min(4, os.availableParallelism(), total));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next <= total) {
          const n = next++;
          const page = await renderPageForOcr(pdf, n, dpi, {
            deskewMaxDegrees: opts.deskew ? deskewMax : 0,
            straighten,
            jpegQuality,
          });
          if (page.straightened) straightened.set(n - 1, page.straightened);
          const lines = (await recognize(page.png, lang, dpi)).filter((l) => keepLine(l, minConf));
          edits[n - 1] = { pageIndex: n - 1, entries: lines.map((l, id) => ({ item: page.toItem(l, id), text: l.text })) };
          logger.debug("tesseract seite fertig", { reqId: opts.reqId, page: n, lines: lines.length, skew: opts.deskew ? page.skew : undefined });
        }
      })
    );
    logger.info("tesseract fertig", {
      reqId: opts.reqId,
      pages: total,
      lang,
      dpi,
      straightened: straightened.size || undefined,
      ms: Date.now() - t0,
    });
    const base = straightened.size > 0 ? await replaceWithStraightened(input, straightened) : input;
    return await rewriteTextLayers(base, edits);
  } finally {
    await close();
  }
}
