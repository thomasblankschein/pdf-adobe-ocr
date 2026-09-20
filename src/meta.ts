import { PDFDocument } from "pdf-lib";
import type { RawMeta } from "./llm/types";

export const FOLDER_UNKNOWN = "_Unbekannt";
export const FOLDER_REVIEW = "_Pruefen";

export interface DocumentMeta {
  /** YYYY-MM-DD: Dokumentdatum oder, wenn nicht lesbar, das Scandatum */
  date: string;
  dateSource: "document" | "scan" | "none";
  correspondent: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  /** Vorgeschlagener relativer Pfad im Ziel, z. B. "Telekom/2026-09-20_Rechnung-Mobilfunk.pdf" */
  path: string;
}

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Ein einzelner Datei-/Ordnername, der auf SMB/Windows und Linux gültig ist. */
export function cleanName(input: string, maxLength: number): string {
  let t = input.normalize("NFC").replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  if (t.length > maxLength) t = t.slice(0, maxLength).replace(/\s+\S*$/, "").trim() || t.slice(0, maxLength).trim();
  t = t.replace(/^[.\s]+|[.\s]+$/g, "");
  if (RESERVED.test(t)) t = `_${t}`;
  return t;
}

/** Wörter mit Bindestrichen (Dateiname-Teil): Buchstaben, Ziffern, "-", "_" und "." bleiben, Umlaute auch. */
export function slug(input: string, maxLength: number): string {
  const t = cleanName(input, maxLength * 2)
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_.-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return t.length > maxLength ? t.slice(0, maxLength).replace(/[-.]+$/, "") : t;
}

/** Gültiges, plausibles Datum (YYYY-MM-DD) oder undefined. */
export function validDate(value: string, now = new Date()): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  if (y < 1950 || date.getTime() > now.getTime() + 366 * 24 * 3600 * 1000) return undefined;
  return value.trim();
}

/**
 * Baut aus den Modelldaten den Ablagepfad:
 *   Korrespondent/Datum_Inhalt.pdf            (normal)
 *   _Unbekannt/Datum_Inhalt.pdf               (kein Korrespondent erkannt)
 *   _Pruefen/Datum_Korrespondent_Inhalt.pdf   (Modell unsicher)
 * scanDate (YYYY-MM-DD) ersetzt ein fehlendes Dokumentdatum.
 */
export function buildDocumentMeta(raw: RawMeta, scanDate?: string, now = new Date()): DocumentMeta {
  const docDate = validDate(raw.date, now);
  const fallback = scanDate ? validDate(scanDate, now) : undefined;
  const date = docDate ?? fallback ?? "";
  const dateSource = docDate ? "document" : fallback ? "scan" : "none";
  const correspondent = cleanName(raw.correspondent, 50);
  const summary = slug(raw.summary, 60) || "Scan";
  const prefix = date || "ohne-Datum";

  let folder: string;
  let file: string;
  if (raw.confidence === "low") {
    folder = FOLDER_REVIEW;
    file = [prefix, slug(correspondent, 40), summary].filter(Boolean).join("_");
  } else if (!correspondent) {
    folder = FOLDER_UNKNOWN;
    file = `${prefix}_${summary}`;
  } else {
    folder = correspondent;
    file = `${prefix}_${summary}`;
  }
  return { date, dateSource, correspondent, summary, confidence: raw.confidence, path: `${folder}/${file}.pdf` };
}

/** Schreibt Titel, Autor und Datum in die PDF-Eigenschaften (Info-Dictionary). */
export async function stampPdfMetadata(pdf: Uint8Array, meta: DocumentMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  if (meta.summary && meta.summary !== "Scan") doc.setTitle(meta.summary.replace(/-/g, " "));
  if (meta.correspondent) doc.setAuthor(meta.correspondent);
  if (meta.date && meta.dateSource === "document") doc.setCreationDate(new Date(`${meta.date}T12:00:00Z`));
  return doc.save();
}

/** Eigene Namen/Adressen aus OWN_NAMES (durch Semikolon getrennt). */
export function ownNames(): string[] {
  return (process.env.OWN_NAMES ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
