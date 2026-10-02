import { LIMITS } from "../config";
import type { FactCheckInput } from "../types/fact-check";
import { ApiError } from "../utils/errors";
import { validatePublicUrl } from "../utils/url";
import { record, string } from "../utils/validation";

export function parseInput(value: unknown): FactCheckInput {
  try {
    const input = record(value);
    if (typeof input.text !== "string") throw new Error("文字格式不正確。");
    const text = input.text.trim();
    if (!text || [...text].length > LIMITS.text) throw new Error("文字為空或過長。");
    let url: string | undefined;
    if (input.url !== undefined) url = validatePublicUrl(string(input.url, LIMITS.url)).href;
    return { text, ...(url ? { url } : {}) };
  } catch {
    throw new ApiError(
      "INVALID_INPUT",
      "text 必填且不得超過 10,000 字；url 選填且須為公開 HTTP／HTTPS 網址。",
      400,
    );
  }
}
