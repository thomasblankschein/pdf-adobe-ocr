import fs from "node:fs";
import { buffer } from "node:stream/consumers";
import { OCRSupportedType, type OCRSupportedLocale, type PDFServices } from "@adobe/pdfservices-node-sdk";
import { logger } from "./logger";
import { ocrStream } from "./ocr";
import { ocrWithTesseract } from "./tesseract";

export type Engine = "adobe" | "tesseract";

export interface EngineConfig {
  engine: Engine;
  /** Ausweichengine, wenn Adobe das Kontingent meldet (nur mit engine=adobe) */
  fallback?: Engine;
}

/** OCR_ENGINE (adobe | tesseract, Standard adobe) und OCR_FALLBACK (tesseract | none). Wirft bei ungültigen Werten. */
export function engineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const engine = (env.OCR_ENGINE ?? "adobe").trim().toLowerCase() || "adobe";
  if (engine !== "adobe" && engine !== "tesseract") throw new Error(`Unbekannte OCR_ENGINE "${engine}" (adobe | tesseract).`);
  const fb = (env.OCR_FALLBACK ?? "").trim().toLowerCase();
  if (fb !== "" && fb !== "none" && fb !== "tesseract") throw new Error(`Unbekannter OCR_FALLBACK "${fb}" (tesseract | none).`);
  return { engine, fallback: engine === "adobe" && fb === "tesseract" ? "tesseract" : undefined };
}

/** Adobe meldet ein erschöpftes Kontingent bzw. Nutzungslimit (ServiceUsageError, HTTP 429). */
export function isQuotaError(err: unknown): boolean {
  const e = err as { constructor?: { name?: string }; statusCode?: number; message?: string } | undefined;
  return e?.constructor?.name === "ServiceUsageError" || e?.statusCode === 429 || /\b(quota|usage limit)\b/i.test(e?.message ?? "");
}

export interface OcrRun {
  pdf: Uint8Array;
  engine: Engine;
  /** true, wenn statt der eingestellten Engine die Ausweichengine gelaufen ist (Kontingent erschöpft) */
  fellBack: boolean;
}

/** Führt die OCR mit der eingestellten Engine aus; bei erschöpftem Adobe-Kontingent mit der Ausweichengine. */
export async function runOcr(
  file: string,
  opts: { config: EngineConfig; adobe?: PDFServices; locale: OCRSupportedLocale; type: OCRSupportedType; reqId?: string }
): Promise<OcrRun> {
  const tesseract = async (fellBack: boolean): Promise<OcrRun> => ({
    pdf: await ocrWithTesseract(await fs.promises.readFile(file), {
      locale: opts.locale,
      reqId: opts.reqId,
      // type=deskew gilt wie bei Adobe: schief eingezogene Seiten werden ausgeglichen
      deskew: opts.type === OCRSupportedType.SEARCHABLE_IMAGE,
    }),
    engine: "tesseract",
    fellBack,
  });
  if (opts.config.engine === "tesseract") return tesseract(false);

  if (!opts.adobe) {
    if (!opts.config.fallback) throw new Error("Adobe-Zugangsdaten fehlen.");
    logger.warn("adobe nicht konfiguriert, nutze tesseract", { reqId: opts.reqId });
    return tesseract(true);
  }
  try {
    const stream = await ocrStream(opts.adobe, fs.createReadStream(file), { locale: opts.locale, type: opts.type });
    return { pdf: await buffer(stream), engine: "adobe", fellBack: false };
  } catch (err) {
    if (!opts.config.fallback || !isQuotaError(err)) throw err;
    logger.warn("adobe-kontingent erschöpft, nutze tesseract", { reqId: opts.reqId, err });
    return tesseract(true);
  }
}
