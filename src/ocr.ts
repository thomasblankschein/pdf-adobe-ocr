import fs from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MimeType,
  OCRJob,
  OCRParams,
  OCRResult,
  OCRSupportedLocale,
  OCRSupportedType,
  PDFServices,
  ServicePrincipalCredentials,
} from "@adobe/pdfservices-node-sdk";
import "./sdk-logging";

export interface OcrOptions {
  locale: OCRSupportedLocale;
  type: OCRSupportedType;
}

export function createClient(): PDFServices {
  const clientId = process.env.PDF_SERVICES_CLIENT_ID;
  const clientSecret = process.env.PDF_SERVICES_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "PDF_SERVICES_CLIENT_ID / PDF_SERVICES_CLIENT_SECRET fehlen (siehe .env.example)."
    );
  }
  return new PDFServices({
    credentials: new ServicePrincipalCredentials({ clientId, clientSecret }),
  });
}

/** Lädt ein PDF-Stream hoch, lässt es bei Adobe per OCR verarbeiten und liefert das Ergebnis als Stream. */
export async function ocrStream(
  pdfServices: PDFServices,
  input: Readable,
  options: OcrOptions
): Promise<NodeJS.ReadableStream> {
  const inputAsset = await pdfServices.upload({ readStream: input, mimeType: MimeType.PDF });

  const job = new OCRJob({
    inputAsset,
    params: new OCRParams({ ocrLocale: options.locale, ocrType: options.type }),
  });

  const pollingURL = await pdfServices.submit({ job });
  const result = await pdfServices.getJobResult({ pollingURL, resultType: OCRResult });
  const content = await pdfServices.getContent({ asset: result.result!.asset });
  return content.readStream;
}

/** Wie ocrStream, schreibt das Ergebnis aber nach outputPath. */
export async function ocrPdf(
  pdfServices: PDFServices,
  inputPath: string,
  outputPath: string,
  options: OcrOptions
): Promise<void> {
  const result = await ocrStream(pdfServices, fs.createReadStream(inputPath), options);

  // Erst in eine Temp-Datei schreiben, damit bei Abbruch keine halbe PDF liegen bleibt.
  const tmpPath = `${outputPath}.part`;
  try {
    await pipeline(result, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}
