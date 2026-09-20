import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { OCRSupportedLocale, OCRSupportedType } from "@adobe/pdfservices-node-sdk";
import { createClient, ocrPdf } from "./ocr";

try {
  process.loadEnvFile();
} catch {
  // keine .env – Umgebungsvariablen können auch direkt gesetzt sein
}

const USAGE = `Verwendung: npm run ocr -- <datei.pdf | ordner> [Optionen]

  -o, --out <ordner>    Ausgabeordner (Standard: ./output)
  -l, --lang <locale>   OCR-Sprache, z. B. de-DE, en-US (Standard: de-DE)
  -t, --type <typ>      exact (Standard, Original-Bild unverändert) | deskew (Bild wird begradigt)
  -f, --force           vorhandene Ausgabedateien überschreiben
  -h, --help
`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o", default: "output" },
    lang: { type: "string", short: "l", default: "de-DE" },
    type: { type: "string", short: "t", default: "exact" },
    force: { type: "boolean", short: "f", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const locale = Object.values(OCRSupportedLocale).find((l) => l === values.lang);
if (!locale) fail(`Unbekannte Sprache "${values.lang}".`);
const type =
  values.type === "exact"
    ? OCRSupportedType.SEARCHABLE_IMAGE_EXACT
    : values.type === "deskew"
      ? OCRSupportedType.SEARCHABLE_IMAGE
      : fail(`Unbekannter Typ "${values.type}" (exact | deskew).`);

const target = path.resolve(positionals[0]);
if (!fs.existsSync(target)) fail(`Nicht gefunden: ${target}`);

const inputs = fs.statSync(target).isDirectory()
  ? fs
      .readdirSync(target)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => path.join(target, f))
  : [target];
if (inputs.length === 0) fail("Keine PDF-Dateien gefunden.");

const outDir = path.resolve(values.out!);
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const client = createClient();
  let ok = 0, skipped = 0, failed = 0;

  for (const input of inputs) {
    const outPath = path.join(outDir, `${path.basename(input, path.extname(input))}.ocr.pdf`);
    if (fs.existsSync(outPath) && !values.force) {
      console.log(`– übersprungen (existiert): ${path.basename(outPath)}`);
      skipped++;
      continue;
    }
    process.stdout.write(`… ${path.basename(input)} `);
    try {
      await ocrPdf(client, input, outPath, { locale: locale!, type });
      console.log("✓");
      ok++;
    } catch (err) {
      console.log("✗");
      console.error(`  ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\nFertig: ${ok} verarbeitet, ${skipped} übersprungen, ${failed} fehlgeschlagen.`);
  if (failed > 0) process.exit(1);
}

main();
