import { OCRSupportedLocale, OCRSupportedType } from "@adobe/pdfservices-node-sdk";

export const DEFAULT_LANG = "de-DE";
export const DEFAULT_TYPE = "exact";

export function parseLocale(value: string): OCRSupportedLocale {
  const locale = Object.values(OCRSupportedLocale).find((l) => l === value);
  if (!locale) throw new Error(`Unbekannte Sprache "${value}".`);
  return locale;
}

export function parseType(value: string): OCRSupportedType {
  if (value === "exact") return OCRSupportedType.SEARCHABLE_IMAGE_EXACT;
  if (value === "deskew") return OCRSupportedType.SEARCHABLE_IMAGE;
  throw new Error(`Unbekannter Typ "${value}" (exact | deskew).`);
}

export function supportedLocales(): string[] {
  return Object.values(OCRSupportedLocale);
}
