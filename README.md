# pdf-adobe-ocr

Macht gescannte PDFs durchsuchbar: Die Dokumente werden über die **Adobe PDF Services API** (OCR-Operation) mit einem unsichtbaren Textlayer versehen, das Originalbild bleibt erhalten.

Das Projekt bietet drei Wege zur Nutzung:

| Weg | Wofür |
|---|---|
| **HTTP-API** (`POST /api/ocr`) | Einbindung in andere Programme und Skripte |
| **Testseite** (`/`) | Ausprobieren im Browser: Upload, Ergebnis-PDF, Download, Textlayer als Plaintext |
| **Kommandozeile** (`npm run ocr`) | einzelne Dateien oder ganze Ordner stapelweise verarbeiten |

Service und Testseite laufen per `docker compose`; das CLI läuft direkt mit Node.js.

## Voraussetzungen

- **Adobe-Zugangsdaten:** In der [Adobe Developer Console](https://developer.adobe.com/console) ein Projekt mit der API **PDF Services** anlegen und die Credentials (Client ID + Client Secret) erzeugen.
- Für den Service: Docker mit Compose (Compose v2, `docker compose`).
- Für CLI und lokale Entwicklung: Node.js ≥ 22.

## Schnellstart (Docker)

```bash
cp .env.example .env
# .env bearbeiten: PDF_SERVICES_CLIENT_ID, PDF_SERVICES_CLIENT_SECRET und API_KEY eintragen
docker compose up -d --build
```

Danach:

- Testseite: <http://localhost:3000/>
- Logs: `docker compose logs -f`
- Stoppen: `docker compose down`

Einen zufälligen API-Key erzeugt z. B. dieser Befehl:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Fehlen die Adobe-Credentials, beendet sich der Service beim Start mit einer entsprechenden Logmeldung (`start abgebrochen`) und startet wegen `restart: unless-stopped` immer wieder neu – dann `.env` korrigieren und `docker compose up -d` wiederholen.

### Betrieb in WSL

Der Service läuft unverändert in einer WSL-Distribution mit Docker. Das Projekt am besten im Linux-Dateisystem ablegen (z. B. `~/pdf-adobe-ocr`) statt unter `/mnt/c/…`, das beschleunigt den Build. Die Testseite ist dann auch von Windows aus unter `http://localhost:3000/` erreichbar. Beim Kopieren von Windows aus darauf achten, dass `.env`, `node_modules` und `dist` nicht mitgenommen werden.

## Konfiguration

Alle Einstellungen erfolgen über Umgebungsvariablen (bei Docker über die `.env`, siehe `.env.example`):

| Variable | Bedeutung | Standard |
|---|---|---|
| `PDF_SERVICES_CLIENT_ID` | Adobe Client ID (**Pflicht**) | – |
| `PDF_SERVICES_CLIENT_SECRET` | Adobe Client Secret (**Pflicht**) | – |
| `API_KEY` | schützt `/api/*`; leer = **ungeschützt** (nur in vertrauenswürdigen Netzen!) | leer |
| `PORT` | Port auf dem Host (im Container lauscht der Service immer auf 3000) | `3000` |
| `MAX_UPLOAD_MB` | maximale Größe einer hochgeladenen PDF (Adobe-Limit für OCR: 100 MB) | `100` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_FORMAT` | `json` oder `text` | `json` im Container, `text` lokal |

## Den Service nutzen

### Testseite

Unter `http://localhost:3000/` ist eine einfache Weboberfläche:

1. PDF-Datei auswählen; optional Sprache und OCR-Typ einstellen und – falls ein `API_KEY` gesetzt ist – diesen eintragen (wird nur in der Browser-Session gemerkt).
2. **OCR starten.** Die Verarbeitung dauert je nach Seitenzahl einige Sekunden bis Minuten.
3. Die Seite zeigt das erzeugte Dokument im Browser-Viewer, bietet es zum **Herunterladen** an (`<name>.ocr.pdf`) und zeigt den **Textlayer** als Plaintext, getrennt nach Seiten (per pdf.js im Browser ausgelesen), mit Kopieren-Button.

So lässt sich sofort prüfen, wie gut die Texterkennung bei einem Dokument funktioniert.

### HTTP-API

| Endpoint | Zweck | Auth |
|---|---|---|
| `POST /api/ocr` | PDF per OCR durchsuchbar machen | ja |
| `GET /api/languages` | unterstützte OCR-Sprachen (`{"default": …, "languages": […]}`) | ja |
| `GET /health` | Health-Check (`{"status":"ok"}`) | nein |

**Authentifizierung** (nur wenn `API_KEY` gesetzt ist): Header `X-API-Key: <key>` oder `Authorization: Bearer <key>`.

**`POST /api/ocr`** erwartet `multipart/form-data`:

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `file` | ja | die PDF-Datei (max. `MAX_UPLOAD_MB`) |
| `lang` | nein | OCR-Sprache, Standard `de-DE` (Liste über `GET /api/languages`) |
| `type` | nein | `exact` (Standard): Originalbild bleibt unverändert; `deskew`: Bild wird begradigt |

Die Antwort ist die OCR-PDF (`Content-Type: application/pdf`, Dateiname `<name>.ocr.pdf` im `Content-Disposition`-Header). Der Aufruf ist **synchron** – Client-Timeouts entsprechend großzügig setzen.

```bash
curl -X POST http://localhost:3000/api/ocr \
  -H "X-API-Key: <key>" \
  -F file=@scan.pdf \
  -F lang=de-DE \
  -o scan.ocr.pdf
```

```bash
# verfügbare Sprachen
curl -H "X-API-Key: <key>" http://localhost:3000/api/languages
```

**Fehler** kommen als JSON `{"error": "…"}`:

| Status | Ursache |
|---|---|
| `400` | ungültige Eingabe (kein `file`, unbekannte Sprache oder Typ) |
| `401` | fehlender oder falscher API-Key |
| `413` | Datei größer als `MAX_UPLOAD_MB` |
| `502` | Fehler bei Adobe (z. B. ungültige Credentials, Kontingent erschöpft, beschädigte PDF) |

Jede Antwort trägt einen Header `X-Request-Id`, mit dem sich der Aufruf im Log wiederfinden lässt.

### Kommandozeile

Für die stapelweise Verarbeitung ohne Service. Setzt `npm install` und eine `.env` mit den Adobe-Credentials voraus.

```bash
npm install
npm run ocr -- scan.pdf
npm run ocr -- ./scans -o ./ergebnis -l de-DE
```

| Option | Bedeutung |
|---|---|
| `-o, --out` | Ausgabeordner (Standard `./output`), Ergebnis heißt `<name>.ocr.pdf` |
| `-l, --lang` | OCR-Sprache (Standard `de-DE`) |
| `-t, --type` | `exact` (Standard) oder `deskew` |
| `-f, --force` | vorhandene Ausgabedateien überschreiben (sonst werden sie übersprungen, um Adobe-Transaktionen zu sparen) |

Bei einem Ordner als Eingabe werden alle `*.pdf` darin nacheinander verarbeitet. Fehler einzelner Dateien brechen den Lauf nicht ab; am Ende steht eine Zusammenfassung, und der Exit-Code ist 1, wenn Dateien fehlgeschlagen sind.

## Logging

Der Service loggt ausschließlich über die Standardwege: `info`/`debug` nach **stdout**, `warn`/`error` nach **stderr** – im Container also per `docker compose logs -f` einsehbar. Docker rotiert die Log-Dateien (3 × 10 MB, siehe `docker-compose.yml`).

Beispiel (`LOG_FORMAT=text`):

```
2026-09-20T14:47:47.889Z INFO  service gestartet port=3000 maxUploadMb=100 apiKey=gesetzt
2026-09-20T14:47:49.717Z INFO  ocr start reqId=8d6f40eb file=scan.pdf sizeKb=812 lang=de-DE type=searchable_image_exact
2026-09-20T14:47:58.201Z INFO  ocr adobe fertig reqId=8d6f40eb ms=8484
2026-09-20T14:47:58.350Z INFO  ocr ausgeliefert reqId=8d6f40eb bytes=1049812 ms=8633
2026-09-20T14:47:58.352Z INFO  request reqId=8d6f40eb method=POST path=/api/ocr status=200 ms=8636 ip=172.18.0.1
```

- Pro API-Request gibt es eine Zeile `request` (Methode, Pfad, Status, Dauer, IP) mit der `reqId`; alle Einträge zu einem Aufruf teilen sich diese ID.
- OCR-Aufrufe erzeugen `ocr start`, `ocr adobe fertig` und `ocr ausgeliefert` bzw. bei Fehlern `ocr fehlgeschlagen` (mit Stacktrace). Fehlgeschlagene Authentifizierung und abgelehnte Uploads sind `warn`.
- Statische Dateien und `/health` erscheinen nur auf `debug`, damit der Docker-Healthcheck das Log nicht füllt.
- Dateiinhalte und API-Keys werden nie geloggt.
- Meldungen des Adobe-SDK erscheinen mit Präfix `sdk:` im selben Format (Info-Meldungen nur auf `debug`). Nur die einmalige SDK-Zeile „No logging configuration…“ beim Start lässt sich nicht unterdrücken.

## Entwicklung

```bash
npm run serve       # Service lokal mit tsx (liest .env)
npm run build       # TypeScript nach dist/ kompilieren
npm start           # kompilierten Service starten
npm run typecheck   # Typprüfung (einziges automatisches Sicherheitsnetz, kein Testframework)
```

Aufbau:

```
src/server.ts        Express-API: /api/ocr, /api/languages, /health, Request-Logging, API-Key
src/ocr.ts           Adobe-Anbindung: Upload → OCR-Job → Download (ocrStream, ocrPdf)
src/options.ts       Sprach-/Typ-Parsing, gemeinsam für CLI und API
src/index.ts         Kommandozeile
src/logger.ts        Logger (stdout/stderr, LOG_LEVEL / LOG_FORMAT)
src/sdk-logging.ts   leitet die Log-Ausgabe des Adobe-SDK in den Logger um
public/index.html    Testseite (pdf.js wird aus node_modules unter /vendor/pdfjs ausgeliefert)
Dockerfile, docker-compose.yml
```

## Hinweise

- **Kosten/Kontingent:** Jeder OCR-Aufruf verbraucht Adobe-Transaktionen (Kontingent laut Adobe-Konto). Das CLI überspringt vorhandene Ausgaben; der Service verarbeitet jeden Aufruf neu.
- **Datenschutz:** Die Dokumente werden zur Verarbeitung an Adobe übertragen – bei vertraulichen Unterlagen bedenken. Der Service selbst speichert nichts dauerhaft; hochgeladene Dateien liegen nur für die Dauer des Aufrufs im temporären Verzeichnis.
- **Absicherung:** Der Service bringt kein TLS und keine Benutzerverwaltung mit. Für den Zugriff über ein Netzwerk einen `API_KEY` setzen und ihn hinter einem Reverse-Proxy mit HTTPS betreiben.

## Lizenz

[MIT](LICENSE) © 2026 Thomas Blankschein. Die Nutzung der Adobe PDF Services API unterliegt den Bedingungen von Adobe.
