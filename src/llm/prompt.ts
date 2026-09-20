import type { Correction, TextBox } from "./types";

export function buildPrompt(boxes: TextBox[]): string {
  const list = boxes
    .map((b) => `${b.id}\t${b.x},${b.y},${b.w},${b.h}\t${JSON.stringify(b.text)}`)
    .join("\n");
  return `You are correcting the output of an OCR engine. The image is one scanned page. The OCR engine found the text boxes listed below. Each line has: id, position, recognised text (as a JSON string). The position is x,y,w,h in per mille of the page width/height with the origin at the top left (x,y = top-left corner of the box). The recognised text is often wrong: misread characters, broken words, garbage from noise, stamps or stains.

For every box, look at the matching region of the image and decide what is really printed there.
- Return an entry only for boxes whose text has to change. Leave out boxes that are already correct.
- Give the text exactly as printed: same language, spelling, punctuation, numbers and casing. Do not translate, normalise or comment.
- If a box contains no readable text (noise, stains, lines, borders), return an empty string for it.
- Never merge, split, add or reorder boxes. Use only the ids given below.

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
