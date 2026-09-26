// Smoke-Test der LLM-Nachbearbeitung ohne Adobe-Zugang und ohne API-Key:
// Erzeugt ein synthetisches "Adobe-Ergebnis" (Scan-Bild + unsichtbarer, fehlerhafter Textlayer),
// lässt ein Stub-LLM die Fehler korrigieren und prüft das Ergebnis-PDF.
//   npm run smoke
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Correction, LlmClient, PageImage, RawMeta, TextBox, TranscribedLine, Transcription } from "../src/llm/types";
import { buildDocumentMeta, cleanName, slug, validDate } from "../src/meta";
import { detectSkew } from "../src/pdf/deskew";
import { extractPage, openPdf, type PageItem } from "../src/pdf/pages";
import { enhanceForReading, flattenBackground, isJunkLayer, pageHasInk } from "../src/pdf/quality";
import { buildEntries, layoutLines, stripTextObjects } from "../src/pdf/textlayer";
import { refinePdf } from "../src/refine";
import { engineConfig, isQuotaError } from "../src/engine";
import { keepLine, ocrWithTesseract, parseTsv, pickLanguages, tesseractCode } from "../src/tesseract";

// --- 1. Tokenizer ---------------------------------------------------------------------------
{
  const strip = (s: string) => stripTextObjects(Buffer.from(s, "latin1")).toString("latin1");
  const has = (s: string, needle: string) => s.includes(needle);

  const a = strip("q 1 0 0 1 0 0 cm /Im0 Do Q\nBT /F1 12 Tf (ET inside string) Tj ET\n0 0 m 10 10 l S");
  assert.ok(!has(a, "BT") && !has(a, "inside") && has(a, "/Im0 Do") && has(a, "10 10 l S"), "Text entfernt, Rest erhalten");

  const b = strip("BT (a \\) ET b) Tj <4554> Tj [(x) -20 (ET)] TJ ET 1 0 0 rg");
  assert.ok(!has(b, "ET") && has(b, "1 0 0 rg"), "Strings mit Escapes/Hex/Arrays");

  const c = strip("q BI /W 2 /H 2 /BPC 8 /CS /G ID BT\nET EI Q BT (t) Tj ET");
  assert.ok(has(c, "BI") && has(c, "ID BT\nET EI") && !has(c, "(t)"), "Inline-Bild-Daten bleiben unangetastet");

  const d = strip("% BT im Kommentar\n0 0 m BT (x) Tj");
  assert.ok(has(d, "% BT im Kommentar") && has(d, "0 0 m") && !has(d, "(x)"), "Kommentar bleibt, offenes Textobjekt wird verworfen");
}

