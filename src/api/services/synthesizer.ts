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
import type { Logger, LogValue } from "../utils/logging";
import { ModelOutputError, parseModelJson } from "../utils/model";
import { measureUsage, type UsageRecorder } from "../utils/usage";

const synthesisErrorMessages = {
  missing_binding: "尚未設定 Workers AI。",
  timeout: "綜整模型回應逾時。",
  model_error: "Workers AI 綜整呼叫失敗。",
  invalid_synthesis: "綜整結果不符合 factuality／confidence／verdict 契約。",
} as const;

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function responseMetadata(value: unknown): Record<string, LogValue> {
  const output = optionalRecord(value);
  const choices = Array.isArray(output.choices) ? output.choices : [];
  const choice = optionalRecord(choices[0]);
  const message = optionalRecord(choice.message);
  const usage = optionalRecord(output.usage);
  const finishReason = choice.finish_reason;
  const knownFinishReasons = [
    "stop",
    "length",
    "content_filter",
    "tool_calls",
    "function_call",
    "error",
  ];
  return {
    choices_count: choices.length,
    finish_reason:
      finishReason == null
        ? null
        : typeof finishReason === "string" && knownFinishReasons.includes(finishReason)
          ? finishReason
          : "unknown",
    content_length: typeof message.content === "string" ? message.content.length : null,
    has_reasoning:
      Boolean(message.reasoning) ||
      Boolean(message.reasoning_content) ||
      (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0),
    prompt_tokens: numericMetadata(usage.prompt_tokens),
    completion_tokens: numericMetadata(usage.completion_tokens),
    reasoning_tokens: numericMetadata(
      optionalRecord(usage.completion_tokens_details).reasoning_tokens,
    ),
  };
}

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
    // 一般使用者網址不能單獨支撐主張；白名單機構來源則可在 Cofacts
    // 無資料時作為機構參考證據。白名單只確認來源網域，不代表內容必然正確。
    const hasUsableEvidence = evidence.some(
      (item) =>
        item.source === "cofacts-human" ||
        item.source === "cofacts-ai" ||
        item.reliability === "allowlisted-institution",
    );
    // 平均分配文字預算，保留每筆證據，避免大量回覆擠爆模型 context。
    const textBudget = Math.min(
      LIMITS.evidenceText,
      Math.floor(60_000 / Math.max(evidence.length, 1)),
    );
    const modelEvidence = (hasUsableEvidence ? evidence : []).map((item) => ({
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
          // frequency_penalty: 0.5,
          // Gemma 4 是推理模型；關閉 thinking，避免 token 全耗在 reasoning 而 content 為 null。
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    usage(measureUsage("synthesis", MODELS.synthesis, output, JSON.stringify(messages)));
    log({
      event: "synthesis_response",
      stage: "synthesis",
      model: MODELS.synthesis,
      ...responseMetadata(output),
      latency_ms: Date.now() - start,
    });
    reason = "invalid_synthesis";
    return parseSynthesis(parseModelJson(output), hasUsableEvidence);
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
