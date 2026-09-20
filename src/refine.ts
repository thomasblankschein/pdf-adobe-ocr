import { logger } from "./logger";
import type { LlmClient, RawMeta, TranscribedLine } from "./llm/types";
type Legibility = "good" | "partial" | "poor";
import { extractPage, openPdf, type PageItem } from "./pdf/pages";
import { enhanceForReading, isJunkLayer, pageHasInk } from "./pdf/quality";
import { rewriteTextLayers, type PageEdit } from "./pdf/textlayer";

export interface RefineOptions {
  client: LlmClient;
  /** Textboxen per Modell korrigieren lassen (ohne dies wird nur Seite 1 für die Metadaten gerendert) */
  correct: boolean;
  /**
   * Ausweichfall bei `correct`: Ist Adobes Textebene einer Seite unbrauchbar (Rauschen statt Wörter) oder fehlt sie
   * trotz sichtbarem Inhalt, transkribiert das Modell die Seite stattdessen zeilenweise (grobe Positionen).
   */
  transcribe?: boolean;
  /** Datum/Absender/Kurzinhalt der ersten Seite lesen; ownNames = Namen und Adressen des Empfängers */
  meta?: { ownNames: string[] };
  /** Lange Kante des Seitenbilds in Pixeln, das an das Modell geht */
  maxImagePx: number;
  /** Seiten, die parallel an das Modell gehen */
  concurrency: number;
  /** Maximale Boxenzahl pro Modellaufruf (größere Seiten werden aufgeteilt) */
  maxBoxesPerCall: number;
  /** true: Modellfehler brechen den Lauf nie ab (das Ergebnis enthält dann weniger Korrekturen) */
  lenient?: boolean;
  reqId?: string;
}

export interface RefineResult {
  pdf: Uint8Array;
  pages: number;
  /** Seiten, auf denen mindestens ein Text geändert wurde */
  pagesRefined: number;
  /** Seiten, bei denen der Modellaufruf fehlgeschlagen ist (dort bleibt der Adobe-Text erhalten) */
  pagesFailed: number;
  /** Geänderte Textboxen (inkl. verworfener) */
  corrections: number;
  /** Seiten, deren Textebene durch eine Transkription des Modells ersetzt wurde (Ausweichfall) */
  pagesTranscribed: number;
  errors: string[];
  /** Nur bei angefordertem meta und erfolgreichem Aufruf */
  meta?: RawMeta;
  metaError?: string;
}

/** Fließtext einer Seite in Lesereihenfolge; Zeilenumbruch, wenn sich die Grundlinie merklich ändert. */
function pageText(items: PageItem[], texts: Map<number, string>): string {
  let out = "";
  let lastY: number | undefined;
  for (const item of items) {
    const text = texts.get(item.id) ?? item.str;
    if (!text.trim()) continue;
    const y = item.transform[5];
    const lineHeight = Math.abs(item.transform[3]) || 10;
    out += lastY === undefined ? "" : Math.abs(y - lastY) > lineHeight * 0.5 ? "\n" : " ";
    out += text;
    lastY = y;
  }
  return out;
}

/**
 * Verbessert die Textebene eines von Adobe erzeugten OCR-PDFs mit einem Vision-LLM und liest auf Wunsch
 * Dokumentdaten von der ersten Seite. Positionen bleiben die von Adobe; das Modell liefert nur Korrekturen
 * für die einzelnen Textboxen. Wirft (außer im lenient-Modus) nur, wenn *alle* Korrekturaufrufe fehlschlagen
 * (z. B. falscher API-Key oder unbekanntes Modell).
 */