// --- 1b. Dateinamen und Pfade -----------------------------------------------------------------
{
  assert.equal(cleanName('AT&T: "Rechnung"/Test?', 50), "AT&T Rechnung Test");
  assert.equal(cleanName("  ..Telekom Deutschland..  ", 50), "Telekom Deutschland");
  assert.equal(cleanName("CON", 50), "_CON");
  assert.equal(cleanName("Müller & Söhne", 50), "Müller & Söhne", "Umlaute bleiben");
  assert.ok(cleanName("x".repeat(200), 50).length <= 50);
  assert.equal(slug("Rechnung Mobilfunk, Juli!", 60), "Rechnung-Mobilfunk-Juli");
  assert.equal(slug("Kündigung   Mietvertrag", 60), "Kündigung-Mietvertrag");
  assert.equal(slug("Zusatzversorgungskasse der Stadt Hannover", 40), "Zusatzversorgungskasse-der-Stadt", "Kürzen an Wortgrenzen");
  assert.equal(slug("A".repeat(50), 40).length, 40, "einzelnes langes Wort wird hart gekürzt");
  assert.equal(slug("../../etc/passwd", 60), "etc-passwd", "keine Pfadtrenner im Dateinamen");

  const now = new Date("2026-09-20T12:00:00Z");
  assert.equal(validDate("2026-09-20", now), "2026-09-20");
  assert.equal(validDate("2026-02-30", now), undefined, "31.-Tag-Fehler");
  assert.equal(validDate("20.09.2026", now), undefined, "falsches Format");
  assert.equal(validDate("1900-01-01", now), undefined, "zu alt");
  assert.equal(validDate("2099-01-01", now), undefined, "zu weit in der Zukunft");

  const raw = (o: Partial<RawMeta>): RawMeta => ({ date: "2026-09-20", correspondent: "Telekom", summary: "Rechnung Mobilfunk", confidence: "high", ...o });
  assert.equal(buildDocumentMeta(raw({}), undefined, now).path, "Telekom/2026-09-20_Telekom_Rechnung-Mobilfunk.pdf");
  assert.equal(buildDocumentMeta(raw({ reference: "LV 12/345-6" }), undefined, now).path, "Telekom/2026-09-20_Telekom_Rechnung-Mobilfunk_LV-12-345-6.pdf", "Bezug am Ende");
  assert.equal(buildDocumentMeta(raw({ reference: "B-XY 123", confidence: "low" }), undefined, now).path, "_Pruefen/2026-09-20_Telekom_Rechnung-Mobilfunk_B-XY-123.pdf");
  assert.equal(buildDocumentMeta(raw({ correspondent: "", reference: "4711" }), undefined, now).path, "_Unbekannt/2026-09-20_Rechnung-Mobilfunk_4711.pdf");
  assert.equal(buildDocumentMeta(raw({ reference: "../../x" }), undefined, now).path.split("/").length, 2, "Bezug ohne Pfadtrenner");
  assert.equal(buildDocumentMeta(raw({ correspondent: "" }), undefined, now).path, "_Unbekannt/2026-09-20_Rechnung-Mobilfunk.pdf");
  assert.equal(buildDocumentMeta(raw({ confidence: "low" }), undefined, now).path, "_Pruefen/2026-09-20_Telekom_Rechnung-Mobilfunk.pdf");
  assert.equal(buildDocumentMeta(raw({ confidence: "medium" }), undefined, now).path, "Telekom/2026-09-20_Telekom_Rechnung-Mobilfunk.pdf", "medium bleibt im Korrespondenten-Ordner");
  const noDate = buildDocumentMeta(raw({ date: "" }), "2026-09-19", now);
  assert.equal(noDate.path, "Telekom/2026-09-19_Telekom_Rechnung-Mobilfunk.pdf");
  assert.equal(noDate.dateSource, "scan");
  assert.equal(buildDocumentMeta(raw({ date: "", summary: "" }), undefined, now).path, "Telekom/ohne-Datum_Telekom_Scan.pdf");
  const evil = buildDocumentMeta(raw({ correspondent: "../../Windows/System32", summary: "a/b\c" }), undefined, now);
  assert.ok(!evil.path.includes("..") && evil.path.split("/").length === 2, "genau eine Ordnerebene: " + evil.path);
  assert.equal(buildDocumentMeta(raw({ correspondent: "CON" }), undefined, now).path.split("/")[0], "_CON");
}

// --- 2. Synthetisches Adobe-PDF ------------------------------------------------------------
const W = 595;
const H = 842;
const lines: { text: string; x: number; y: number; size: number }[] = [
  { text: "Rechnungsnurnmer 2026-0417", x: 60, y: 760, size: 14 },
  { text: "Betrag: 1.234,50 EUR", x: 60, y: 730, size: 14 },
  { text: "~~^^", x: 400, y: 700, size: 10 }, // Rauschen, soll verworfen werden
  { text: "Müller GmbH", x: 60, y: 700, size: 12 },
];

async function buildAdobeLikePdf(): Promise<Uint8Array> {
  const canvas = createCanvas(W * 2, H * 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W * 2, H * 2);
  ctx.fillStyle = "#000";
  for (const l of lines) ctx.fillRect(l.x * 2, (H - l.y) * 2 - l.size * 2, 200, l.size * 1.5); // Platzhalter statt Schrift
  const png = await canvas.encode("png");

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(png);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([W, H]);
    page.drawImage(image, { x: 0, y: 0, width: W, height: H });
    const fontName = page.node.newFontDictionary(helv.name, helv.ref);
    const items = p === 0 ? lines : [{ text: "Seite zwei ist bereits korrekt", x: 60, y: 760, size: 12 }];
    const ops = ["BT", "3 Tr"];
    for (const l of items) {
      ops.push(`${fontName.toString()} ${l.size} Tf`, `1 0 0 1 ${l.x} ${l.y} Tm`, `(${l.text.replace(/[()\\]/g, "\\$&")}) Tj`);
    }
    ops.push("ET");
    page.node.addContentStream(doc.context.register(doc.context.stream(ops.join("\n"))));
  }
  return doc.save();
}

