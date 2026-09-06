import { LIMITS, MODELS } from "../config";
import { communityPolicy } from "../prompts/community-policy";
import { parseModeration } from "../schemas/fact-check";
import type { ApiBindings, ModerationResult } from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import { fetchJson, type Fetcher } from "../utils/http";
import { parseModelJson } from "../utils/model";

export async function moderate(
  text: string,
  env: ApiBindings,
  fetcher: Fetcher = fetch,
): Promise<ModerationResult> {
  try {
    if (!env.OPENROUTER_API_KEY) throw new Error("尚未設定安全分類服務。");
    const output = await fetchJson(
      fetcher,
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODELS.moderation,
          messages: [
            { role: "system", content: communityPolicy },
            { role: "user", content: JSON.stringify({ text }) },
          ],
          stream: false,
          temperature: 0,
          max_tokens: 2_048,
          response_format: { type: "json_object" },
        }),
      },
      LIMITS.modelTimeoutMs,
    );
    return parseModeration(parseModelJson(output));
  } catch {
    throw upstreamError("moderation");
  }
}
