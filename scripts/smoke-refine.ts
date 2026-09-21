// Smoke-Test der LLM-Nachbearbeitung ohne Adobe-Zugang und ohne API-Key:
// Erzeugt ein synthetisches "Adobe-Ergebnis" (Scan-Bild + unsichtbarer, fehlerhafter Textlayer),
// lässt ein Stub-LLM die Fehler korrigieren und prüft das Ergebnis-PDF.
//   npm run smoke
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Correction, LlmClient, PageImage, RawMeta, TextBox, TranscribedLine, Transcription } from "../src/llm/types";
import { buildDocumentMeta, cleanName, slug, validDate } from "../src/meta";
import { extractPage, openPdf, type PageItem } from "../src/pdf/pages";
import { enhanceForReading, isJunkLayer, pageHasInk } from "../src/pdf/quality";
import { buildEntries, layoutLines, stripTextObjects } from "../src/pdf/textlayer";
import { refinePdf } from "../src/refine";

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
  assert.equal(slug("../../etc/passwd", 60), "etc-passwd", "keine Pfadtrenner im Dateinamen");

  const now = new Date("2026-09-20T12:00:00Z");
  assert.equal(validDate("2026-09-20", now), "2026-09-20");
  assert.equal(validDate("2026-02-30", now), undefined, "31.-Tag-Fehler");
  assert.equal(validDate("20.09.2026", now), undefined, "falsches Format");
  assert.equal(validDate("1900-01-01", now), undefined, "zu alt");
  assert.equal(validDate("2099-01-01", now), undefined, "zu weit in der Zukunft");

  const raw = (o: Partial<RawMeta>): RawMeta => ({ date: "2026-09-20", correspondent: "Telekom", summary: "Rechnung Mobilfunk", confidence: "high", ...o });
  assert.equal(buildDocumentMeta(raw({}), undefined, now).path, "Telekom/2026-09-20_Rechnung-Mobilfunk.pdf");
  assert.equal(buildDocumentMeta(raw({ correspondent: "" }), undefined, now).path, "_Unbekannt/2026-09-20_Rechnung-Mobilfunk.pdf");
  assert.equal(buildDocumentMeta(raw({ confidence: "low" }), undefined, now).path, "_Pruefen/2026-09-20_Telekom_Rechnung-Mobilfunk.pdf");
  assert.equal(buildDocumentMeta(raw({ confidence: "medium" }), undefined, now).path, "Telekom/2026-09-20_Rechnung-Mobilfunk.pdf", "medium bleibt im Korrespondenten-Ordner");
  const noDate = buildDocumentMeta(raw({ date: "" }), "2026-09-19", now);
  assert.equal(noDate.path, "Telekom/2026-09-19_Rechnung-Mobilfunk.pdf");
  assert.equal(noDate.dateSource, "scan");
  assert.equal(buildDocumentMeta(raw({ date: "", summary: "" }), undefined, now).path, "Telekom/ohne-Datum_Scan.pdf");
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

  await fallbackScenario();

  const out = path.join(process.env.SMOKE_OUT ?? ".", "smoke-refined.pdf");
  if (process.env.SMOKE_OUT) fs.writeFileSync(out, result.pdf);
  console.log(`OK – ${result.corrections} Korrekturen, ${a1.items.length} Boxen, ${result.pdf.length} Bytes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