// --- 3. Stub-LLM ------------------------------------------------------------------------------
const TRANSCRIPT: TranscribedLine[] = [
  { text: "BAECKEREI SONNENSCHEIN", x: 300, y: 100, certain: true },
  { text: "15.09.2026 14:32 Uhr", x: 300, y: 130, certain: true },
  { text: "SUMME EUR 10,30", x: 300, y: 250, certain: true },
];
const FIXES: Record<string, string> = {
  "Rechnungsnurnmer": "Rechnungsnummer",
  "~~^^": "",
};
let calls = 0;
let transcribeCalls = 0;
let metaCalls = 0;
let metaText = "";
const stub: LlmClient = {
  label: "stub/none",
  async transcribe(image: PageImage): Promise<Transcription> {
    transcribeCalls++;
    assert.equal(image.jpeg[0], 0xff, "Transkription bekommt das Seitenbild");
    return { legibility: "good", lines: TRANSCRIPT };
  },
  async extractMeta(image: PageImage, text: string, ownNames: string[]): Promise<RawMeta> {
    metaCalls++;
    metaText = text;
    assert.equal(image.jpeg[0], 0xff, "Meta-Aufruf bekommt das Seitenbild");
    assert.deepEqual(ownNames, ["Thomas Blankschein"]);
    return { date: "2026-09-18", correspondent: "Müller GmbH", summary: "Rechnung", confidence: "high" };
  },
  async correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]> {
    calls++;
    assert.equal(image.jpeg[0], 0xff, "Seitenbild ist ein JPEG");
    assert.ok(image.width > 500 && image.height > 700, "Seitenbild hat sinnvolle Größe");
    assert.ok(boxes.every((b) => b.x >= 0 && b.x <= 1000 && b.y >= 0 && b.y <= 1000 && b.w > 0 && b.h > 0), "Boxen liegen auf der Seite");
    const out: Correction[] = [];
    for (const b of boxes) {
      let text = b.text;
      for (const [wrong, right] of Object.entries(FIXES)) text = text.replace(wrong, right);
      if (text !== b.text) out.push({ id: b.id, text });
    }
    return out;
  },
};

// --- 4. Ausweichfall: Müll-Textebene / fehlende Textebene --------------------------------------------
function item(str: string): PageItem {
  return { id: 0, str, transform: [10, 0, 0, 10, 0, 0], width: 10 * str.length };
}

async function pageImage(withText: boolean): Promise<Buffer> {
  const c = createCanvas(600, 840);
  const x = c.getContext("2d");
  x.fillStyle = "#ffffff";
  x.fillRect(0, 0, 600, 840);
  if (withText) {
    x.fillStyle = "#000000";
    x.font = "bold 40px Arial";
    for (let i = 0; i < 12; i++) x.fillText("Rechnung Musterfirma " + i, 30, 60 + i * 60);
  }
  return c.encode("jpeg", 80);
}

