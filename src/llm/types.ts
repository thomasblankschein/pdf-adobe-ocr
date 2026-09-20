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

export interface LlmClient {
  /** z. B. "anthropic/claude-opus-5" – für Logs und Response-Header */
  readonly label: string;
  /** Liefert nur die Boxen, deren Text sich ändern soll (leerer Text = Box verwerfen). */
  correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]>;
}
