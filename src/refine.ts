import { logger } from "./logger";
import type { LlmClient } from "./llm/types";
import { extractPage, openPdf } from "./pdf/pages";
import { rewriteTextLayers, type PageEdit } from "./pdf/textlayer";

export interface RefineOptions {
  client: LlmClient;
  /** Lange Kante des Seitenbilds in Pixeln, das an das Modell geht */
  maxImagePx: number;
  /** Seiten, die parallel an das Modell gehen */
  concurrency: number;
  /** Maximale Boxenzahl pro Modellaufruf (größere Seiten werden aufgeteilt) */
  maxBoxesPerCall: number;
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
  errors: string[];
}

/**
 * Verbessert die Textebene eines von Adobe erzeugten OCR-PDFs mit einem Vision-LLM.
 * Positionen bleiben die von Adobe; das Modell liefert nur Korrekturen für die einzelnen Textboxen.
 * Wirft nur, wenn *alle* Seiten fehlschlagen (z. B. falscher API-Key oder unbekanntes Modell).
 */
export async function refinePdf(input: Uint8Array, opts: RefineOptions): Promise<RefineResult> {
  const { pdf: doc, close } = await openPdf(input);
  const total = doc.numPages;
  const edits: PageEdit[] = [];
  const errors: string[] = [];
  let corrections = 0;
  let attempted = 0;
  let next = 1;

  async function processPage(n: number) {
    const t0 = Date.now();
    const data = await extractPage(doc, n, opts.maxImagePx);
    if (data.boxes.length === 0) {
      logger.debug("llm seite ohne textboxen", { reqId: opts.reqId, page: n });
      return;
    }
    attempted++;
    const changed = new Map<number, string>();
    for (let i = 0; i < data.boxes.length; i += opts.maxBoxesPerCall) {
      const chunk = data.boxes.slice(i, i + opts.maxBoxesPerCall);
      for (const c of await opts.client.correct(data.image, chunk)) {
        if (c.text.trim() !== data.items[c.id].str.trim()) changed.set(c.id, c.text);
      }
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
    while (next <= total) {
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
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, total) }, worker));
  } finally {
    await close();
  }

  if (attempted > 0 && failed === attempted) throw new Error(errors[0]);

  const pdf = edits.length > 0 ? await rewriteTextLayers(input, edits.sort((a, b) => a.pageIndex - b.pageIndex)) : input;
  return { pdf, pages: total, pagesRefined: edits.length, pagesFailed: failed, corrections, errors };
}