async function fallbackScenario() {
  // Erkennung
  const garbage = ["~'ite;'$.::N¾;!?J;{~,11':l.AiF1..", ",. 1 ,., ,· ' . '", "t :j- • ,/' ,,.", "y''· ,. t", "\"'' .. ;,~1,,:-,"].map(item);
  assert.equal(isJunkLayer(garbage), true, "Rauschen wird als Müll erkannt");
  assert.equal(isJunkLayer(["Rechnungsnummer 2026-0417", "Betrag: 1.234,50 EUR", "Müller GmbH"].map(item)), false, "normaler Text ist kein Müll");
  assert.equal(isJunkLayer(["12", "€"].map(item)), false, "zu wenig Text für ein Urteil");
  assert.equal(await pageHasInk(await pageImage(true)), true, "Seite mit Text hat Inhalt");
  assert.equal(await pageHasInk(await pageImage(false)), false, "leere Seite hat keinen Inhalt");

  // Layout: alles innerhalb der Seite, Reihenfolge von oben nach unten, sinnvolle Größe
  const lay = layoutLines([...TRANSCRIPT].reverse(), 595, 842, (t, sz) => t.length * sz * 0.6);
  assert.deepEqual(lay.map((l) => l.text), TRANSCRIPT.map((l) => l.text), "nach y sortiert");
  for (const l of lay) {
    assert.ok(l.size >= 5 && l.size <= 24, "Schriftgröße " + l.size);
    assert.ok(l.x >= 0 && l.baseline > 0 && l.baseline < 842, "Grundlinie innerhalb der Seite");
    assert.ok(l.x + l.scaleX * l.text.length * l.size * 0.6 <= 595 * 0.99 + 1, "Zeile ragt nicht über den Rand");
  }
  assert.ok(lay[0].baseline > lay[1].baseline && lay[1].baseline > lay[2].baseline, "PDF-y läuft nach oben");
  const wide = layoutLines([{ text: "x".repeat(200), x: 900, y: 500 }], 595, 842, (t, sz) => t.length * sz * 0.6);
  assert.ok(wide[0].scaleX < 0.2, "zu breite Zeile wird gestaucht");

  // Ganzer Ablauf: Seite 1 = Müll-Textebene, Seite 2 = normal, Seite 3 = Bild ohne Textebene, Seite 4 = leer
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const invisible = (page: any, text: string) => {
    const f = page.node.newFontDictionary(helv.name, helv.ref);
    page.node.addContentStream(doc.context.register(doc.context.stream(`BT 3 Tr ${f.toString()} 12 Tf 1 0 0 1 60 700 Tm (${text}) Tj ET`)));
  };
  const spec: { ink: boolean; text?: string }[] = [
    { ink: true, text: "~'ite;'$.::N;!?J;{~,11':l.AiF1.. ,. 1 ,., ,' . ' :j- ,/' ,,. y'' t" },
    { ink: true, text: "Rechnungsnurnmer 2026-0417 und mehr normaler Text hier" },
    { ink: true },
    { ink: false },
  ];
  for (const sp of spec) {
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedJpg(await pageImage(sp.ink)), { x: 0, y: 0, width: 595, height: 842 });
    if (sp.text) invisible(page, sp.text);
  }
  const input = await doc.save();
  const base = { client: stub, correct: true, maxImagePx: 800, concurrency: 2, maxBoxesPerCall: 800 } as const;

  // ohne transcribe bleibt alles wie bisher
  transcribeCalls = 0;
  const off = await refinePdf(input, { ...base, meta: { ownNames: ["Thomas Blankschein"] } });
  assert.equal(transcribeCalls, 0);
  assert.equal(off.pagesTranscribed, 0);

  // mit transcribe: Seite 1 (Müll) und Seite 3 (Inhalt ohne Textebene) werden transkribiert, Seite 4 (leer) nicht
  transcribeCalls = 0;
  metaText = "";
  const on = await refinePdf(input, { ...base, transcribe: true, meta: { ownNames: ["Thomas Blankschein"] } });
  assert.equal(transcribeCalls, 2, "Seite 1 (Müll) und Seite 3 (fehlende Textebene), nicht die leere Seite 4");
  assert.equal(on.pagesTranscribed, 2);
  assert.ok(metaText.includes("BAECKEREI SONNENSCHEIN") && !metaText.includes("~'ite"), "Metadaten bekommen die Transkription statt des Mülls: " + JSON.stringify(metaText));

  const d = await openPdf(on.pdf);
  const p1 = await extractPage(d.pdf, 1, 400);
  const texts1 = p1.items.map((i) => i.str).join(" | ");
  for (const l of TRANSCRIPT) assert.ok(texts1.includes(l.text), "Zeile fehlt: " + l.text + " in " + texts1);
  assert.ok(!texts1.includes("~'ite") && !texts1.includes(":j-"), "Müll-Textebene entfernt: " + texts1);
  assert.ok(p1.boxes.every((b) => b.x >= 0 && b.x <= 1000 && b.y >= 0 && b.y <= 1000), "Boxen liegen auf der Seite");
  const p2 = await extractPage(d.pdf, 2, 400);
  assert.ok(p2.items.some((i) => i.str.includes("Rechnungsnummer 2026-0417")), "normale Seite 2 wurde korrigiert, nicht transkribiert");
  const p3 = await extractPage(d.pdf, 3, 400);
  assert.ok(p3.items.map((i) => i.str).join(" ").includes("SUMME EUR 10,30"), "Seite ohne Textebene hat jetzt Text");
  const p4 = await extractPage(d.pdf, 4, 400);
  assert.equal(p4.items.length, 0, "leere Seite bleibt leer");
  await d.close();

  // Aufbereitetes Bild: gültiges JPEG in gleicher Größe, Papier hell, Tinte dunkel
  const enhanced = await enhanceForReading(await pageImage(true));
  assert.equal(enhanced[0], 0xff);
  assert.ok(await pageHasInk(enhanced), "aufbereitetes Bild behält den Inhalt");

  // Ehrlichkeitsschranke: unsichere Zeilen und schlecht lesbare Seiten
  const uncertain: LlmClient = {
    ...stub,
    transcribe: async () => ({
      legibility: "partial",
      lines: [
        { text: "BAECKEREI SONNENSCHEIN", x: 300, y: 100, certain: true },
        { text: "Hauptstr. 5, 12345 Sonnenberg", x: 300, y: 130, certain: false },
        { text: "Kasse: Nadine", x: 300, y: 160, certain: false },
        { text: "SUMME EUR 10,30", x: 300, y: 250, certain: true },
      ],
    }),
    extractMeta: async () => ({ date: "2023-05-17", correspondent: "Bäckerei Sonnenschein", summary: "Kassenbon", confidence: "high" }),
  };
  const part = await refinePdf(input, { ...base, client: uncertain, transcribe: true, meta: { ownNames: [] } });
  const dp = await openPdf(part.pdf);
  const partText = (await extractPage(dp.pdf, 1, 400)).items.map((i) => i.str).join(" | ");
  await dp.close();
  assert.ok(partText.includes("BAECKEREI SONNENSCHEIN") && partText.includes("SUMME EUR 10,30"), "sichere Zeilen bleiben: " + partText);
  assert.ok(!partText.includes("Sonnenberg") && !partText.includes("Nadine"), "unsichere (geratene) Zeilen werden nicht geschrieben: " + partText);
  assert.equal(part.meta?.confidence, "medium", "teilweise lesbar: höchstens medium");
  assert.equal(part.meta?.date, "2023-05-17", "bei partial bleibt das Datum");

  const poor: LlmClient = {
    ...uncertain,
    transcribe: async () => ({ legibility: "poor", lines: [{ text: "Erfundenes", x: 100, y: 100, certain: true }] }),
  };
  const bad = await refinePdf(input, { ...base, client: poor, transcribe: true, meta: { ownNames: [] } });
  const db = await openPdf(bad.pdf);
  const badText = (await extractPage(db.pdf, 1, 400)).items.map((i) => i.str).join(" | ");
  await db.close();
  assert.ok(!badText.includes("Erfundenes") && !badText.includes("~'ite"), "poor: nichts geschrieben, Müll entfernt: " + badText);
  assert.equal(bad.meta?.confidence, "low", "poor: Ablage zur Prüfung");
  assert.equal(bad.meta?.date, "", "poor: Datum verworfen");

  // Modell findet keinen Text auf einer Müll-Seite: Müll wird entfernt, nichts wird erfunden
  const emptyClient: LlmClient = { ...stub, transcribe: async () => ({ legibility: "poor", lines: [] }) };
  const cleaned = await refinePdf(input, { ...base, client: emptyClient, transcribe: true });
  const d2 = await openPdf(cleaned.pdf);
  assert.equal((await extractPage(d2.pdf, 1, 400)).items.length, 0, "Müll entfernt, wenn nichts lesbar ist");
  await d2.close();

  // Fehler bei der Transkription: lenient behält die Seite unverändert
  const brokenT: LlmClient = { ...stub, transcribe: async () => { throw new Error("kaputt"); } };
  const r = await refinePdf(input, { ...base, client: brokenT, transcribe: true, lenient: true });
  assert.equal(r.pagesTranscribed, 0);
  assert.ok(r.pagesFailed >= 1);
}

