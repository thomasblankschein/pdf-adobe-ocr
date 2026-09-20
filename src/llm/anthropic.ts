import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, parseCorrections, RESPONSE_SCHEMA } from "./prompt";
import type { Correction, LlmClient, PageImage, TextBox } from "./types";

// Modelle, die den effort-Parameter kennen (er führt bei älteren Modellen wie Haiku 4.5 zu Fehlern)
const SUPPORTS_EFFORT = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/;

export function createAnthropicClient(model: string, apiKey: string, timeoutMs: number): LlmClient {
  const client = new Anthropic({ apiKey, timeout: timeoutMs });

  async function request(image: PageImage, prompt: string, structured: boolean) {
    return client.messages.create({
      model,
      max_tokens: 16000,
      output_config: {
        ...(SUPPORTS_EFFORT.test(model) ? { effort: "low" as const } : {}),
        ...(structured ? { format: { type: "json_schema" as const, schema: RESPONSE_SCHEMA as never } } : {}),
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

  return {
    label: `anthropic/${model}`,
    async correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]> {
      const prompt = buildPrompt(boxes);
      let response;
      try {
        response = await request(image, prompt, true);
      } catch (err) {
        // Modelle ohne Structured Outputs: einmal ohne Schema erneut versuchen (der Prompt verlangt JSON)
        if (err instanceof Anthropic.BadRequestError && /output_config|structured|format/i.test(err.message)) {
          response = await request(image, prompt, false);
        } else {
          throw err;
        }
      }
      if (response.stop_reason === "refusal") throw new Error("Das Modell hat die Anfrage abgelehnt (refusal).");
      if (response.stop_reason === "max_tokens") throw new Error("Antwort des Modells wurde abgeschnitten (max_tokens).");
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return parseCorrections(text, new Set(boxes.map((b) => b.id)));
    },
  };
}
