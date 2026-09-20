// Smoke-Test der LLM-Nachbearbeitung ohne Adobe-Zugang und ohne API-Key:
// Erzeugt ein synthetisches "Adobe-Ergebnis" (Scan-Bild + unsichtbarer, fehlerhafter Textlayer),
// lässt ein Stub-LLM die Fehler korrigieren und prüft das Ergebnis-PDF.
//   npm run smoke
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Correction, LlmClient, PageImage, TextBox } from "../src/llm/types";
import { extractPage, openPdf } from "../src/pdf/pages";
import { stripTextObjects } from "../src/pdf/textlayer";
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
const FIXES: Record<string, string> = {
  "Rechnungsnurnmer": "Rechnungsnummer",
  "~~^^": "",
};
let calls = 0;
const stub: LlmClient = {
  label: "stub/none",
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

async function main() {
  const input = await buildAdobeLikePdf();
  const result = await refinePdf(input, { client: stub, maxImagePx: 1200, concurrency: 2, maxBoxesPerCall: 800 });

  assert.equal(result.pages, 2);
  assert.equal(result.pagesRefined, 1, "nur Seite 1 wurde verändert");
  assert.equal(result.pagesFailed, 0);
  assert.equal(calls, 2, "jede Seite wurde einmal an das Modell geschickt");

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

  const out = path.join(process.env.SMOKE_OUT ?? ".", "smoke-refined.pdf");
  if (process.env.SMOKE_OUT) fs.writeFileSync(out, result.pdf);
  console.log(`OK – ${result.corrections} Korrekturen, ${a1.items.length} Boxen, ${result.pdf.length} Bytes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
