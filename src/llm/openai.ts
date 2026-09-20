import OpenAI from "openai";
import { buildPrompt, parseCorrections, RESPONSE_SCHEMA } from "./prompt";
import type { Correction, LlmClient, PageImage, TextBox } from "./types";

export function createOpenAiClient(model: string, apiKey: string, timeoutMs: number): LlmClient {
  const client = new OpenAI({ apiKey, timeout: timeoutMs });

  return {
    label: `openai/${model}`,
    async correct(image: PageImage, boxes: TextBox[]): Promise<Correction[]> {
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: 16000,
        response_format: {
          type: "json_schema",
          json_schema: { name: "corrections", strict: true, schema: RESPONSE_SCHEMA as never },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${image.jpeg.toString("base64")}`, detail: "high" },
              },
              { type: "text", text: buildPrompt(boxes) },
            ],
          },
        ],
      });
      const choice = response.choices[0];
      if (choice?.message.refusal) throw new Error(`Das Modell hat die Anfrage abgelehnt: ${choice.message.refusal}`);
      if (choice?.finish_reason === "length") throw new Error("Antwort des Modells wurde abgeschnitten (max_completion_tokens).");
      return parseCorrections(choice?.message.content ?? "", new Set(boxes.map((b) => b.id)));
    },
  };
}
