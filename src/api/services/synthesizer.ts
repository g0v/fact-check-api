import { LIMITS, MODELS } from "../config";
import { synthesisPrompt } from "../prompts/fact-check";
import { parseSynthesis } from "../schemas/fact-check";
import type {
  ApiBindings,
  Evidence,
  FactCheckInput,
  ModerationResult,
  SynthesisResult,
} from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import { withTimeout } from "../utils/http";
import { parseModelJson } from "../utils/model";

export async function synthesize(
  input: FactCheckInput,
  moderation: ModerationResult,
  evidence: Evidence[],
  env: ApiBindings,
): Promise<SynthesisResult> {
  try {
    if (!env.AI) throw new Error("尚未設定 Workers AI。");
    const ai = env.AI;
    // 平均分配文字預算，保留每筆證據，避免大量回覆擠爆模型 context。
    const textBudget = Math.min(
      LIMITS.evidenceText,
      Math.floor(60_000 / Math.max(evidence.length, 1)),
    );
    const modelEvidence = evidence.map((item) => ({
      ...item,
      evidenceText: item.evidenceText.slice(0, textBudget),
      articleText: item.articleText?.slice(0, Math.floor(textBudget / 2)),
      referenceText: item.referenceText?.slice(0, Math.floor(textBudget / 2)),
      sourceUrls: item.sourceUrls?.slice(0, 3),
      articleReferences: item.articleReferences?.slice(0, 3),
    }));
    const output = await withTimeout(
      () =>
        ai.run(MODELS.synthesis, {
          messages: [
            { role: "system", content: synthesisPrompt },
            {
              role: "user",
              content: JSON.stringify({ claim: input.text, moderation, evidence: modelEvidence }),
            },
          ],
          stream: false,
          temperature: 0,
          max_completion_tokens: 4_096,
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    return parseSynthesis(parseModelJson(output), evidence.length > 0);
  } catch {
    throw upstreamError("synthesis");
  }
}
