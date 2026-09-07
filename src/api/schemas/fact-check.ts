import { LIMITS } from "../config";
import type { FactCheckInput, ModerationResult, SynthesisResult } from "../types/fact-check";
import { verdicts } from "../types/fact-check";
import { ApiError } from "../utils/errors";
import { validatePublicUrl } from "../utils/url";
import { array, enumValue, optionalText, record, string, unitNumber } from "../utils/validation";

export function parseInput(value: unknown): FactCheckInput {
  try {
    const input = record(value);
    const text = string(input.text, 100_000);
    if ([...text].length > LIMITS.text) throw new Error("文字過長。");
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

export function parseModeration(value: unknown): ModerationResult {
  const data = record(value);
  const categories = array(data.categories);
  if (categories.length > 10) throw new Error("安全分類過多。");
  const reason = optionalText(data.reason);
  if (reason && reason.length > 2_000) throw new Error("安全分類原因過長。");
  return {
    decision: enumValue(data.decision, ["allow", "review", "block"]),
    categories: categories.map((category) => string(category, 100)),
    ...(reason ? { reason } : {}),
  };
}

export function parseSynthesis(value: unknown, hasIndependentEvidence: boolean): SynthesisResult {
  const data = record(value);
  const result: SynthesisResult = {
    verdict: enumValue(data.verdict, verdicts),
    factuality: unitNumber(data.factuality),
    confidence: unitNumber(data.confidence),
    feedback: string(data.feedback, 6_000),
  };
  // 沒有可獨立查核的證據（無 Cofacts 人工／AI 回覆）時是常識判斷，
  // confidence 上限為 0.5；超過就由程式下修，不整筆丟棄。
  // 只有使用者提供網址的情境也算常識判斷，網址文字不作為查核證據。
  if (!hasIndependentEvidence && result.confidence > 0.5) result.confidence = 0.5;
  return result;
}
