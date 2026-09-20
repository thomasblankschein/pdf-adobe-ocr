import OpenAI from "openai";
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

export function createOpenAiClient(model: string, apiKey: string, timeoutMs: number): LlmClient {
  const client = new OpenAI({ apiKey, timeout: timeoutMs });

  /** Ein Aufruf mit Bild + Prompt; liefert den Antworttext (JSON). */
  async function ask(image: PageImage, prompt: string, schema: object, schemaName: string): Promise<string> {
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 16000,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema: schema as never },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${image.jpeg.toString("base64")}`, detail: "high" },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    const choice = response.choices[0];
    if (choice?.message.refusal) throw new Error(`Das Modell hat die Anfrage abgelehnt: ${choice.message.refusal}`);
    if (choice?.finish_reason === "length") throw new Error("Antwort des Modells wurde abgeschnitten (max_completion_tokens).");
    return choice?.message.content ?? "";
  }

  return {
    label: `openai/${model}`,
    async correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]> {
      const text = await ask(image, buildPrompt(boxes), RESPONSE_SCHEMA, "corrections");
      return parseCorrections(text, new Set(boxes.map((b) => b.id)));
    },
    async transcribe(image: PageImage): Promise<Transcription> {
      return parseTranscription(await ask(image, buildTranscribePrompt(), TRANSCRIBE_SCHEMA, "transcription"));
    },
    async extractMeta(image: PageImage, text: string, ownNames: string[]): Promise<RawMeta> {
      return parseMeta(await ask(image, buildMetaPrompt(text, ownNames), META_SCHEMA, "document_meta"));
    },
  };
}
