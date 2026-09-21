import type { Correction, RawMeta, TextBox, Transcription } from "./types";

export function buildPrompt(boxes: TextBox[]): string {
  const list = boxes
    .map((b) => `${b.id}\t${b.x},${b.y},${b.w},${b.h}\t${JSON.stringify(b.text)}`)
    .join("\n");
  return `You are correcting the output of an OCR engine. The image is one scanned page. The OCR engine found the text boxes listed below. Each line has: id, position, recognised text (as a JSON string). The position is x,y,w,h in per mille of the page width/height with the origin at the top left (x,y = top-left corner of the box). The recognised text is often wrong: misread characters, broken words, garbage from noise, stamps or stains.

Work through ALL boxes, from the first id to the last. Small print in footers, headers, margins and tables needs the same care as the main text, and the last boxes of the page are as important as the first ones.

For every box, look at the matching region of the image and decide what is really printed there.
- Return an entry only for boxes whose text has to change. Leave out boxes that are already correct.
- Give the text exactly as printed: same language, spelling, punctuation, numbers and casing. Do not translate, normalise or comment.
- If a box contains no readable text (noise, stains, lines, borders), return an empty string for it.
- The OCR engine often cuts a word or number in the middle and puts the pieces into neighbouring boxes (for example "Be" + "i Fragen", "F" + "ür", "I" + "hr" + "e Stadtwerke", "20," + "21", "m" + "3"). Repair this: move the characters between such boxes so that every word and every number lies completely in ONE box, namely the box where most of it is printed. Return every box whose text changes because of that, and return an empty string for a box that ends up with nothing (for example "Be" -> "Bei" and "i Fragen" -> "Fragen"; "20," -> "20,21" and "21" -> ""). Only move characters between boxes that are directly next to each other on the same line, in reading order; never move text across lines or over larger gaps.
- Never add boxes or reorder them. Use only the ids given below.

Answer with JSON of the form {"corrections":[{"id":12,"text":"..."}]} and nothing else.

Boxes (id <TAB> x,y,w,h <TAB> text):
${list}`;
}

/** JSON-Schema für die strukturierte Antwort (von beiden Providern im Strict-Modus nutzbar). */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["corrections"],
  additionalProperties: false,
} as const;

/** Liest die Antwort tolerant (auch mit Text/Codeblock drumherum) und verwirft unbekannte IDs. */
export function parseCorrections(raw: string, validIds: Set<number>): Correction[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Antwort des Modells enthält kein JSON.");
    data = JSON.parse(raw.slice(start, end + 1));
  }
  const list = (data as { corrections?: unknown })?.corrections;
  if (!Array.isArray(list)) throw new Error('Antwort des Modells hat kein Feld "corrections".');
  const byId = new Map<number, string>();
  for (const c of list) {
    const id = (c as Correction)?.id;
    const text = (c as Correction)?.text;
    if (Number.isInteger(id) && typeof text === "string" && validIds.has(id)) byId.set(id, text);
  }
  return [...byId].map(([id, text]) => ({ id, text }));
}

// ---------------------------------------------------------------------------
// Dokumentdaten (Datum, Absender, Kurzinhalt) von der ersten Seite
// ---------------------------------------------------------------------------

const META_TEXT_MAX_CHARS = 6000;

export function buildMetaPrompt(text: string, ownNames: string[]): string {
  const own = ownNames.length > 0 ? ownNames.map((n) => `- ${n}`).join("\n") : "- (unknown)";
  const ocr = text.trim().slice(0, META_TEXT_MAX_CHARS) || "(no text recognised)";
  return `You are reading the first page of a scanned letter or document (image attached). The OCR text below may contain errors; where it differs from the image, trust the image.

Extract these fields:
- date: the date of the document itself (letter date, invoice date, date of issue) as YYYY-MM-DD. Not a due date, delivery date, period covered or birth date. If several dates appear, prefer the date of issue near the top. German dates are day.month.year. Use an empty string if there is no date or it is ambiguous.
- correspondent: the SENDER, i.e. the organisation or person who wrote or issued the document, as a short common name without legal form, street or city (for example "Telekom", not "Telekom Deutschland GmbH, Landgrabenweg 151"). Never return the recipient. The recipient (the owner of this mail) is known under:
${own}
  Use an empty string if the sender cannot be determined.
- summary: what the document is about, in German, at most five words (for example "Rechnung Mobilfunk", "Kündigung Mietvertrag", "Kontoauszug"). No names or dates unless essential.
- reference: the ONE identifier that ties the document to a specific contract, account or object, copied exactly as printed and without its label. Prefer, in this order: contract number, policy or insurance number, deposit/securities account or account number, customer number; for vehicle documents the licence plate; for fund or securities statements the fund name or ISIN. At most 30 characters. It must be clearly printed and readable: never guess, complete or combine numbers. Use an empty string if the document has no such identifier or you are not sure of every character.
- confidence: "high" if date and sender are clearly readable, "medium" if one of them is uncertain, "low" if you had to guess or the page is barely legible.

Answer with JSON only: {"date":"","correspondent":"","summary":"","reference":"","confidence":"high"}

OCR text of the page:
${ocr}`;
}

