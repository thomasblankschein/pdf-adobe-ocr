# pdf-adobe-ocr

Kommandozeilenwerkzeug, das gescannte PDFs über die **Adobe PDF Services API** (OCR-Operation) mit einem unsichtbaren, durchsuchbaren Textlayer versieht. Das Originalbild bleibt erhalten.

## Einrichtung

1. In der [Adobe Developer Console](https://developer.adobe.com/console) ein Projekt mit der API **PDF Services** anlegen und die Credentials (Client ID + Client Secret) erzeugen.
2. `.env.example` nach `.env` kopieren und beide Werte eintragen.
3. `npm install`

## Verwendung

```bash
npm run ocr -- scan.pdf
npm run ocr -- ./scans -o ./ergebnis -l de-DE
```

| Option | Bedeutung |
|---|---|
| `-o, --out` | Ausgabeordner (Standard `./output`), Ergebnis heißt `<name>.ocr.pdf` |
| `-l, --lang` | OCR-Sprache (Standard `de-DE`) |
| `-t, --type` | `exact` (Standard): Originalbild unverändert; `deskew`: Bild wird begradigt |
| `-f, --force` | vorhandene Ausgabedateien überschreiben (sonst übersprungen) |

Bei einem Ordner als Eingabe werden alle `*.pdf` darin nacheinander verarbeitet; Fehler einzelner Dateien brechen den Lauf nicht ab (Exit-Code 1 am Ende).

## Hinweise

- Jeder Aufruf verbraucht Adobe-Transaktionen (Kontingent laut Adobe-Konto). Bereits verarbeitete Dateien werden deshalb standardmäßig übersprungen.
- Die Dokumente werden zur Verarbeitung an Adobe übertragen – für vertrauliche Unterlagen bedenken.
- Typecheck: `npm run typecheck`
