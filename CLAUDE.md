# CLAUDE.md

**pdf-adobe-ocr** — CLI und HTTP-Service (Node/TypeScript, Express, per docker compose betreibbar), der gescannte PDFs über die Adobe PDF Services API (`@adobe/pdfservices-node-sdk`, OCR-Job) durchsuchbar macht – optional mit LLM-Nachbearbeitung (Anthropic/OpenAI) der Adobe-Textboxen. Doku auf Deutsch, siehe README.md.

- `src/ocr.ts` — Adobe-Client + Upload → OCRJob → Download; `ocrStream` (API) und `ocrPdf` (CLI, schreibt atomar über `.part`-Datei)
- `src/refine.ts` — LLM-Nachbearbeitung eines Adobe-PDFs: pro Seite rendern + Boxen extrahieren, Modell korrigieren lassen (`Correction[]`), betroffene Seiten neu schreiben
- `src/llm/` — `anthropic.ts`/`openai.ts` (je ein `LlmClient`), `prompt.ts` (Prompt, JSON-Schema, tolerantes Parsen), `index.ts` (`llmSetup()`: Anbieter/Modell ausschließlich aus `LLM_PROVIDER`/`LLM_MODEL` der .env; der Request schaltet nur per `llm=true` ein/aus – bewusste Entscheidung des Betreibers, keine Modellwahl per API)
- `src/pdf/pages.ts` (pdf.js: Seitenbild als JPEG + Textboxen), `src/pdf/textlayer.ts` (alte Textebene per Content-Stream-Scanner entfernen, neue unsichtbare Ebene mit DejaVu Sans schreiben)
- `scripts/smoke-refine.ts` (`npm run smoke`) — Smoke-Test mit synthetischem Adobe-PDF und Stub-Modell; läuft ohne Zugangsdaten, prüft u. a. Tokenizer-Sonderfälle. Nach Änderungen an `src/pdf/` oder `src/refine.ts` ausführen
- `src/options.ts` — Sprach-/Typ-Parsing, von CLI und API geteilt
- `src/server.ts` — Express-API (`POST /api/ocr`, `/api/languages`, `/api/llm`, `/health`), optionaler `API_KEY`, Upload nach tmp und Aufräumen im `finally`
- `src/logger.ts` — dependency-freier Logger (stdout/stderr, `LOG_LEVEL`/`LOG_FORMAT`, liest Config lazy wegen spätem `loadEnvFile`); `src/sdk-logging.ts` leitet die log4js-Ausgabe des Adobe-SDK dorthin um (muss nach dem SDK-Import laufen). Im Server `logger` statt `console.*` verwenden, nie API-Key/Dateiinhalte loggen
- `public/index.html` — Testseite (Upload → `/api/ocr` → PDF-Anzeige, Download, Textlayer via pdf.js); pdf.js kommt als Dependency `pdfjs-dist` und wird unter `/vendor/pdfjs` aus `node_modules` ausgeliefert
- `Dockerfile`, `docker-compose.yml` — Deployment; Image-Build und Container-Start (mit Dummy-Credentials: Health, Testseite, pdf.js) in der WSL getestet; ein echter OCR-Lauf mit Adobe-Credentials steht noch aus
- `src/index.ts` — CLI (`util.parseArgs`), Datei/Ordner-Handling, überspringt vorhandene Ausgaben
- Bei API-Änderungen README (API-Abschnitt) mitpflegen.
- **Designregel LLM:** Das Modell liefert nur **Text** (Korrekturen `id → Text` je Adobe-Box), **Positionen** kommen immer von Adobe. Nie das Modell Koordinaten liefern lassen (gleiche Entscheidung wie im Schwesterprojekt `pdf-llm-ocr`, dort bewusst verworfen).
- **Fallen:** pdf.js ist ESM-only → im CommonJS-Build nur per dynamischem `import()` (`loadPdfJs`). Env-Variablen (`LLM_*`, API-Keys) immer erst zur Laufzeit lesen, nicht beim Import – `.env` wird nach den Imports geladen. `effort` nur an Anthropic-Modelle schicken, die es kennen (Regex `SUPPORTS_EFFORT`), sonst 400. Keine Modell-IDs aus dem Gedächtnis: Anthropic-Standard `claude-opus-5`, OpenAI bewusst ohne Standard (`LLM_MODEL` Pflicht).
- **Nicht verifiziert:** echte Aufrufe gegen Adobe/Anthropic/OpenAI (keine Zugangsdaten in der Entwicklungsumgebung). Getestet: Smoke-Test, SDK-Request-Formen gegen Fake-Server, Docker-Build/-Start in der WSL. Ob echte Adobe-Boxen Wort- oder Zeilenebene sind, ist offen; der Code ist granularitätsneutral gebaut.
- Credentials nur per `.env` (gitignored); nie ins Repo.
- Kein Test-Framework; Sicherheitsnetz: `npm run typecheck` und `npm run smoke`.
- Nur auf ausdrücklichen Wunsch committen/pushen.
