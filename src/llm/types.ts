export type Provider = "anthropic" | "openai";

/** Eine von Adobe gefundene Textbox. Koordinaten in Promille der Seite, Ursprung oben links. */
export interface TextBox {
  id: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface Correction {
  id: number;
  text: string;
}

/** Vom Modell gelesene Dokumentdaten (leerer String = unbekannt). */
export interface RawMeta {
  /** Dokumentdatum als YYYY-MM-DD */
  date: string;
  /** Absender (Kurzname ohne Rechtsform und Adresse) */
  correspondent: string;
  /** Inhalt in höchstens fünf Wörtern */
  summary: string;
  /** Konkreter Bezug (Vertrags-/Versicherungs-/Depotnummer, Kennzeichen, Fonds); leer/fehlt = keiner erkennbar */
  reference?: string;
  confidence: "high" | "medium" | "low";
}

/** Eine vom Modell gelesene Zeile einer Seite (nur für den Ausweichfall); Position grob, in Promille der Seite, Ursprung oben links. */
export interface TranscribedLine {
  text: string;
  /** Anfang der Zeile (links) */
  x: number;
  /** Oberkante der Zeile */
  y: number;
  /** true nur, wenn jedes Zeichen klar lesbar war; false, wenn das Modell etwas raten musste */
  certain: boolean;
}

export interface Transcription {
  /** Wie gut war die Seite insgesamt lesbar? */
  legibility: "good" | "partial" | "poor";
  lines: TranscribedLine[];
}

export interface LlmClient {
  /** z. B. "anthropic/claude-opus-5" – für Logs und Response-Header */
  readonly label: string;
  /** Liefert nur die Boxen, deren Text sich ändern soll (leerer Text = Box verwerfen). */
  correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]>;
  /** Transkribiert die ganze Seite zeilenweise (wenn Adobes Textebene unbrauchbar ist). */
  transcribe(image: PageImage): Promise<Transcription>;
  /** Liest Datum, Absender und Kurzinhalt von der ersten Seite. ownNames = Namen/Adressen des Empfängers. */
  extractMeta(image: PageImage, text: string, ownNames: string[]): Promise<RawMeta>;
}