async function main() {
  const input = await buildAdobeLikePdf();
  const result = await refinePdf(input, {
    client: stub,
    correct: true,
    meta: { ownNames: ["Thomas Blankschein"] },
    maxImagePx: 1200,
    concurrency: 2,
    maxBoxesPerCall: 800,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.pagesRefined, 1, "nur Seite 1 wurde verändert");
  assert.equal(result.pagesFailed, 0);
  assert.equal(calls, 2, "jede Seite wurde einmal an das Modell geschickt");
  assert.equal(metaCalls, 1, "Metadaten nur von der ersten Seite");
  assert.deepEqual(result.meta, { date: "2026-09-18", correspondent: "Müller GmbH", summary: "Rechnung", confidence: "high" });
  assert.ok(metaText.includes("Rechnungsnummer 2026-0417"), "Metadaten-Aufruf bekommt den bereits korrigierten Text: " + JSON.stringify(metaText));
  assert.ok(!metaText.includes("nurnmer") && !metaText.includes("~~^^"));

  const before = await openPdf(input);
  const after = await openPdf(result.pdf);
  const [b1, a1] = [await extractPage(before.pdf, 1, 1200), await extractPage(after.pdf, 1, 1200)];
  const texts = a1.items.map((i) => i.str);

  assert.ok(texts.some((t) => t.includes("Rechnungsnummer 2026-0417")), "Fehler korrigiert: " + JSON.stringify(texts));
  assert.ok(!texts.some((t) => t.includes("nurnmer")), "alter Text ist weg (keine doppelte Ebene)");
  assert.ok(!texts.includes("~~^^"), "Rauschbox verworfen");
  assert.ok(texts.includes("Müller GmbH") && texts.includes("Betrag: 1.234,50 EUR"), "unveränderte Boxen bleiben erhalten (inkl. Umlaut)");
  assert.equal(a1.items.length, b1.items.length - 1, "genau eine Box weniger");

  // Positionen: jede erhaltene Box liegt an derselben Stelle und hat dieselbe Breite wie vorher
  for (const item of a1.items) {
    const orig = b1.items.find((o) => Math.abs(o.transform[4] - item.transform[4]) < 0.5 && Math.abs(o.transform[5] - item.transform[5]) < 0.5);
    assert.ok(orig, `Position erhalten für "${item.str}"`);
    assert.ok(Math.abs(orig.width - item.width) < 1.5, `Breite erhalten für "${item.str}": ${orig.width} vs ${item.width}`);
  }

  // Bild unverändert: gerenderte Seite ist vorher/nachher identisch (Text ist unsichtbar)
  assert.ok(b1.image.jpeg.equals(a1.image.jpeg), "Seitenbild unverändert");

  // Seite 2 unverändert
  const [b2, a2] = [await extractPage(before.pdf, 2, 1200), await extractPage(after.pdf, 2, 1200)];
  assert.deepEqual(a2.items.map((i) => i.str), b2.items.map((i) => i.str));

  await before.close();
  await after.close();

  // nur Metadaten (keine Korrektur): PDF bleibt byte-identisch, Text für das Modell ist der Adobe-Text
  calls = 0;
  const metaOnly = await refinePdf(input, { client: stub, correct: false, meta: { ownNames: ["Thomas Blankschein"] }, maxImagePx: 1200, concurrency: 2, maxBoxesPerCall: 800 });
  assert.equal(calls, 0, "ohne correct kein Korrekturaufruf");
  assert.ok(metaOnly.pdf === input, "PDF unverändert");
  assert.ok(metaText.includes("Rechnungsnurnmer"), "Adobe-Text unkorrigiert");
  assert.ok(metaOnly.meta);

  // Fehler bei den Metadaten brechen nichts ab
  const brokenMeta: LlmClient = { ...stub, extractMeta: async () => { throw new Error("boom"); } };
  const r3 = await refinePdf(input, { client: brokenMeta, correct: true, meta: { ownNames: [] }, maxImagePx: 1200, concurrency: 2, maxBoxesPerCall: 800 });
  assert.equal(r3.meta, undefined);
  assert.equal(r3.metaError, "boom");
  assert.equal(r3.pagesRefined, 1, "Korrekturen trotzdem angewendet");

  // lenient: Korrekturfehler auf allen Seiten -> kein Abbruch, Adobe-PDF bleibt erhalten
  const brokenCorrect: LlmClient = { ...stub, correct: async () => { throw new Error("kaputt"); } };
  await assert.rejects(refinePdf(input, { client: brokenCorrect, correct: true, maxImagePx: 1200, concurrency: 2, maxBoxesPerCall: 800 }), /kaputt/);
  const r4 = await refinePdf(input, { client: brokenCorrect, correct: true, lenient: true, meta: { ownNames: ["Thomas Blankschein"] }, maxImagePx: 1200, concurrency: 2, maxBoxesPerCall: 800 });
  assert.equal(r4.pagesFailed, 2);
  assert.ok(r4.pdf === input);
  assert.ok(r4.meta, "Metadaten trotz Korrekturfehler");

  // Breite: nimmt eine Box den Text geleerter Nachbarn auf, erhält sie deren Gesamtbreite
  {
    const mk = (id: number, str: string, e: number, width: number): PageItem => ({ id, str, transform: [10, 0, 0, 10, e, 100], width });
    const items = [mk(0, "Katja", 10, 40), mk(1, "Tegtme", 55, 35), mk(2, "ier", 92, 15), mk(3, "Weit", 300, 30)];
    const merged = buildEntries(items, new Map([[1, "Tegtmeier"], [2, ""]]));
    assert.equal(merged[1].item.transform[4], 55);
    assert.ok(Math.abs(merged[1].item.width - 52) < 1e-6, "Union aus 'Tegtme' und 'ier'");
    const far = buildEntries(items, new Map([[0, "Katja Tegtmeier"], [3, ""]]));
    assert.equal(far[0].item.width, 40, "weit entfernte geleerte Box wird nicht einbezogen");
    const same = buildEntries(items, new Map([[1, "Tegtm"]]));
    assert.equal(same[1].item.width, 35, "kürzerer Text ändert die Breite nicht");
  }

  // Tesseract-Weg (ohne Adobe): TSV-Parser, Sprachwahl, Engine-Konfiguration, Koordinaten der neuen Textebene
  {
    const row = (...cols: (string | number)[]) => cols.join("\t");
    const tsv = [
      row("level", "page_num", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text"),
      row(4, 1, 1, 1, 1, 0, 100, 50, 300, 40, -1, ""),
      row(5, 1, 1, 1, 1, 1, 100, 50, 120, 40, 91.5, "Rechnung"),
      row(5, 1, 1, 1, 1, 2, 240, 55, 160, 35, 88, "Nr."),
      row(5, 1, 1, 1, 2, 1, 100, 120, 90, 30, -1, " "),
      row(5, 1, 1, 1, 2, 2, 200, 120, 90, 30, 12, "~~"),
    ].join("\n");
    const parsed = parseTsv(tsv);
    assert.equal(parsed.length, 2, "zwei Zeilen (Wörter zusammengefasst, leere Wörter verworfen)");
    const twoColumns = [row(5, 1, 2, 1, 1, 1, 100, 300, 100, 40, 90, "links"), row(5, 1, 2, 1, 1, 2, 700, 300, 100, 40, 90, "rechts")];
    const cols = parseTsv([tsv, ...twoColumns].join("\n"));
    assert.deepEqual(cols.slice(2).map((l) => l.text), ["links", "rechts"], "Wörter mit großem Abstand werden getrennte Zeilenstücke");
    assert.deepEqual([parsed[0].text, parsed[0].x, parsed[0].y, parsed[0].w, parsed[0].h], ["Rechnung Nr.", 100, 50, 300, 40]);
    assert.ok(keepLine(parsed[0], 10) && !keepLine(parsed[1], 10), "Rauschen ohne Buchstaben/Ziffern fliegt raus");
    assert.equal(tesseractCode("de-DE"), "deu");
    assert.equal(pickLanguages("de-DE", ["eng", "deu", "osd"], ""), "deu+eng");
    assert.equal(pickLanguages("fr-FR", ["eng", "deu"], ""), "eng", "nicht installierte Sprache entfällt");
    assert.equal(pickLanguages("de-DE", ["eng"], "deu+fra"), "deu+fra", "TESSERACT_LANGS überschreibt");

    assert.deepEqual(engineConfig({}), { engine: "adobe", fallback: undefined });
    assert.deepEqual(engineConfig({ OCR_ENGINE: "adobe", OCR_FALLBACK: "tesseract" }), { engine: "adobe", fallback: "tesseract" });
    assert.deepEqual(engineConfig({ OCR_ENGINE: "Tesseract", OCR_FALLBACK: "tesseract" }), { engine: "tesseract", fallback: undefined });
    assert.throws(() => engineConfig({ OCR_ENGINE: "abbyy" }), /OCR_ENGINE/);
    assert.throws(() => engineConfig({ OCR_FALLBACK: "x" }), /OCR_FALLBACK/);
    class ServiceUsageError extends Error {}
    assert.ok(isQuotaError(new ServiceUsageError("limit")), "Adobe-Nutzungslimit");
    assert.ok(isQuotaError(Object.assign(new Error("x"), { statusCode: 429 })));
    assert.ok(!isQuotaError(new Error("Netzwerkfehler")));

    const out = await ocrWithTesseract(input, {
      locale: "de-DE",
      recognize: async () => [
        { text: "Testzeile eins", x: 120, y: 200, w: 800, h: 40, conf: 90 },
        { text: "~~", x: 10, y: 10, w: 50, h: 40, conf: 90 },
      ],
    });
    const doc = await openPdf(out);
    for (const n of [1, 2]) {
      const pg = await extractPage(doc.pdf, n, 800);
      assert.equal(pg.items.length, 1, `Seite ${n}: eine Zeile, das Rauschen ist weg, alter Text ersetzt`);
      assert.equal(pg.items[0].str, "Testzeile eins");
      const b = pg.boxes[0];
      assert.ok(Math.abs(b.x - 48) <= 3 && Math.abs(b.y - 57) <= 4, `Position stimmt (x=${b.x}, y=${b.y})`);
      assert.ok(Math.abs(b.w - 323) <= 6, `Breite stimmt (w=${b.w})`);
    }
    await doc.close();
  }

  // Deskew für Tesseract: Schräglage schätzen, Bild begradigen, Zeilen auf die schräge Originalseite zurückrechnen
  {
    const skewedPage = (degrees: number) => {
      const c = createCanvas(1240, 1754);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1240, 1754);
      ctx.translate(620, 877);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.fillStyle = "#000";
      for (let row = 0; row < 40; row++) {
        for (let x = -450; x < 450; x += 34) ctx.fillRect(x, -800 + row * 40, 24 + ((row * 7 + x) % 5), 14); // "Wörter"
      }
      return c;
    };
    const pageCanvas = async (jpeg: Buffer) => {
      const img = await loadImage(jpeg);
      const c = createCanvas(img.width, img.height);
      c.getContext("2d").drawImage(img, 0, 0);
      return c;
    };
    const gray = (c: ReturnType<typeof createCanvas>) => ({ data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height, stride: 4 });
    for (const deg of [0, 3, -4, 6.5]) {
      const found = detectSkew(gray(skewedPage(deg)));
      assert.ok(Math.abs(found - deg) <= 0.4, `Schräglage ${deg}° erkannt (gefunden: ${found}°)`);
    }
    assert.equal(detectSkew({ data: new Uint8Array(100 * 100).fill(255), width: 100, height: 100, stride: 1 }), 0, "leere Seite: keine Schräglage");

    const doc2 = await PDFDocument.create();
    for (const deg of [3, 0]) {
      const pg2 = doc2.addPage([595, 842]);
      pg2.drawImage(await doc2.embedPng(await skewedPage(deg).encode("png")), { x: 0, y: 0, width: 595, height: 842 });
    }
    const skewedPdf = await doc2.save();
    let seenSkew = Infinity;
    const middleLine = async (png: Buffer) => {
      const img = await loadImage(png);
      const c = createCanvas(img.width, img.height);
      c.getContext("2d").drawImage(img, 0, 0);
      seenSkew = detectSkew(gray(c));
      return [{ text: "Mitte", x: img.width / 2 - 100, y: img.height / 2 - 20, w: 200, h: 40, conf: 90 }];
    };

    // begradigte Ausgabe (Standard bei deskew): neues Bild, waagerechte Textzeile, zweite (gerade) Seite unverändert
    const straight = await ocrWithTesseract(skewedPdf, { locale: "de-DE", deskew: true, recognize: middleLine });
    const dS = await openPdf(straight);
    assert.equal(dS.pdf.numPages, 2);
    const s1 = await extractPage(dS.pdf, 1, 1600);
    assert.ok(Math.abs(detectSkew(gray(await pageCanvas(s1.image.jpeg)))) <= 0.4, "Ausgabeseite 1 ist begradigt");
    const angleS = (Math.atan2(s1.items[0].transform[1], s1.items[0].transform[0]) * 180) / Math.PI;
    assert.ok(Math.abs(angleS) <= 0.05, `Textzeile der begradigten Seite ist waagerecht (${angleS.toFixed(2)}°)`);
    assert.ok(Math.abs(s1.items[0].transform[4] - 595 / 2) < 60 && Math.abs(s1.items[0].transform[5] - 842 / 2) < 30, "Zeile liegt in der Seitenmitte");
    assert.equal((await extractPage(dS.pdf, 2, 300)).items.length, 1, "Seite 2 hat ihre Zeile");
    await dS.close();

    // nur fürs Erkennen begradigen: Original bleibt, Zeile folgt der Schräglage
    const out2 = await ocrWithTesseract(skewedPdf, {
      locale: "de-DE",
      deskew: true,
      straighten: false,
      // die Zeile liegt in der Mitte des begradigten Bilds: zurückgerechnet muss sie in der Seitenmitte landen, um 3° geneigt
      recognize: middleLine,
    });
    assert.ok(Math.abs(seenSkew) <= 0.4, `Tesseract bekommt ein begradigtes Bild (Rest: ${seenSkew}°)`);
    const d2 = await openPdf(out2);
    const pageItem = (await extractPage(d2.pdf, 1, 800)).items[0];
    await d2.close();
    const angle = (Math.atan2(pageItem.transform[1], pageItem.transform[0]) * 180) / Math.PI;
    assert.ok(Math.abs(angle + 3) <= 0.4, `Textzeile folgt der Schräglage der Originalseite (Winkel ${angle.toFixed(2)}°)`);
    assert.ok(Math.abs(pageItem.transform[4] - 595 / 2) < 60 && Math.abs(pageItem.transform[5] - 842 / 2) < 30, "Zeile liegt in der Seitenmitte");
  }

  // Farbiges Papier (blauer Kassenbon): Hintergrund herausrechnen und Schräglage trotz Blattkante finden
  {
    const c = createCanvas(1240, 1754);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1240, 1754);
    ctx.translate(620, 877);
    ctx.rotate((20 * Math.PI) / 180);
    ctx.fillStyle = "rgb(110,160,195)"; // blaues Papier
    ctx.fillRect(-250, -600, 500, 1200);
    ctx.fillStyle = "#222";
    for (let row = 0; row < 24; row++) for (let x = -200; x < 200; x += 30) ctx.fillRect(x, -560 + row * 46, 20 + ((row * 5 + x) % 6), 14);
    const found = detectSkew({ data: c.getContext("2d").getImageData(0, 0, 1240, 1754).data, width: 1240, height: 1754, stride: 4 });
    assert.ok(Math.abs(found - 20) <= 0.6, `Schräglage auf blauem Papier erkannt (gefunden: ${found}°)`);
    const flat = flattenBackground(c);
    const px = flat.getContext("2d").getImageData(0, 0, 1240, 1754).data;
    const at = (x: number, y: number) => px[(y * 1240 + x) * 4];
    const [paperX, paperY] = [Math.round(620 + 100 * Math.cos(0.35) - 400 * Math.sin(0.35)), Math.round(877 + 100 * Math.sin(0.35) + 400 * Math.cos(0.35))];
    assert.ok(at(20, 20) > 240 && at(paperX, paperY) > 200, `Papier (weiß und blau) wird hell (blau: ${at(paperX, paperY)})`);
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 90) dark++;
    assert.ok(dark > 2000, `Tinte bleibt dunkel (${dark} Pixel)`);
  }

  await fallbackScenario();

  const out = path.join(process.env.SMOKE_OUT ?? ".", "smoke-refined.pdf");
  if (process.env.SMOKE_OUT) fs.writeFileSync(out, result.pdf);
  console.log(`OK – ${result.corrections} Korrekturen, ${a1.items.length} Boxen, ${result.pdf.length} Bytes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
