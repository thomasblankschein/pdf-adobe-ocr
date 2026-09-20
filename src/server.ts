import { OCRSupportedLocale, OCRSupportedType } from "@adobe/pdfservices-node-sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import { createLlmClient, llmSetup, type LlmClient } from "./llm";
import { logger } from "./logger";
import { createClient, ocrStream } from "./ocr";
import { DEFAULT_LANG, DEFAULT_TYPE, parseFlag, parseLocale, parseType, supportedLocales } from "./options";
import { refinePdf } from "./refine";

try {
  process.loadEnvFile();
} catch {
  // keine .env – Umgebungsvariablen können auch direkt gesetzt sein
}

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.API_KEY;
// Adobe erlaubt für OCR maximal 100 MB pro Datei
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 100);
// LLM-Nachbearbeitung (optional pro Request)
const LLM_MAX_PAGES = Number(process.env.LLM_MAX_PAGES ?? 50);
const LLM_CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY ?? 3));
const LLM_IMAGE_MAX_PX = Number(process.env.LLM_IMAGE_MAX_PX ?? 2000);
const LLM_MAX_BOXES_PER_CALL = Math.max(1, Number(process.env.LLM_MAX_BOXES_PER_CALL ?? 800));

const client = (() => {
  try {
    return createClient();
  } catch (err) {
    logger.error("start abgebrochen", { err });
    process.exit(1);
  }
})();
const upload = multer({
  dest: path.join(os.tmpdir(), "pdf-adobe-ocr"),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

const app = express();
app.disable("x-powered-by");

// Request-ID + Access-Log (ein Eintrag pro Request; Statik/Health nur auf debug-Level)
app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  const start = process.hrtime.bigint();
  res.locals.reqId = reqId;
  res.setHeader("X-Request-Id", reqId);
  res.on("close", () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const aborted = !res.writableFinished;
    const level = req.path.startsWith("/api/")
      ? aborted || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"
      : "debug";
    logger[level]("request", {
      reqId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms,
      ip: req.ip,
      aborted: aborted || undefined,
    });
  });
  next();
});

// Testseite (public/) und pdf.js, das die Seite zum Auslesen des Textlayers nutzt
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
  "/vendor/pdfjs",
  express.static(path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build"))
);

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next();
  const bearer = req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const provided = req.header("x-api-key") ?? bearer ?? "";
  if (!safeEqual(provided, API_KEY)) {
    logger.warn("auth fehlgeschlagen", { reqId: res.locals.reqId, ip: req.ip, path: req.path });
    res.status(401).json({ error: "Ungültiger oder fehlender API-Key." });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/languages", requireApiKey, (_req, res) => {
  res.json({ default: DEFAULT_LANG, languages: supportedLocales() });
});

class BadRequest extends Error {}

const param = (req: Request, name: string): string => String(req.body?.[name] ?? req.query[name] ?? "").trim();

/** Liest das Feld llm (true/false); Anbieter und Modell kommen aus der .env. undefined = keine Nachbearbeitung. */
function parseLlm(req: Request): LlmClient | undefined {
  if (!parseFlag(param(req, "llm"), "llm")) return undefined;
  const setup = llmSetup();
  if (setup.status === "off") throw new BadRequest("LLM-Nachbearbeitung ist auf dem Server nicht konfiguriert (LLM_PROVIDER).");
  if (setup.status === "error") throw new BadRequest(`LLM-Nachbearbeitung ist fehlerhaft konfiguriert: ${setup.reason}`);
  return createLlmClient(setup);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function setPdfHeaders(res: Response, originalName: string) {
  const base = path.basename(originalName, path.extname(originalName)) || "dokument";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${base.replace(/[^\w.-]/g, "_")}.ocr.pdf"; filename*=UTF-8''${encodeURIComponent(base)}.ocr.pdf`
  );
}

app.get("/api/llm", requireApiKey, (_req, res) => {
  const setup = llmSetup();
  res.json({
    enabled: setup.status === "ready",
    provider: setup.status === "ready" ? setup.provider : undefined,
    model: setup.status === "ready" ? setup.model : undefined,
    error: setup.status === "error" ? setup.reason : undefined,
    maxPages: LLM_MAX_PAGES,
  });
});

