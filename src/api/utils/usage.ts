import { BUDGET } from "../config";

export type UsageStage = "moderation" | "relevance" | "synthesis";
export type UsageSample = {
  stage: UsageStage;
  model: string;
  promptTokens: number;
  completionTokens: number;
  // 上游未回報 token 數時以字元估算，記為 true。
  estimated: boolean;
};
export type UsageRecorder = (sample: UsageSample) => void;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BUDGET.charsPerToken);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

// 同時接受 OpenAI 風格的 prompt_tokens／completion_tokens 與 Responses 風格的 input_tokens／output_tokens。
export function readUsage(
  output: unknown,
): { promptTokens: number; completionTokens: number } | null {
  if (!output || typeof output !== "object") return null;
  const usage = (output as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = tokenCount(record.prompt_tokens) ?? tokenCount(record.input_tokens);
  const completionTokens = tokenCount(record.completion_tokens) ?? tokenCount(record.output_tokens);
  if (promptTokens === null || completionTokens === null) return null;
  return { promptTokens, completionTokens };
}

// 讀取上游回報的用量；缺少時以送出的訊息與整份回應長度估算。
export function measureUsage(
  stage: UsageStage,
  model: string,
  output: unknown,
  sentText: string,
): UsageSample {
  const reported = readUsage(output);
  if (reported) return { stage, model, ...reported, estimated: false };
  let responseText = "";
  try {
    responseText = JSON.stringify(output) ?? "";
  } catch {
    responseText = "";
  }
  return {
    stage,
    model,
    promptTokens: estimateTokens(sentText),
    completionTokens: estimateTokens(responseText),
    estimated: true,
  };
}

// 只有 Workers AI 階段消耗 neurons；安全分類由 OpenRouter 計費，記為 0。
export function usageNeurons(stage: UsageStage, promptTokens: number, completionTokens: number) {
  if (stage === "moderation") return 0;
  const rate = BUDGET.neuronsPerMillionTokens[stage];
  return (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000;
}

export type UsageMeter = {
  record: UsageRecorder;
  samples: UsageSample[];
  totalNeurons(): number;
};

export function createUsageMeter(): UsageMeter {
  const samples: UsageSample[] = [];
  return {
    samples,
    record: (sample) => {
      samples.push(sample);
    },
    totalNeurons: () =>
      samples.reduce(
        (sum, item) => sum + usageNeurons(item.stage, item.promptTokens, item.completionTokens),
        0,
      ),
  };
}