export async function refinePdf(input: Uint8Array, opts: RefineOptions): Promise<RefineResult> {
  const { pdf: doc, close } = await openPdf(input);
  const total = doc.numPages;
  // Ohne Korrektur werden nur die Metadaten von Seite 1 gebraucht: die übrigen Seiten nicht rendern
  const limit = opts.correct ? total : Math.min(total, 1);
  const edits: PageEdit[] = [];
  const errors: string[] = [];
  let corrections = 0;
  let transcribed = 0;
  let attempted = 0;
  let next = 1;
  let meta: RawMeta | undefined;
  let metaError: string | undefined;

  async function processPage(n: number) {
    const t0 = Date.now();
    const data = await extractPage(doc, n, opts.maxImagePx);
    const changed = new Map<number, string>();

    let correctionError: unknown;
    let lines: Pick<TranscribedLine, "text" | "x" | "y">[] | undefined;
    let legibility: Legibility | undefined;
    let readingImage = data.image; // im Ausweichfall die aufbereitete Fassung

    // Ausweichfall: Adobes Textebene ist Müll (oder fehlt trotz Inhalt) -> Seite komplett transkribieren lassen
    const canTranscribe = opts.transcribe && opts.correct && data.rotation === 0;
    const useFallback =
      canTranscribe && (isJunkLayer(data.items) || (data.items.length === 0 && (await pageHasInk(data.image.jpeg))));
    if (useFallback) {
      attempted++;
      try {
        readingImage = { ...data.image, jpeg: await enhanceForReading(data.image.jpeg) };
        const t = await opts.client.transcribe(readingImage);
        legibility = t.legibility;
        // Nur sichere Zeilen kommen in die durchsuchbare Textebene; bei schlechter Lesbarkeit gar keine (nichts raten lassen)
        lines = t.legibility === "poor" ? [] : t.lines.filter((l) => l.certain);
        if (t.lines.length > lines.length) {
          logger.info("llm transkription: unsichere zeilen verworfen", {
            reqId: opts.reqId,
            page: n,
            legibility: t.legibility,
            kept: lines.length,
            dropped: t.lines.length - lines.length,
          });
        }
      } catch (err) {
        correctionError = err;
      }
    } else if (opts.correct && data.boxes.length > 0) {
      attempted++;
      try {
        for (let i = 0; i < data.boxes.length; i += opts.maxBoxesPerCall) {
          const chunk = data.boxes.slice(i, i + opts.maxBoxesPerCall);
          for (const c of await opts.client.correct(data.image, chunk)) {
            if (c.text.trim() !== data.items[c.id].str.trim()) changed.set(c.id, c.text);
          }
        }
      } catch (err) {
        correctionError = err;
      }
    } else if (opts.correct) {
      logger.debug("llm seite ohne textboxen", { reqId: opts.reqId, page: n });
    }

    // Dokumentdaten aus der ersten Seite (mit dem bereits korrigierten Text); Fehler sind hier nicht fatal
    if (n === 1 && opts.meta) {
      try {
        const text = lines ? lines.map((l) => l.text).join("\n") : pageText(data.items, changed);
        meta = await opts.client.extractMeta(readingImage, text, opts.meta.ownNames);
        // Auf Seiten, die kaum lesbar waren, keine Daten vertrauen: Datum verwerfen, Ablage zur Prüfung
        if (legibility === "poor") meta = { ...meta, date: "", confidence: "low" };
        else if (legibility === "partial" && meta.confidence === "high") meta = { ...meta, confidence: "medium" };
      } catch (err) {
        metaError = err instanceof Error ? err.message : String(err);
        logger.warn("llm metadaten fehlgeschlagen", { reqId: opts.reqId, err });
      }
    }

    if (correctionError) throw correctionError;
    if (lines) {
      logger.info("llm seite transkribiert (adobe-text unbrauchbar)", {
        reqId: opts.reqId,
        page: n,
        adobeBoxes: data.items.length,
        lines: lines.length,
        ms: Date.now() - t0,
      });
      // Ohne gelesene Zeilen und ohne vorhandene (Müll-)Boxen gibt es nichts zu schreiben oder zu entfernen
      if (lines.length > 0 || data.items.length > 0) {
        transcribed++;
        edits.push({ pageIndex: n - 1, lines });
      }
      return;
    }
    logger.debug("llm seite fertig", {
      reqId: opts.reqId,
      page: n,
      boxes: data.boxes.length,
      changed: changed.size,
      ms: Date.now() - t0,
    });
    if (changed.size === 0) return;
    corrections += changed.size;
    edits.push({
      pageIndex: n - 1,
      entries: data.items.map((item) => ({ item, text: changed.get(item.id) ?? item.str })),
    });
  }

  let failed = 0;
  async function worker() {
    while (next <= limit) {
      const n = next++;
      try {
        await processPage(n);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Seite ${n}: ${msg}`);
        logger.warn("llm seite fehlgeschlagen", { reqId: opts.reqId, page: n, err });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, limit) }, worker));
  } finally {
    await close();
  }

  if (!opts.lenient && attempted > 0 && failed === attempted) throw new Error(errors[0]);

  const pdf = edits.length > 0 ? await rewriteTextLayers(input, edits.sort((a, b) => a.pageIndex - b.pageIndex)) : input;
  return { pdf, pages: total, pagesRefined: edits.length, pagesFailed: failed, corrections, pagesTranscribed: transcribed, errors, meta, metaError };
}
