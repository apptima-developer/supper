import { z } from "zod";

const controlCharacters = /[\u0000-\u001f\u007f]/;

export function containsControlCharacters(value: string): boolean {
  return controlCharacters.test(value);
}

export function safeBoundedTextSchema(label: string, maximum: number) {
  return z.string()
    .trim()
    .min(1, `${label} is required`)
    .max(maximum, `${label} is too long`)
    .refine((value) => !containsControlCharacters(value), `${label} contains control characters`);
}
