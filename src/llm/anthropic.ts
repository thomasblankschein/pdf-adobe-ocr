import Anthropic from "@anthropic-ai/sdk";
import {
  buildMetaPrompt,
  buildPrompt,
  buildTranscribePrompt,
  META_SCHEMA,
  parseCorrections,
  parseMeta,
  parseTranscription,
  RESPONSE_SCHEMA,
  TRANSCRIBE_SCHEMA,
} from "./prompt";
import type { Correction, LlmClient, PageImage, RawMeta, TextBox, Transcription } from "./types";

// Modelle, die den effort-Parameter kennen (er führt bei älteren Modellen wie Haiku 4.5 zu Fehlern)
const SUPPORTS_EFFORT = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/;

export function createAnthropicClient(model: string, apiKey: string, timeoutMs: number): LlmClient {
  const client = new Anthropic({ apiKey, timeout: timeoutMs });

  async function request(image: PageImage, prompt: string, schema: object, structured: boolean) {
    return client.messages.create({
      model,
      max_tokens: 16000,
      output_config: {
        ...(SUPPORTS_EFFORT.test(model) ? { effort: "low" as const } : {}),
        ...(structured ? { format: { type: "json_schema" as const, schema: schema as never } } : {}),
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: image.jpeg.toString("base64") },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
  }

  /** Ein Aufruf mit Bild + Prompt; liefert den Antworttext (JSON). */
  async function ask(image: PageImage, prompt: string, schema: object): Promise<string> {
    let response;
    try {
      response = await request(image, prompt, schema, true);
    } catch (err) {
      // Modelle ohne Structured Outputs: einmal ohne Schema erneut versuchen (der Prompt verlangt JSON)
      if (err instanceof Anthropic.BadRequestError && /output_config|structured|format/i.test(err.message)) {
        response = await request(image, prompt, schema, false);
      } else {
        throw err;
      }
    }
    if (response.stop_reason === "refusal") throw new Error("Das Modell hat die Anfrage abgelehnt (refusal).");
    if (response.stop_reason === "max_tokens") throw new Error("Antwort des Modells wurde abgeschnitten (max_tokens).");
    return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }

  return {
    label: `anthropic/${model}`,
    async correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]> {
      const text = await ask(image, buildPrompt(boxes), RESPONSE_SCHEMA);
      return parseCorrections(text, new Set(boxes.map((b) => b.id)));
    },
    async transcribe(image: PageImage): Promise<Transcription> {
      return parseTranscription(await ask(image, buildTranscribePrompt(), TRANSCRIBE_SCHEMA));
    },
    async extractMeta(image: PageImage, text: string, ownNames: string[]): Promise<RawMeta> {
      return parseMeta(await ask(image, buildMetaPrompt(text, ownNames), META_SCHEMA));
    },
  };
}