// POST /api/ocr — multipart/form-data: file (PDF), optional lang, type (exact | deskew), llm (true | false)
app.post("/api/ocr", requireApiKey, upload.single("file"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) {
      res.status(400).json({ error: 'Feld "file" (PDF) fehlt.' });
      return;
    }
    let locale: OCRSupportedLocale, type: OCRSupportedType, llm: LlmClient | undefined;
    try {
      locale = parseLocale(param(req, "lang") || DEFAULT_LANG);
      type = parseType(param(req, "type") || DEFAULT_TYPE);
      llm = parseLlm(req);
      if (llm) {
        // Vor dem (kostenpflichtigen) Adobe-Aufruf prüfen, ob die Datei lesbar und nicht zu lang ist
        const pages = await PDFDocument.load(await fs.promises.readFile(file.path), { ignoreEncryption: true, updateMetadata: false })
          .then((d) => d.getPageCount())
          .catch(() => {
            throw new BadRequest("Die Datei ist keine lesbare PDF.");
          });
        if (pages > LLM_MAX_PAGES) {
          throw new BadRequest(`Mit LLM-Nachbearbeitung sind höchstens ${LLM_MAX_PAGES} Seiten erlaubt (Datei: ${pages}).`);
        }
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const reqId = res.locals.reqId;
    const t0 = Date.now();
    logger.info("ocr start", {
      reqId,
      file: file.originalname,
      sizeKb: Math.round(file.size / 1024),
      lang: locale,
      type,
      llm: llm?.label,
    });
    const result = await ocrStream(client, fs.createReadStream(file.path), { locale, type });

    if (!llm) {
      logger.info("ocr adobe fertig", { reqId, ms: Date.now() - t0 });
      setPdfHeaders(res, file.originalname);
      await pipeline(result, res);
      logger.info("ocr ausgeliefert", { reqId, bytes: res.socket?.bytesWritten, ms: Date.now() - t0 });
      return;
    }

    // Mit LLM: Adobe-Ergebnis komplett einlesen, Textboxen per Modell korrigieren, neues PDF ausliefern
    const adobePdf = await readAll(result);
    logger.info("ocr adobe fertig", { reqId, ms: Date.now() - t0, bytes: adobePdf.length });
    const t1 = Date.now();
    const refined = await refinePdf(adobePdf, {
      client: llm,
      maxImagePx: LLM_IMAGE_MAX_PX,
      concurrency: LLM_CONCURRENCY,
      maxBoxesPerCall: LLM_MAX_BOXES_PER_CALL,
      reqId,
    });
    logger.info("llm fertig", {
      reqId,
      model: llm.label,
      pages: refined.pages,
      pagesRefined: refined.pagesRefined,
      pagesFailed: refined.pagesFailed,
      corrections: refined.corrections,
      ms: Date.now() - t1,
    });
    setPdfHeaders(res, file.originalname);
    res.setHeader("X-OCR-LLM", llm.label);
    res.setHeader("X-OCR-LLM-Pages", `${refined.pagesRefined}/${refined.pages}`);
    res.setHeader("X-OCR-LLM-Corrections", String(refined.corrections));
    res.setHeader("X-OCR-LLM-Failed", String(refined.pagesFailed));
    res.end(Buffer.from(refined.pdf));
    logger.info("ocr ausgeliefert", { reqId, bytes: refined.pdf.length, ms: Date.now() - t0 });
  } catch (err) {
    next(err);
  } finally {
    if (file) fs.rm(file.path, { force: true }, () => {});
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const reqId = res.locals.reqId;
  if (res.headersSent) {
    logger.error("antwort abgebrochen", { reqId, err });
    res.destroy();
    return;
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    logger.warn("upload abgelehnt", { reqId, code: err.code });
    res.status(status).json({ error: err.message });
    return;
  }
  logger.error("ocr fehlgeschlagen", { reqId, err });
  res.status(502).json({ error: err instanceof Error ? err.message : "OCR fehlgeschlagen." });
});

const server = app.listen(PORT, () => {
  const llm = llmSetup();
  logger.info("service gestartet", {
    port: PORT,
    maxUploadMb: MAX_UPLOAD_MB,
    apiKey: API_KEY ? "gesetzt" : "nicht gesetzt",
    llm: llm.status === "ready" ? `${llm.provider}/${llm.model}` : "aus",
  });
  if (!API_KEY) logger.warn("API_KEY nicht gesetzt: /api/* ist ungeschützt");
  if (llm.status === "error") logger.error("LLM-Konfiguration fehlerhaft, Nachbearbeitung nicht verfügbar", { reason: llm.reason });
});

function shutdown(signal: string) {
  logger.info("shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error("unhandledRejection", { err }));
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { err });
  process.exit(1);
});
