import { LIMITS, MODELS } from "../config";
import { synthesisPrompt } from "../prompts/fact-check";
import { parseSynthesis } from "../schemas/fact-check";
import type {
  ApiBindings,
  Evidence,
  FactCheckInput,
  ModelMessage,
  ModerationResult,
  SynthesisResult,
} from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import { HttpError, withTimeout } from "../utils/http";
import type { Logger } from "../utils/logging";
import { ModelOutputError, parseModelJson } from "../utils/model";
import { measureUsage, type UsageRecorder } from "../utils/usage";

const synthesisErrorMessages = {
  missing_binding: "尚未設定 Workers AI。",
  timeout: "綜整模型回應逾時。",
  model_error: "Workers AI 綜整呼叫失敗。",
  invalid_synthesis: "綜整結果不符合 factuality／confidence／verdict 契約。",
} as const;

export async function synthesize(
  input: FactCheckInput,
  moderation: ModerationResult,
  evidence: Evidence[],
  env: ApiBindings,
  usage: UsageRecorder = () => {},
  log: Logger = () => undefined,
): Promise<SynthesisResult> {
  const start = Date.now();
  let reason: keyof typeof synthesisErrorMessages = "missing_binding";
  try {
    if (!env.AI) throw new Error(synthesisErrorMessages.missing_binding);
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
    const messages: ModelMessage[] = [
      { role: "system", content: synthesisPrompt },
      {
        role: "user",
        content: JSON.stringify({ claim: input.text, moderation, evidence: modelEvidence }),
      },
    ];
    reason = "model_error";
    const output = await withTimeout(
      () =>
        ai.run(MODELS.synthesis, {
          messages,
          stream: false,
          temperature: 0,
          max_completion_tokens: 4_096,
          // temperature 0 曾出現重複迴圈燒滿輸出上限；此模型不支援 repetition_penalty，
          // 改以 frequency penalty 抑制。取值需低到不懲罰 JSON 的合法重複 token。
          frequency_penalty: 0.5,
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    usage(measureUsage("synthesis", MODELS.synthesis, output, JSON.stringify(messages)));
    reason = "invalid_synthesis";
    return parseSynthesis(parseModelJson(output), evidence.length > 0);
  } catch (error) {
    const isTimeout = error instanceof HttpError && error.reason === "timeout";
    log({
      event: "synthesis_error",
      stage: "synthesis",
      model: MODELS.synthesis,
      reason: error instanceof ModelOutputError ? error.reason : isTimeout ? "timeout" : reason,
      finish_reason: error instanceof ModelOutputError ? error.finishReason : null,
      // 訊息只取自本機固定字串，不記錄模型內容或使用者原文。
      message:
        error instanceof ModelOutputError
          ? error.message
          : synthesisErrorMessages[isTimeout ? "timeout" : reason],
      latency_ms: Date.now() - start,
    });
    throw upstreamError("synthesis");
  }
}
