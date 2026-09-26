# pdf-adobe-ocr

Macht gescannte PDFs durchsuchbar: Die Dokumente werden über die **Adobe PDF Services API** (OCR-Operation) mit einem unsichtbaren Textlayer versehen, das Originalbild bleibt erhalten.

Das Projekt bietet drei Wege zur Nutzung:

| Weg | Wofür |
|---|---|
| **HTTP-API** (`POST /api/ocr`) | Einbindung in andere Programme und Skripte |
| **Testseite** (`/`) | Ausprobieren im Browser: Upload, Ergebnis-PDF, Download, Textlayer als Plaintext |
| **Kommandozeile** (`npm run ocr`) | einzelne Dateien oder ganze Ordner stapelweise verarbeiten |

Service und Testseite laufen per `docker compose`; das CLI läuft direkt mit Node.js.

**Optional: LLM-Nachbearbeitung.** Die Texterkennung von Adobe ist bei schlechten Scans oft mäßig. Auf Wunsch (pro Request) schaut anschließend ein Vision-LLM von **Anthropic** oder **OpenAI** auf die Seite und korrigiert den Text der von Adobe gefundenen Textboxen. Die Positionen bleiben die von Adobe. Anbieter und Modell legt der Betreiber in der `.env` fest; der Request schaltet die Nachbearbeitung nur ein oder aus – siehe [LLM-Nachbearbeitung](#llm-nachbearbeitung).

## Voraussetzungen

- **Adobe-Zugangsdaten** (nur für `OCR_ENGINE=adobe`, siehe [OCR-Engine](#ocr-engine-adobe-oder-tesseract)): In der [Adobe Developer Console](https://developer.adobe.com/console) ein Projekt mit der API **PDF Services** anlegen und die Credentials (Client ID + Client Secret) erzeugen.
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
| `OCR_ENGINE` | `adobe` (Standard) oder `tesseract` (ohne Adobe, siehe [OCR-Engine](#ocr-engine-adobe-oder-tesseract)) | `adobe` |
| `OCR_FALLBACK` | `tesseract`: bei erschöpftem Adobe-Kontingent (HTTP 429 / `QUOTA_EXCEEDED`) läuft die Anfrage stattdessen mit Tesseract; `none` = kein Ausweichen | `none` |
| `TESSERACT_LANGS` | Sprachen für Tesseract (z. B. `deu+eng`); leer = Sprache des Requests plus Englisch, soweit installiert | leer |
| `TESSERACT_DPI` | Auflösung, mit der die Seiten für Tesseract gerendert werden | `300` |
| `TESSERACT_PSM` | Seitensegmentierung von Tesseract (`3` automatisch, `4` eine Spalte variabler Größe, `11` sparse text) | `3` |
| `TESSERACT_DESKEW_OUTPUT` | bei `type=deskew` die Seite begradigt ausgeben (`true`) oder nur fürs Erkennen begradigen und das Original behalten (`false`) | `true` |
| `TESSERACT_JPEG_QUALITY` | JPEG-Qualität (1–100) der begradigten Seiten | `85` |
| `TESSERACT_DESKEW_MAX` | größte Schräglage in Grad, die bei `type=deskew` ausgeglichen wird; stärker gedrehte Seiten bleiben unverändert | `30` |
| `TESSERACT_FLATTEN` | Papierhintergrund fürs Erkennungsbild herausrechnen (`false` schaltet ab). Nötig für farbiges Papier: Ohne findet Tesseract auf blauen Kassenbons keine Wörter | `true` |
| `TESSERACT_MIN_CONF` | Zeilen unter dieser mittleren Wortsicherheit (0–100) gelten als Rauschen und werden verworfen | `10` |
| `API_KEY` | schützt `/api/*`; leer = **ungeschützt** (nur in vertrauenswürdigen Netzen!) | leer |
| `PORT` | Port auf dem Host (im Container lauscht der Service immer auf 3000) | `3000` |
| `MAX_UPLOAD_MB` | maximale Größe einer hochgeladenen PDF (Adobe-Limit für OCR: 100 MB) | `100` |
| `LLM_PROVIDER` | Anbieter der LLM-Nachbearbeitung: `anthropic` oder `openai`; leer = Nachbearbeitung nicht verfügbar | leer |
| `LLM_MODEL` | Modell des gewählten Anbieters (muss Bildeingabe und strukturierte Ausgaben unterstützen) | bei `anthropic` `claude-opus-5`; bei `openai` **Pflicht** |
| `ANTHROPIC_API_KEY` | API-Key für `LLM_PROVIDER=anthropic` | leer |
| `OPENAI_API_KEY` | API-Key für `LLM_PROVIDER=openai` | leer |
| `LLM_CONCURRENCY` | Seiten, die parallel an das Modell gehen | `3` |
| `LLM_IMAGE_MAX_PX` | lange Kante des Seitenbilds, das an das Modell geht (2576 ist die Obergrenze von Claude Sonnet 5; kleinere Schrift braucht Auflösung) | `2576` |
| `LLM_MAX_PAGES` | Seitenzahl, bis zu der ein Dokument LLM-korrigiert wird (Kostenschutz). Längere Dokumente werden mit `lenient=true` trotzdem per Adobe verarbeitet (ohne Korrektur), sonst mit `400` abgelehnt | `50` |
| `LLM_TRANSCRIBE` | Ausweichfall bei unbrauchbarer Adobe-Textebene (siehe [unten](#ausweichfall-unbrauchbare-adobe-textebene)); `false` schaltet ihn ab | `true` |
| `LLM_MAX_BOXES_PER_CALL` | maximale Textboxen pro Modellaufruf; größere Seiten werden aufgeteilt (das Modell liefert je Box einen Eintrag, daher begrenzt dies auch die Antwortlänge) | `250` |
| `LLM_MAX_PASSES` | Korrekturdurchgänge je Seite (1–5); ein weiterer Durchgang folgt nur, wenn der vorige mindestens 5 Boxen geändert hat (ein Durchgang übersieht bei schlechten Scans einen Teil der Fehler) | `3` |
| `LLM_TIMEOUT_S` | Timeout je Modellaufruf in Sekunden | `180` |
| `OWN_NAMES` | Namen, Adressen und Mailadressen des Empfängers, durch `;` getrennt (z. B. `Max Muster; Musterweg 1, 12345 Musterstadt`). Das Modell erkennt damit den Absender statt des Empfängers | leer |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_FORMAT` | `json` oder `text` | `json` im Container, `text` lokal |

## Den Service nutzen

### Testseite

Unter `http://localhost:3000/` ist eine einfache Weboberfläche:

1. PDF-Datei auswählen; optional Sprache und OCR-Typ einstellen und – falls ein `API_KEY` gesetzt ist – diesen eintragen (wird nur in der Browser-Session gemerkt). Ist in der `.env` ein LLM konfiguriert, erscheint eine Checkbox **LLM-Nachbearbeitung** (mit Anbieter und Modell); sonst ist sie ausgegraut und nennt den Grund.
2. **OCR starten.** Die Verarbeitung dauert je nach Seitenzahl einige Sekunden bis Minuten, mit LLM entsprechend länger. Nach dem Lauf zeigt die Statuszeile, wie viele Textboxen das Modell korrigiert hat.
3. Die Seite zeigt das erzeugte Dokument im Browser-Viewer, bietet es zum **Herunterladen** an (`<name>.ocr.pdf`) und zeigt den **Textlayer** als Plaintext, getrennt nach Seiten (per pdf.js im Browser ausgelesen), mit Kopieren-Button.

So lässt sich sofort prüfen, wie gut die Texterkennung bei einem Dokument funktioniert.

### HTTP-API

| Endpoint | Zweck | Auth |
|---|---|---|
| `POST /api/ocr` | PDF per OCR durchsuchbar machen | ja |
| `GET /api/languages` | unterstützte OCR-Sprachen (`{"default": …, "languages": […]}`) | ja |
| `GET /api/llm` | LLM-Konfiguration des Servers (`{"enabled", "provider", "model", "error", "maxPages"}`) | ja |
| `GET /health` | Health-Check (`{"status":"ok"}`) | nein |

**Authentifizierung** (nur wenn `API_KEY` gesetzt ist): Header `X-API-Key: <key>` oder `Authorization: Bearer <key>`.

**`POST /api/ocr`** erwartet `multipart/form-data`:

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `file` | ja | die PDF-Datei (max. `MAX_UPLOAD_MB`) |
| `lang` | nein | OCR-Sprache, Standard `de-DE` (Liste über `GET /api/languages`) |
| `type` | nein | `exact` (Standard): Originalbild bleibt unverändert; `deskew`: schiefe Seiten werden begradigt (bei Tesseract abschaltbar: `TESSERACT_DESKEW_OUTPUT=false`) |
| `llm` | nein | LLM-Nachbearbeitung ein/aus: `true` oder `false` (Standard). Anbieter und Modell kommen aus der `.env` (`LLM_PROVIDER`, `LLM_MODEL`) |
| `meta` | nein | `true`: Datum, Korrespondent und Kurzinhalt von der ersten Seite lesen und einen Ablagepfad vorschlagen (Header `X-OCR-Meta`, siehe [Dokumentdaten](#dokumentdaten-und-ablagevorschlag)). Braucht ein konfiguriertes LLM |
| `lenient` | nein | `true`: Fehler des LLM brechen die Anfrage nie ab; es kommt immer mindestens das Adobe-Ergebnis (für automatische Abläufe). Dokumente über `LLM_MAX_PAGES` Seiten werden dann nicht abgelehnt, sondern nur ohne LLM-Korrektur verarbeitet (Metadaten von Seite 1 gibt es trotzdem) |
| `scan_date` | nein | `YYYY-MM-DD`; ersetzt ein nicht lesbares Dokumentdatum im Ablagevorschlag |

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
| `400` | ungültige Eingabe (kein `file`, unbekannte Sprache oder Typ; bei `llm=true`: ungültiger Wert, LLM auf dem Server nicht oder fehlerhaft konfiguriert, Datei keine lesbare PDF, mehr als `LLM_MAX_PAGES` Seiten – außer mit `lenient=true`) |
| `401` | fehlender oder falscher API-Key |
| `413` | Datei größer als `MAX_UPLOAD_MB` |
| `502` | Fehler bei Adobe (z. B. ungültige Credentials, Kontingent erschöpft, beschädigte PDF) – oder, mit LLM, Fehler des Modellanbieters bei **allen** Seiten (z. B. ungültiger API-Key, unbekanntes Modell) |

Jede Antwort trägt einen Header `X-Request-Id`, mit dem sich der Aufruf im Log wiederfinden lässt.

### OCR-Engine: Adobe oder Tesseract

Die Texterkennung samt Positionen kommt wahlweise von **Adobe PDF Services** (Standard, kostenpflichtig bzw. mit Freikontingent) oder von **Tesseract** (lokal im Container, kostenlos). Der Betreiber wählt in der `.env`; der Request ändert daran nichts. Das Feld `type` gilt für beide Engines (siehe unten).

- **`OCR_ENGINE=adobe`** (Standard): wie bisher.
- **`OCR_ENGINE=tesseract`**: Adobe-Zugangsdaten sind nicht nötig. Der Service rendert jede Seite (`TESSERACT_DPI`), Tesseract liefert Textzeilen mit Positionen (Wörter mit großem Abstand, z. B. Spalten und Tabellen, werden getrennte Boxen), daraus entsteht die unsichtbare Textebene auf der **unveränderten** Original-PDF. Bereits vorhandene Textebenen der Seiten werden ersetzt.
- **`type=deskew` bei Tesseract:** Der Service schätzt je Seite die Schräglage (Projektionsprofil, bis `TESSERACT_DESKEW_MAX` Grad, Standard 30; Tinte wird über den Kontrast zur Umgebung erkannt, farbiges Papier stört also nicht) und gibt die Seite **begradigt** aus, wie bei Adobe: Das Bild wird gedreht, die Ränder werden weiß aufgefüllt, die Seitengröße bleibt, die Textebene liegt waagerecht. Die begradigte Seite wird als JPEG eingebettet (`TESSERACT_JPEG_QUALITY`, Standard 85) und ist dadurch meist größer als ein bilevel-Scan. Mit `TESSERACT_DESKEW_OUTPUT=false` wird das Bild nur für die Erkennung begradigt: Das Originalbild bleibt dann unverändert, und die unsichtbare Textebene folgt der Schräglage. Seiten ohne erkennbare Schräglage bleiben in beiden Fällen unberührt. Passt der gedrehte Inhalt nicht mehr auf die Seite (z. B. eine vollgeschriebene, stark schiefe Seite), wird die Seite entsprechend größer, damit nichts abgeschnitten wird. Gemessen an einer um 6° gedrehten Seite: 9 statt 2 von 10 Testwörtern erkannt (3° verkraftet Tesseract auch ohne).
- **`OCR_FALLBACK=tesseract`** (mit `OCR_ENGINE=adobe`): Meldet Adobe ein erschöpftes Kontingent, läuft die Anfrage automatisch mit Tesseract. Andere Adobe-Fehler (z. B. falsche Credentials) fallen **nicht** zurück. Fehlen die Adobe-Zugangsdaten ganz, laufen alle Anfragen über Tesseract.

Die Antwort trägt `X-OCR-Engine: adobe|tesseract`; nach einem Ausweichen zusätzlich `X-OCR-Engine-Fallback: adobe-quota`.

**Qualität:** Rohes Tesseract liest schlechte Scans deutlich schlechter als Adobe. Das gleicht die [LLM-Nachbearbeitung](#llm-nachbearbeitung) aus: Tesseract liefert die Zeilenrahmen (die Layout-Analyse funktioniert auch bei verwaschenem Text), das Modell liest jede Zeile am Seitenbild nach. An einem verwaschenen Kassenbon behob das Modell so alle bekannten Lesefehler (8 von 8, dreimal hintereinander). Ohne `llm=true` ist die Textebene nur so gut wie Tesseract selbst. Grenzen: gedrehte Seiten (90°/180°) werden von Tesseract nicht automatisch aufgerichtet, und Zeilen, die Tesseract gar nicht findet, kann das Modell nicht ergänzen (Ausweichfall der Transkription bei unbrauchbarer Textebene bleibt).

Das Docker-Image enthält Tesseract mit deutschen und englischen Sprachdaten. Weitere Sprachen: im `Dockerfile` das Paket `tesseract-ocr-data-<code>` ergänzen. Die Kommandozeile (`npm run ocr`) nutzt weiterhin nur Adobe.

### LLM-Nachbearbeitung

Adobe liefert die Textboxen, die Texterkennung ist auf schlechten Scans aber oft mäßig. Mit `llm=true` wird das Ergebnis zusätzlich von einem Vision-LLM korrigiert (Anbieter und Modell stehen in der `.env`):

1. Adobe erzeugt wie gewohnt das OCR-PDF.
2. Pro Seite wird das Seitenbild gerendert (lange Kante `LLM_IMAGE_MAX_PX`) und zusammen mit den Textboxen von Adobe (ID, Position, erkannter Text) an das Modell geschickt.
3. Das Modell antwortet nur mit den **Korrekturen** je Box (`id → richtiger Text`); ein leerer Text verwirft eine Box, die nur Rauschen erfasst hat oder deren Inhalt in eine Nachbarbox gewandert ist. Adobe schneidet Wörter oft mitten durch („Be“ + „i Fragen“, „F“ + „ür“, „20,“ + „21“); das Modell darf deshalb Zeichen zwischen **unmittelbar benachbarten Boxen einer Zeile** verschieben, sodass jedes Wort ganz in einer Box liegt (Suche und Kopieren funktionieren dann). Beide Anbieter antworten im strukturierten JSON-Modus.
4. Die Textebene von Adobe wird durch eine neue unsichtbare Ebene ersetzt: dieselben Boxen an denselben Positionen und mit denselben Breiten, aber mit dem korrigierten Text (eingebettete Schrift DejaVu Sans, Unicode-fähig; leere Boxen entfallen). Seitenbild und alle übrigen PDF-Inhalte bleiben unverändert.

Das Modell liefert also nur **Text**, die **Positionen** kommen von Adobe – dadurch stimmen Markieren, Kopieren und Suchtreffer weiterhin mit dem Scan überein.

```bash
curl -X POST http://localhost:3000/api/ocr \
  -H "X-API-Key: <key>" \
  -F file=@scan.pdf \
  -F llm=true \
  -o scan.ocr.pdf
```

Konfiguration in der `.env`, zum Beispiel:

```
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5
ANTHROPIC_API_KEY=…
```

Bei `anthropic` ist `claude-opus-5` das Standardmodell, wenn `LLM_MODEL` fehlt; bei `openai` muss `LLM_MODEL` gesetzt werden, weil sich die Modellnamen dort häufig ändern. Das Modell muss Bildeingaben und strukturierte Ausgaben unterstützen. Ist `LLM_PROVIDER` leer oder fehlen Key bzw. Modell, meldet der Service beim Start einen Fehler im Log, läuft aber ohne LLM weiter; `llm=true` liefert dann `400` mit dem Grund. Die aktive Konfiguration zeigt `GET /api/llm`. Für einen Modellwechsel `LLM_MODEL` ändern und `docker compose up -d` ausführen.

#### Ausweichfall: unbrauchbare Adobe-Textebene

Bei stark verblassten oder verrauschten Scans (Kassenbons, Thermopapier) liest Adobe oft nur Rauschen als „Text“; die eigentliche Schrift hat dann gar keine Boxen, und Korrekturen einzelner Boxen helfen nicht. Der Service erkennt das (weniger als 50 % der erkannten Zeichen gehören zu plausiblen Wörtern, bei mindestens 40 Zeichen; normale Seiten liegen bei 85–99 %) und lässt das Modell die Seite stattdessen **komplett zeilenweise transkribieren**. Dasselbe passiert bei Seiten ohne jede Textebene, die sichtbaren Inhalt haben. Das Bild wird dafür zuerst aufbereitet (Rauschen dämpfen, Papierhintergrund herausrechnen). Die Textebene der Seite wird durch die Zeilen ersetzt.

Das Modell darf dabei **nichts raten**, denn der Text landet in einem durchsuchbaren Archiv:

- Jede Zeile trägt ein Flag `certain`; nur **sichere** Zeilen werden geschrieben.
- Das Modell bewertet die Lesbarkeit der Seite (`good`, `partial`, `poor`). Bei `poor` wird gar keine Zeile geschrieben (Adobes Rauschen wird trotzdem entfernt), die Metadaten werden auf `confidence: low` gesetzt und das Datum verworfen (Ablage in `_Pruefen` mit dem Scandatum); bei `partial` gilt höchstens `medium`.
- Die Positionen der Zeilen sind **nur grob** (das Modell schätzt sie; erfahrungsgemäß bis zu etwa 10 % der Seite daneben). Suchen funktioniert, das Markieren im Viewer trifft die Zeile nur ungefähr.

**Zusätzliche Antwort-Header** bei LLM-Nachbearbeitung:

| Header | Inhalt |
|---|---|
| `X-OCR-LLM` | verwendetes Modell, z. B. `anthropic/claude-sonnet-5` |
| `X-OCR-LLM-Pages` | `<Seiten mit Änderungen>/<Seiten gesamt>` |
| `X-OCR-LLM-Corrections` | Anzahl geänderter (oder verworfener) Textboxen |
| `X-OCR-LLM-Failed` | Seiten, bei denen der Modellaufruf fehlgeschlagen ist |
| `X-OCR-LLM-Transcribed` | Seiten, deren Textebene im Ausweichfall komplett neu transkribiert wurde (nur wenn > 0) |
| `X-OCR-LLM-Skipped` | `max-pages`: das Dokument war länger als `LLM_MAX_PAGES`, es wurde nur per Adobe (und ggf. Metadaten) verarbeitet |

**Verhalten bei Fehlern und Grenzfällen**

- Schlägt der Modellaufruf nur bei einzelnen Seiten fehl, behalten diese Seiten den Adobe-Text; `X-OCR-LLM-Failed` und das Log (`llm seite fehlgeschlagen`) zeigen das an. Schlägt er bei **allen** Seiten fehl, antwortet der Service mit `502`.
- Seiten ohne Änderung behalten ihre ursprüngliche Adobe-Textebene unangetastet.
- Seiten, auf denen Adobe **keine** Textboxen gefunden hat, aber sichtbaren Inhalt (leere Rückseiten werden erkannt und übersprungen), sowie Seiten mit **unbrauchbarer** Textebene übernimmt der [Ausweichfall](#ausweichfall-unbrauchbare-adobe-textebene).
- Die Prüfung von Dateiformat und Seitenzahl (`LLM_MAX_PAGES`) erfolgt vor dem Adobe-Aufruf, damit bei ungeeigneten Dateien keine Kosten entstehen. Bei `lenient=true` wird ein zu langes Dokument nicht abgelehnt, sondern ohne LLM-Korrektur verarbeitet (Header `X-OCR-LLM-Skipped: max-pages`).
- Der Aufruf ist synchron; mit LLM dauert er deutlich länger (Client-Timeouts entsprechend setzen).

**Kosten und Datenschutz:** Pro Seite entsteht mindestens ein Modellaufruf (bei mehr als `LLM_MAX_BOXES_PER_CALL` Boxen mehrere; bei vielen Korrekturen bis zu `LLM_MAX_PASSES` Durchgänge), abgerechnet vom jeweiligen Anbieter. Die **Seitenbilder** werden zusätzlich an Anthropic bzw. OpenAI übertragen – bei vertraulichen Unterlagen bedenken.

**Stand der Erprobung:** Automatisch geprüft (`npm run smoke`, auch im Alpine-Container) ist der Ablauf mit synthetischem Adobe-PDF und Stub-Modell, dazu die Request-Formen beider SDKs gegen einen lokalen Fake-Server. Ein **echter Lauf** (Adobe + `claude-sonnet-5`) an einem synthetischen, verrauschten und leicht schrägen Rechnungsbrief ergab, gemessen gegen den bekannten Originaltext: Wortfehlerrate 13,2 % nur mit Adobe, 11,0 % mit einer ersten Prompt-Fassung (Boxen durften nicht verändert werden), ca. 1 % mit dem heutigen Prompt (drei Läufe hintereinander; der Rest ist ein Leerzeichen in Adobes Text). Dauer mit LLM etwa 25 s pro Seite. Beobachtet wurden dabei: bei 2000 px Bildkante blieb Kleingedrucktes (6,5 pt) unkorrigiert, bei 2576 px nicht mehr (daher der Standard); das Modell überging in manchen Läufen die Fußzeile, bis der Prompt ausdrücklich verlangte, *alle* Boxen zu prüfen; einmal wurde „Be“ fälschlich zu „Bitte“ (Halluzination), was sich nicht wiederholte. **Nicht getestet** sind OpenAI-Modelle, schlechte reale Scans (nur eine saubere, synthetische Vorlage), mehrseitige Dokumente mit LLM und Handschrift. Auch bei Läufen mit identischen Einstellungen schwankt das Ergebnis leicht – für wichtige Dokumente stichprobenartig prüfen. Stellschrauben sind `LLM_IMAGE_MAX_PX`, `LLM_MAX_BOXES_PER_CALL` und das Modell.

**Weitere Erprobung** (sieben synthetische, verrauschte Scans, die Kette bis ins Ziel, gegen den bekannten Originaltext gemessen): Ordner, Datum und Dateiname stimmten bei allen sechs lesbaren Dokumenten (Rechnung, Privatbrief mit „3. September 2026“, Kontoauszug, Dokument ohne Datum mit Scandatum als Ersatz, dreiseitiger Vertrag, Bescheid mit dem Empfänger als größtem Text); die Wortfehlerrate sank von 6,8 % (nur Adobe) auf 1,9 %. Ein extrem verblasster, verrauschter Kassenbon war für Adobe reines Rauschen; ein erster Ausweichfall ohne Sicherheitsflags ließ das Modell **Text erfinden** (Straße, Datum, Artikelnamen) – deshalb die oben beschriebenen Schranken. Damit landet dieser Bon ohne Text und ohne Datum in `_Pruefen`; ein mäßig verblasster, lesbarer Bon wurde dagegen vollständig und richtig transkribiert (13 von 13 Zeilen, alle als sicher markiert). Restfehler der Korrektur: einzelne zerschnittene Wörter werden nicht immer repariert, einzelne falsche Zeichen bleiben stehen.

### Dokumentdaten und Ablagevorschlag

Mit `meta=true` liest das LLM von der **ersten Seite** (Bild plus bereits korrigierter Text) vier Angaben: das **Dokumentdatum**, den **Korrespondenten** (Absender, nicht Empfänger – dafür `OWN_NAMES`), einen **Kurzinhalt** in höchstens fünf Wörtern und einen **Bezug** – die Kennung, die das Dokument einem konkreten Vertrag oder Objekt zuordnet (Vertrags-, Versicherungs-, Depot-, Kundennummer, Kfz-Kennzeichen, Fondsname/ISIN; höchstens 30 Zeichen, exakt wie gedruckt, nie geraten, sonst leer). Daraus baut der Service einen Ablagepfad. `meta` funktioniert mit und ohne `llm=true`; ohne Korrektur wird der Adobe-Text verwendet.

Der Pfad steht im Antwort-Header `X-OCR-Meta` (Base64 von UTF-8-JSON):

```json
{"date":"2026-09-18","dateSource":"document","correspondent":"Telekom","summary":"Rechnung-Mobilfunk","reference":"1234567","confidence":"high","path":"Telekom/2026-09-18_Telekom_Rechnung-Mobilfunk_1234567.pdf"}
```

| Fall | Pfad |
|---|---|
| Normal | `<Korrespondent>/<Datum>_<Korrespondent>_<Kurzinhalt>[_<Bezug>].pdf` |
| Kein Korrespondent erkannt | `_Unbekannt/<Datum>_<Kurzinhalt>[_<Bezug>].pdf` |
| Modell unsicher (`confidence: low`) | `_Pruefen/<Datum>_<Korrespondent>_<Kurzinhalt>[_<Bezug>].pdf` |
| Datum nicht lesbar | `scan_date` (`dateSource: "scan"`), sonst `ohne-Datum` |
| Kein Kurzinhalt | `Scan` |

Der Bezug entfällt, wenn keiner erkennbar ist, und bei schlecht lesbaren Seiten (Ausweichfall) ganz. Namen werden für SMB/Windows bereinigt (keine ` / : * ? " < > |`, keine Punkte oder Leerzeichen am Ende, keine reservierten Namen wie `CON`, begrenzte Länge, Umlaute bleiben); der Pfad hat immer genau **eine** Ordnerebene. Datum und Kurzinhalt werden zusätzlich als Titel, Autor und Erstellungsdatum in die PDF-Eigenschaften geschrieben.

Schlägt nur das Lesen der Dokumentdaten fehl, kommt das PDF trotzdem, aber **ohne** `X-OCR-Meta`; der Aufrufer muss das als „Metadaten fehlen“ behandeln. Beispielaufruf (so ruft ihn der smb1-proxy auf):

```bash
curl -X POST http://localhost:3000/api/ocr   -H "X-API-Key: <key>"   -F file=@scan.pdf   -F llm=true -F meta=true -F lenient=true -F scan_date=2026-09-19   -D headers.txt -o scan.ocr.pdf
```

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
- OCR-Aufrufe erzeugen `ocr start`, `ocr adobe fertig` und `ocr ausgeliefert` bzw. bei Fehlern `ocr fehlgeschlagen` (mit Stacktrace); mit LLM kommen `llm fertig` (Seiten, Korrekturen, Dauer) und `llm seite fehlgeschlagen` hinzu, auf `debug` außerdem je Seite `llm seite fertig`. Fehlgeschlagene Authentifizierung und abgelehnte Uploads sind `warn`.
- Statische Dateien und `/health` erscheinen nur auf `debug`, damit der Docker-Healthcheck das Log nicht füllt.
- Dateiinhalte und API-Keys werden nie geloggt.
- Meldungen des Adobe-SDK erscheinen mit Präfix `sdk:` im selben Format (Info-Meldungen nur auf `debug`). Nur die einmalige SDK-Zeile „No logging configuration…“ beim Start lässt sich nicht unterdrücken.

## Entwicklung

```bash
npm run serve       # Service lokal mit tsx (liest .env)
npm run build       # TypeScript nach dist/ kompilieren
npm start           # kompilierten Service starten
npm run typecheck   # Typprüfung
npm run smoke       # Smoke-Test der LLM-Nachbearbeitung mit synthetischem PDF und Stub-Modell (ohne Zugangsdaten)
```

Aufbau:

```
src/server.ts        Express-API: /api/ocr, /api/languages, /api/llm, /health, Request-Logging, API-Key
src/ocr.ts           Adobe-Anbindung: Upload → OCR-Job → Download (ocrStream, ocrPdf)
src/options.ts       Sprach-/Typ-Parsing, gemeinsam für CLI und API
src/refine.ts        LLM-Nachbearbeitung: Seiten rendern, Boxen korrigieren lassen, Dokumentdaten lesen, PDF neu schreiben
src/meta.ts          Ablagepfad aus Dokumentdaten (Bereinigung, Datumsprüfung), PDF-Eigenschaften
src/llm/             Anbieter-Anbindung (anthropic.ts, openai.ts), Prompt/Schema, Konfiguration aus der .env
src/pdf/             pages.ts (Seitenbild + Textboxen via pdf.js), textlayer.ts (alte Textebene entfernen, neue schreiben)
scripts/smoke-refine.ts  Smoke-Test (npm run smoke)
src/index.ts         Kommandozeile
src/logger.ts        Logger (stdout/stderr, LOG_LEVEL / LOG_FORMAT)
src/sdk-logging.ts   leitet die Log-Ausgabe des Adobe-SDK in den Logger um
public/index.html    Testseite (pdf.js wird aus node_modules unter /vendor/pdfjs ausgeliefert)
Dockerfile, docker-compose.yml
```

## Hinweise

- **Kosten/Kontingent:** Jeder OCR-Aufruf verbraucht Adobe-Transaktionen (Kontingent laut Adobe-Konto). Das CLI überspringt vorhandene Ausgaben; der Service verarbeitet jeden Aufruf neu.
- **Datenschutz:** Die Dokumente werden zur Verarbeitung an Adobe übertragen – bei LLM-Nachbearbeitung zusätzlich die Seitenbilder an Anthropic bzw. OpenAI. Bei vertraulichen Unterlagen bedenken. Der Service selbst speichert nichts dauerhaft; hochgeladene Dateien liegen nur für die Dauer des Aufrufs im temporären Verzeichnis.
- **Absicherung:** Der Service bringt kein TLS und keine Benutzerverwaltung mit. Für den Zugriff über ein Netzwerk einen `API_KEY` setzen und ihn hinter einem Reverse-Proxy mit HTTPS betreiben.

## Lizenz

[MIT](LICENSE) © 2026 Thomas Blankschein. Die Nutzung der Adobe PDF Services API unterliegt den Bedingungen von Adobe.
