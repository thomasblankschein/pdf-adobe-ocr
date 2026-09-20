# CLAUDE.md

**pdf-adobe-ocr** — CLI (Node/TypeScript, `tsx`), das gescannte PDFs über die Adobe PDF Services API (`@adobe/pdfservices-node-sdk`, OCR-Job) durchsuchbar macht. Doku auf Deutsch, siehe README.md.

- `src/ocr.ts` — Adobe-Client + Upload → OCRJob → Download (schreibt atomar über `.part`-Datei)
- `src/index.ts` — CLI (`util.parseArgs`), Datei/Ordner-Handling, überspringt vorhandene Ausgaben
- Credentials nur per `.env` (gitignored); nie ins Repo.
- Kein Test-Framework; Sicherheitsnetz: `npm run typecheck`.
- Nur auf ausdrücklichen Wunsch committen/pushen.
