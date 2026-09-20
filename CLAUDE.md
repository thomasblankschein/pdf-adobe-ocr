# CLAUDE.md

**pdf-adobe-ocr** — CLI und HTTP-Service (Node/TypeScript, Express, per docker compose betreibbar), der gescannte PDFs über die Adobe PDF Services API (`@adobe/pdfservices-node-sdk`, OCR-Job) durchsuchbar macht. Doku auf Deutsch, siehe README.md.

- `src/ocr.ts` — Adobe-Client + Upload → OCRJob → Download; `ocrStream` (API) und `ocrPdf` (CLI, schreibt atomar über `.part`-Datei)
- `src/options.ts` — Sprach-/Typ-Parsing, von CLI und API geteilt
- `src/server.ts` — Express-API (`POST /api/ocr`, `/api/languages`, `/health`), optionaler `API_KEY`, Upload nach tmp und Aufräumen im `finally`
- `src/logger.ts` — dependency-freier Logger (stdout/stderr, `LOG_LEVEL`/`LOG_FORMAT`, liest Config lazy wegen spätem `loadEnvFile`); `src/sdk-logging.ts` leitet die log4js-Ausgabe des Adobe-SDK dorthin um (muss nach dem SDK-Import laufen). Im Server `logger` statt `console.*` verwenden, nie API-Key/Dateiinhalte loggen
- `public/index.html` — Testseite (Upload → `/api/ocr` → PDF-Anzeige, Download, Textlayer via pdf.js); pdf.js kommt als Dependency `pdfjs-dist` und wird unter `/vendor/pdfjs` aus `node_modules` ausgeliefert
- `Dockerfile`, `docker-compose.yml` — Deployment; Image-Build und Container-Start (mit Dummy-Credentials: Health, Testseite, pdf.js) in der WSL getestet; ein echter OCR-Lauf mit Adobe-Credentials steht noch aus
- `src/index.ts` — CLI (`util.parseArgs`), Datei/Ordner-Handling, überspringt vorhandene Ausgaben
- Bei API-Änderungen README (API-Abschnitt) mitpflegen.
- Credentials nur per `.env` (gitignored); nie ins Repo.
- Kein Test-Framework; Sicherheitsnetz: `npm run typecheck`.
- Nur auf ausdrücklichen Wunsch committen/pushen.
