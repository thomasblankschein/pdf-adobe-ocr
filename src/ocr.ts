import fs from "node:fs";
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

/** Lädt ein PDF hoch, lässt es bei Adobe per OCR verarbeiten und schreibt das Ergebnis nach outputPath. */
export async function ocrPdf(
  pdfServices: PDFServices,
  inputPath: string,
  outputPath: string,
  options: OcrOptions
): Promise<void> {
  const inputAsset = await pdfServices.upload({
    readStream: fs.createReadStream(inputPath),
    mimeType: MimeType.PDF,
  });

  const job = new OCRJob({
    inputAsset,
    params: new OCRParams({ ocrLocale: options.locale, ocrType: options.type }),
  });

  const pollingURL = await pdfServices.submit({ job });
  const result = await pdfServices.getJobResult({ pollingURL, resultType: OCRResult });
  const content = await pdfServices.getContent({ asset: result.result!.asset });

  // Erst in eine Temp-Datei schreiben, damit bei Abbruch keine halbe PDF liegen bleibt.
  const tmpPath = `${outputPath}.part`;
  try {
    await pipeline(content.readStream, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}
