import { OCRSupportedLocale, OCRSupportedType } from "@adobe/pdfservices-node-sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "./logger";
import { createClient, ocrStream } from "./ocr";
import { DEFAULT_LANG, DEFAULT_TYPE, parseLocale, parseType, supportedLocales } from "./options";

try {
  process.loadEnvFile();
} catch {
  // keine .env – Umgebungsvariablen können auch direkt gesetzt sein
}

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.API_KEY;
// Adobe erlaubt für OCR maximal 100 MB pro Datei
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 100);

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

// POST /api/ocr — multipart/form-data: file (PDF), optional lang, type (exact | deskew)
app.post("/api/ocr", requireApiKey, upload.single("file"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) {
      res.status(400).json({ error: 'Feld "file" (PDF) fehlt.' });
      return;
    }
    let locale: OCRSupportedLocale, type: OCRSupportedType;
    try {
      locale = parseLocale(String(req.body?.lang ?? req.query.lang ?? DEFAULT_LANG));
      type = parseType(String(req.body?.type ?? req.query.type ?? DEFAULT_TYPE));
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
    });
    const result = await ocrStream(client, fs.createReadStream(file.path), { locale, type });
    logger.info("ocr adobe fertig", { reqId, ms: Date.now() - t0 });
    const base = path.basename(file.originalname, path.extname(file.originalname)) || "dokument";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${base.replace(/[^\w.-]/g, "_")}.ocr.pdf"; filename*=UTF-8''${encodeURIComponent(base)}.ocr.pdf`
    );
    await pipeline(result, res);
    logger.info("ocr ausgeliefert", { reqId, bytes: res.socket?.bytesWritten, ms: Date.now() - t0 });
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
  logger.info("service gestartet", { port: PORT, maxUploadMb: MAX_UPLOAD_MB, apiKey: API_KEY ? "gesetzt" : "nicht gesetzt" });
  if (!API_KEY) logger.warn("API_KEY nicht gesetzt: /api/* ist ungeschützt");
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