export const META_SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string" },
    correspondent: { type: "string" },
    summary: { type: "string" },
    reference: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["date", "correspondent", "summary", "reference", "confidence"],
  additionalProperties: false,
} as const;

export function parseMeta(raw: string): RawMeta {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Antwort des Modells enthält kein JSON.");
    data = JSON.parse(raw.slice(start, end + 1));
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const confidence = data?.confidence === "high" || data?.confidence === "medium" || data?.confidence === "low" ? data.confidence : "low";
  return { date: str(data?.date), correspondent: str(data?.correspondent), summary: str(data?.summary), reference: str(data?.reference), confidence };
}

// ---------------------------------------------------------------------------
// Ausweichfall: ganze Seite transkribieren, wenn Adobes Textebene unbrauchbar ist
// ---------------------------------------------------------------------------

export function buildTranscribePrompt(): string {
  return `The image is one scanned page (for example a faded or noisy receipt) whose automatic OCR failed completely. Transcribe ALL text that is printed on the page, line by line, in reading order.

For every line give:
- text: the line exactly as printed - same language, spelling, punctuation and numbers. Do not correct, translate or summarise. Keep a table row as one line with the columns separated by spaces.
- x: where the line starts horizontally, in per mille of the page width (0 = left edge, 1000 = right edge).
- y: where the top of the line is vertically, in per mille of the page height (0 = top edge, 1000 = bottom edge).
The positions only need to be roughly right (a few per cent).

Include headers, footers, small print and stamps. Skip noise, stains and borders.

Be honest about legibility. A wrong line is much worse than a missing line, because the text ends up in a searchable archive:
- Never guess and never fill in plausible text (names, addresses, dates, prices, item names). If you cannot read a line, leave it out.
- Set "certain" to true only if every character of the line is clearly legible. Set it to false if you had to guess any part of it.
- Set "legibility" for the whole page: "good" (almost everything is clearly readable), "partial" (some lines are readable, others are not) or "poor" (mostly illegible). If the page contains no readable text, return "poor" and an empty list.

Answer with JSON only: {"legibility":"good","lines":[{"text":"...","x":0,"y":0,"certain":true}]}`;
}

export const TRANSCRIBE_SCHEMA = {
  type: "object",
  properties: {
    legibility: { type: "string", enum: ["good", "partial", "poor"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          x: { type: "integer" },
          y: { type: "integer" },
          certain: { type: "boolean" },
        },
        required: ["text", "x", "y", "certain"],
        additionalProperties: false,
      },
    },
  },
  required: ["legibility", "lines"],
  additionalProperties: false,
} as const;

export function parseTranscription(raw: string): Transcription {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Antwort des Modells enthält kein JSON.");
    data = JSON.parse(raw.slice(start, end + 1));
  }
  if (!Array.isArray(data?.lines)) throw new Error('Antwort des Modells hat kein Feld "lines".');
  const clamp = (v: unknown) => Math.min(1000, Math.max(0, Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0));
  const lines: Transcription["lines"] = [];
  for (const l of data.lines) {
    const text = typeof l?.text === "string" ? l.text.replace(/\s+/g, " ").trim() : "";
    // fehlt die Angabe, gilt die Zeile als unsicher
    if (text) lines.push({ text, x: clamp(l.x), y: clamp(l.y), certain: l?.certain === true });
  }
  const legibility = data?.legibility === "good" || data?.legibility === "partial" ? data.legibility : "poor";
  return { legibility, lines: lines.sort((a, b) => a.y - b.y) };
}
